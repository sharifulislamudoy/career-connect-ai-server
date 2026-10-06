// routes/messages.js
const express = require("express");
const { ObjectId } = require("mongodb");

module.exports = (
  usersCollection,
  connectionsCollection,
  messagesCollection,
  io,
  notificationsCollection,
) => {
  const router = express.Router();
  // Check if collections are available
  router.use((req, res, next) => {
    if (!messagesCollection || !usersCollection || !connectionsCollection) {
      return res.status(503).json({
        success: false,
        message: "Database not initialized. Please try again later.",
      });
    }
    next();
  });

  // Bind every legacy caller-supplied identity to the verified session.
  router.use((req, res, next) => {
    const uid = req.identity?.uid;
    if (!uid)
      return res
        .status(401)
        .json({ success: false, message: "Sign in to access messages." });
    if (
      (req.query.userId && req.query.userId !== uid) ||
      (req.body?.userId && req.body.userId !== uid) ||
      (req.body?.senderId && req.body.senderId !== uid)
    ) {
      return res
        .status(403)
        .json({
          success: false,
          message: "You can only access your own messages.",
        });
    }
    if (req.method === "POST") {
      req.body = req.body || {};
      req.body.userId = uid;
      if (req.path === "/send") req.body.senderId = uid;
    }
    next();
  });
  router.param("userId", (req, res, next, uid) =>
    uid === req.identity.uid
      ? next()
      : res.status(403).json({ success: false, message: "Access denied." }),
  );
  const conversationAccess = async (req, res, next, id) => {
    const [first, second, extra] = String(id).split("_");
    if (
      !first ||
      !second ||
      extra ||
      first === second ||
      id !== [first, second].sort().join("_") ||
      ![first, second].includes(req.identity.uid)
    ) {
      return res
        .status(403)
        .json({
          success: false,
          message: "Access denied to this conversation.",
        });
    }
    try {
      const connection = await connectionsCollection.findOne({
        status: "accepted",
        $or: [
          { senderId: first, receiverId: second },
          { senderId: second, receiverId: first },
        ],
      });
      if (!connection)
        return res
          .status(403)
          .json({
            success: false,
            message: "Messaging requires an accepted connection.",
          });
      return next();
    } catch {
      return res
        .status(503)
        .json({ success: false, message: "Conversation checks unavailable." });
    }
  };
  router.param("conversationId", conversationAccess);
  router.post("/mark-read", (req, res, next) =>
    conversationAccess(req, res, next, req.body.conversationId),
  );
  const emitRead = (conversationId, userId) => {
    const [first, second] = conversationId.split("_");
    io?.to(conversationId)
      .to(`account_${first}`)
      .to(`account_${second}`)
      .emit("messages-read", { conversationId, userId });
  };

  // Get all conversations for a user
  router.get("/conversations/:userId", async (req, res) => {
    try {
      const { userId } = req.params;

      // Get user's connections (only accepted ones)
      const connections = await connectionsCollection
        .find({
          $or: [{ senderId: userId }, { receiverId: userId }],
          status: "accepted",
        })
        .toArray();

      // Get conversation partners
      const conversationPartners = connections.map((connection) =>
        connection.senderId === userId
          ? connection.receiverId
          : connection.senderId,
      );

      // Get partner details
      const partners = await usersCollection
        .find(
          {
            uid: { $in: conversationPartners },
          },
          {
            projection: {
              uid: 1,
              displayName: 1,
              photoURL: 1,
              profession: 1,
              location: 1,
            },
          },
        )
        .toArray();

      // For each partner, get last message and unread count
      const conversations = await Promise.all(
        partners.map(async (partner) => {
          // Generate conversation ID (sorted user IDs)
          const conversationId = [userId, partner.uid].sort().join("_");

          // Get last message
          const lastMessage = await messagesCollection.findOne(
            { conversationId },
            {
              sort: { timestamp: -1 },
              projection: {
                content: 1,
                senderId: 1,
                timestamp: 1,
                read: 1,
              },
            },
          );

          // Get unread count
          const unreadCount = await messagesCollection.countDocuments({
            conversationId,
            receiverId: userId,
            read: false,
          });

          return {
            conversationId,
            partner,
            lastMessage,
            unreadCount,
            updatedAt: lastMessage?.timestamp || new Date(),
          };
        }),
      );

      // Sort by last message time
      conversations.sort(
        (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
      );

      res.json({
        success: true,
        conversations,
        count: conversations.length,
      });
    } catch (error) {
      console.error("Error fetching conversations:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  });

  // Get messages for a conversation
  router.get("/conversation/:conversationId", async (req, res) => {
    try {
      const { conversationId } = req.params;
      const userId = req.identity.uid;
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 50));
      const before = req.query.before ? new Date(req.query.before) : new Date();
      if (Number.isNaN(before.getTime()))
        return res
          .status(400)
          .json({ success: false, message: "Invalid message date." });

      // Validate that user is part of this conversation
      const [user1Id, user2Id] = conversationId.split("_");
      if (![user1Id, user2Id].includes(userId)) {
        return res.status(403).json({
          success: false,
          message: "Access denied to this conversation",
        });
      }

      const cursor = { timestamp: { $lt: before } };
      if (req.query.beforeId) {
        if (!/^[a-f0-9]{24}$/i.test(req.query.beforeId))
          return res
            .status(400)
            .json({ success: false, message: "Invalid message cursor." });
        cursor.$or = [
          { timestamp: { $lt: before } },
          { timestamp: before, _id: { $lt: new ObjectId(req.query.beforeId) } },
        ];
        delete cursor.timestamp;
      }
      // Get messages
      const messages = await messagesCollection
        .find({
          conversationId,
          ...cursor,
        })
        .sort({ timestamp: -1, _id: -1 })
        .limit(limit)
        .toArray();

      // Reverse to get chronological order
      messages.reverse();

      // Mark messages as read for this user
      if (userId) {
        await messagesCollection.updateMany(
          {
            conversationId,
            receiverId: userId,
            read: false,
          },
          {
            $set: {
              read: true,
              readAt: new Date(),
            },
          },
        );
      }

      emitRead(conversationId, userId);
      res.json({
        success: true,
        messages,
        hasMore: messages.length === limit,
      });
    } catch (error) {
      console.error("Error fetching messages:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  });

  // Send a message
  router.post("/send", async (req, res) => {
    try {
      const { conversationId, senderId, receiverId, content } = req.body;

      // Validate input
      if (
        !conversationId ||
        !senderId ||
        !receiverId ||
        typeof content !== "string" ||
        !content.trim() ||
        content.length > 10000
      ) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields",
        });
      }

      if (
        senderId === receiverId ||
        conversationId !== [senderId, receiverId].sort().join("_")
      )
        return res
          .status(400)
          .json({ success: false, message: "Invalid conversation ID." });

      // Validate conversation ID format
      const [user1Id, user2Id] = conversationId.split("_");
      if (!user1Id || !user2Id || user1Id === user2Id) {
        return res.status(400).json({
          success: false,
          message: "Invalid conversation ID",
        });
      }

      // Verify users exist
      const [sender, receiver] = await Promise.all([
        usersCollection.findOne({ uid: senderId }),
        usersCollection.findOne({ uid: receiverId }),
      ]);

      if (!sender || !receiver) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // Verify they are connected
      const connection = await connectionsCollection.findOne({
        $or: [
          { senderId: senderId, receiverId: receiverId },
          { senderId: receiverId, receiverId: senderId },
        ],
        status: "accepted",
      });

      if (!connection) {
        return res.status(403).json({
          success: false,
          message: "You can only message your connections",
        });
      }

      // Create message
      const message = {
        conversationId,
        senderId,
        receiverId,
        content: content.trim(),
        timestamp: new Date(),
        read: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await messagesCollection.insertOne(message);
      message._id = result.insertedId;
      // Union rooms avoid duplicate delivery to users already viewing this chat.
      io?.to(conversationId)
        .to(`account_${senderId}`)
        .to(`account_${receiverId}`)
        .emit("receive-message", message);

      if (notificationsCollection) {
        try {
          const notification = {
            userId: receiverId,
            type: "new_message",
            title: "New Message",
            message: content.trim().slice(0, 100),
            senderId,
            senderName: sender.displayName || "Member",
            senderPhotoURL: sender.photoURL || "",
            targetId: conversationId,
            targetType: "message",
            read: false,
            createdAt: new Date(),
          };
          const inserted =
            await notificationsCollection.insertOne(notification);
          notification._id = inserted.insertedId;
          io?.to(`notifications_${receiverId}`).emit(
            "new-notification",
            notification,
          );
          io?.to(`notifications_${receiverId}`).emit(
            "notification-count",
            await notificationsCollection.countDocuments({
              userId: receiverId,
              read: false,
            }),
          );
        } catch (error) {
          console.error("Message saved; notification delivery failed:", error);
        }
      }

      res.status(201).json({
        success: true,
        message: "Message sent successfully",
        data: message,
      });
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  });

  // Mark messages as read
  router.post("/mark-read", async (req, res) => {
    try {
      const { conversationId, userId } = req.body;

      if (!conversationId || !userId) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields",
        });
      }

      const result = await messagesCollection.updateMany(
        {
          conversationId,
          receiverId: userId,
          read: false,
        },
        {
          $set: {
            read: true,
            readAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );

      emitRead(conversationId, userId);
      res.json({
        success: true,
        message: "Messages marked as read",
        modifiedCount: result.modifiedCount,
      });
    } catch (error) {
      console.error("Error marking messages as read:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  });

  // Get unread message count
  router.get("/unread-count/:userId", async (req, res) => {
    try {
      const { userId } = req.params;

      const count = await messagesCollection.countDocuments({
        receiverId: userId,
        read: false,
      });

      res.json({
        success: true,
        count,
      });
    } catch (error) {
      console.error("Error fetching unread count:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  });

  // Delete a message (soft delete for sender)
  router.delete("/message/:messageId", async (req, res) => {
    try {
      const { messageId } = req.params;
      const { userId } = req.body;

      if (!ObjectId.isValid(messageId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid message ID",
        });
      }

      const message = await messagesCollection.findOne({
        _id: new ObjectId(messageId),
      });

      if (!message) {
        return res.status(404).json({
          success: false,
          message: "Message not found",
        });
      }

      // Only sender can delete
      if (message.senderId !== userId) {
        return res.status(403).json({
          success: false,
          message: "You can only delete your own messages",
        });
      }

      // For now, we'll do a hard delete
      // In a production app, you might want to implement soft delete
      const result = await messagesCollection.deleteOne({
        _id: new ObjectId(messageId),
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Message not found",
        });
      }

      res.json({
        success: true,
        message: "Message deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting message:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  });

  // Search messages in a conversation
  router.get("/search/:conversationId", async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { query } = req.query;
      const userId = req.identity.uid;

      if (!query?.trim()) {
        return res.status(400).json({
          success: false,
          message: "Search query is required",
        });
      }

      // Validate that user is part of this conversation
      const [user1Id, user2Id] = conversationId.split("_");
      if (![user1Id, user2Id].includes(userId)) {
        return res.status(403).json({
          success: false,
          message: "Access denied to this conversation",
        });
      }

      const messages = await messagesCollection
        .find({
          conversationId,
          content: {
            $regex: String(query)
              .trim()
              .slice(0, 150)
              .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            $options: "i",
          },
        })
        .sort({ timestamp: -1 })
        .limit(100)
        .toArray();

      res.json({
        success: true,
        messages,
        count: messages.length,
      });
    } catch (error) {
      console.error("Error searching messages:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  });

  return router;
};
