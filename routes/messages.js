// routes/messages.js
const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

module.exports = (usersCollection, connectionsCollection, messagesCollection) => {
  // Check if collections are available
  router.use((req, res, next) => {
    if (!messagesCollection || !usersCollection || !connectionsCollection) {
      return res.status(503).json({
        success: false,
        message: 'Database not initialized. Please try again later.'
      });
    }
    next();
  });

  // Get all conversations for a user
  router.get('/conversations/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      // Get user's connections (only accepted ones)
      const connections = await connectionsCollection
        .find({
          $or: [
            { senderId: userId },
            { receiverId: userId }
          ],
          status: 'accepted'
        })
        .toArray();

      // Get conversation partners
      const conversationPartners = connections.map(connection => 
        connection.senderId === userId ? connection.receiverId : connection.senderId
      );

      // Get partner details
      const partners = await usersCollection
        .find({ 
          uid: { $in: conversationPartners }
        }, {
          projection: {
            uid: 1,
            displayName: 1,
            photoURL: 1,
            profession: 1,
            location: 1
          }
        })
        .toArray();

      // For each partner, get last message and unread count
      const conversations = await Promise.all(
        partners.map(async (partner) => {
          // Generate conversation ID (sorted user IDs)
          const conversationId = [userId, partner.uid].sort().join('_');
          
          // Get last message
          const lastMessage = await messagesCollection
            .findOne({ conversationId }, {
              sort: { timestamp: -1 },
              projection: {
                content: 1,
                senderId: 1,
                timestamp: 1,
                read: 1
              }
            });

          // Get unread count
          const unreadCount = await messagesCollection.countDocuments({
            conversationId,
            receiverId: userId,
            read: false
          });

          return {
            conversationId,
            partner,
            lastMessage,
            unreadCount,
            updatedAt: lastMessage?.timestamp || new Date()
          };
        })
      );

      // Sort by last message time
      conversations.sort((a, b) => 
        new Date(b.updatedAt) - new Date(a.updatedAt)
      );

      res.json({
        success: true,
        conversations,
        count: conversations.length
      });
    } catch (error) {
      console.error('Error fetching conversations:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Get messages for a conversation
  router.get('/conversation/:conversationId', async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { userId } = req.query;
      const limit = parseInt(req.query.limit) || 50;
      const before = req.query.before ? new Date(req.query.before) : new Date();

      // Validate that user is part of this conversation
      const [user1Id, user2Id] = conversationId.split('_');
      if (![user1Id, user2Id].includes(userId)) {
        return res.status(403).json({
          success: false,
          message: 'Access denied to this conversation'
        });
      }

      // Get messages
      const messages = await messagesCollection
        .find({
          conversationId,
          timestamp: { $lt: before }
        })
        .sort({ timestamp: -1 })
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
            read: false
          },
          {
            $set: {
              read: true,
              readAt: new Date()
            }
          }
        );
      }

      res.json({
        success: true,
        messages,
        hasMore: messages.length === limit
      });
    } catch (error) {
      console.error('Error fetching messages:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Send a message
  router.post('/send', async (req, res) => {
    try {
      const { conversationId, senderId, receiverId, content } = req.body;

      // Validate input
      if (!conversationId || !senderId || !receiverId || !content?.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }

      // Validate conversation ID format
      const [user1Id, user2Id] = conversationId.split('_');
      if (!user1Id || !user2Id || user1Id === user2Id) {
        return res.status(400).json({
          success: false,
          message: 'Invalid conversation ID'
        });
      }

      // Verify users exist
      const [sender, receiver] = await Promise.all([
        usersCollection.findOne({ uid: senderId }),
        usersCollection.findOne({ uid: receiverId })
      ]);

      if (!sender || !receiver) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Verify they are connected
      const connection = await connectionsCollection.findOne({
        $or: [
          { senderId: senderId, receiverId: receiverId },
          { senderId: receiverId, receiverId: senderId }
        ],
        status: 'accepted'
      });

      if (!connection) {
        return res.status(403).json({
          success: false,
          message: 'You can only message your connections'
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
        updatedAt: new Date()
      };

      const result = await messagesCollection.insertOne(message);
      message._id = result.insertedId;

      res.status(201).json({
        success: true,
        message: 'Message sent successfully',
        data: message
      });
    } catch (error) {
      console.error('Error sending message:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Mark messages as read
  router.post('/mark-read', async (req, res) => {
    try {
      const { conversationId, userId } = req.body;

      if (!conversationId || !userId) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }

      const result = await messagesCollection.updateMany(
        {
          conversationId,
          receiverId: userId,
          read: false
        },
        {
          $set: {
            read: true,
            readAt: new Date(),
            updatedAt: new Date()
          }
        }
      );

      res.json({
        success: true,
        message: 'Messages marked as read',
        modifiedCount: result.modifiedCount
      });
    } catch (error) {
      console.error('Error marking messages as read:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Get unread message count
  router.get('/unread-count/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      const count = await messagesCollection.countDocuments({
        receiverId: userId,
        read: false
      });

      res.json({
        success: true,
        count
      });
    } catch (error) {
      console.error('Error fetching unread count:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Delete a message (soft delete for sender)
  router.delete('/message/:messageId', async (req, res) => {
    try {
      const { messageId } = req.params;
      const { userId } = req.body;

      if (!ObjectId.isValid(messageId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid message ID'
        });
      }

      const message = await messagesCollection.findOne({ 
        _id: new ObjectId(messageId) 
      });

      if (!message) {
        return res.status(404).json({
          success: false,
          message: 'Message not found'
        });
      }

      // Only sender can delete
      if (message.senderId !== userId) {
        return res.status(403).json({
          success: false,
          message: 'You can only delete your own messages'
        });
      }

      // For now, we'll do a hard delete
      // In a production app, you might want to implement soft delete
      const result = await messagesCollection.deleteOne({ 
        _id: new ObjectId(messageId) 
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Message not found'
        });
      }

      res.json({
        success: true,
        message: 'Message deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting message:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Search messages in a conversation
  router.get('/search/:conversationId', async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { query, userId } = req.query;

      if (!query?.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Search query is required'
        });
      }

      // Validate that user is part of this conversation
      const [user1Id, user2Id] = conversationId.split('_');
      if (![user1Id, user2Id].includes(userId)) {
        return res.status(403).json({
          success: false,
          message: 'Access denied to this conversation'
        });
      }

      const messages = await messagesCollection
        .find({
          conversationId,
          content: { $regex: query.trim(), $options: 'i' }
        })
        .sort({ timestamp: -1 })
        .limit(100)
        .toArray();

      res.json({
        success: true,
        messages,
        count: messages.length
      });
    } catch (error) {
      console.error('Error searching messages:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  return router;
};