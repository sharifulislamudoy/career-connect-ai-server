const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

module.exports = (usersCollection, connectionsCollection, notificationsCollection) => {
  // Check if collections are available
  router.use((req, res, next) => {
    if (!connectionsCollection || !usersCollection || !notificationsCollection) {
      return res.status(503).json({
        success: false,
        message: 'Database not initialized. Please try again later.'
      });
    }
    next();
  });

  // Send connection request
  router.post('/send-request', async (req, res) => {
    try {
      const { senderId, receiverId, message } = req.body;

      // Validate input
      if (!senderId || !receiverId) {
        return res.status(400).json({
          success: false,
          message: 'Sender ID and Receiver ID are required'
        });
      }

      // Check if users exist
      const [sender, receiver] = await Promise.all([
        usersCollection.findOne({ uid: senderId }),
        usersCollection.findOne({ uid: receiverId })
      ]);

      if (!sender || !receiver) {
        return res.status(404).json({
          success: false,
          message: 'One or both users not found'
        });
      }

      // Check if connection already exists
      const existingConnection = await connectionsCollection.findOne({
        $or: [
          { senderId, receiverId },
          { senderId: receiverId, receiverId: senderId }
        ]
      });

      if (existingConnection) {
        return res.status(400).json({
          success: false,
          message: 'Connection already exists',
          status: existingConnection.status
        });
      }

      // Create connection request
      const connectionRequest = {
        senderId,
        receiverId,
        message: message || '',
        status: 'pending',
        sentAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await connectionsCollection.insertOne(connectionRequest);

      // Create notification for receiver
      const notification = {
        userId: receiverId,
        type: 'connection_request',
        title: 'New Connection Request',
        message: `${sender.displayName || 'Someone'} wants to connect with you`,
        senderId,
        senderName: sender.displayName,
        senderPhotoURL: sender.photoURL,
        targetId: result.insertedId.toString(),
        targetType: 'connection',
        read: false,
        createdAt: new Date()
      };

      await notificationsCollection.insertOne(notification);

      res.status(201).json({
        success: true,
        message: 'Connection request sent successfully',
        connection: { ...connectionRequest, _id: result.insertedId }
      });
    } catch (error) {
      console.error('Error sending connection request:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Accept connection request
  router.post('/accept-request/:requestId', async (req, res) => {
    try {
      const { requestId } = req.params;

      // Validate ObjectId
      if (!ObjectId.isValid(requestId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid request ID'
        });
      }

      const request = await connectionsCollection.findOne({ 
        _id: new ObjectId(requestId),
        status: 'pending'
      });

      if (!request) {
        return res.status(404).json({
          success: false,
          message: 'Connection request not found or already processed'
        });
      }

      // Get user details
      const [sender, receiver] = await Promise.all([
        usersCollection.findOne({ uid: request.senderId }),
        usersCollection.findOne({ uid: request.receiverId })
      ]);

      // Update connection status
      const result = await connectionsCollection.updateOne(
        { _id: new ObjectId(requestId) },
        {
          $set: {
            status: 'accepted',
            respondedAt: new Date(),
            updatedAt: new Date()
          }
        }
      );

      if (result.modifiedCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Failed to accept connection request'
        });
      }

      // Create notification for original sender
      const notification = {
        userId: request.senderId,
        type: 'connection_accepted',
        title: 'Connection Request Accepted',
        message: `${receiver?.displayName || 'Someone'} accepted your connection request`,
        senderId: request.receiverId,
        senderName: receiver?.displayName,
        senderPhotoURL: receiver?.photoURL,
        targetId: requestId,
        targetType: 'connection',
        read: false,
        createdAt: new Date()
      };

      await notificationsCollection.insertOne(notification);

      const updatedConnection = await connectionsCollection.findOne({ 
        _id: new ObjectId(requestId)
      });

      res.json({
        success: true,
        message: 'Connection request accepted',
        connection: updatedConnection
      });
    } catch (error) {
      console.error('Error accepting connection request:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Reject connection request
  router.post('/reject-request/:requestId', async (req, res) => {
    try {
      const { requestId } = req.params;

      if (!ObjectId.isValid(requestId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid request ID'
        });
      }

      const request = await connectionsCollection.findOne({ 
        _id: new ObjectId(requestId),
        status: 'pending'
      });

      if (!request) {
        return res.status(404).json({
          success: false,
          message: 'Connection request not found or already processed'
        });
      }

      // Get receiver details
      const receiver = await usersCollection.findOne({ uid: request.receiverId });

      const result = await connectionsCollection.updateOne(
        { 
          _id: new ObjectId(requestId),
          status: 'pending'
        },
        {
          $set: {
            status: 'rejected',
            respondedAt: new Date(),
            updatedAt: new Date()
          }
        }
      );

      if (result.modifiedCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Connection request not found or already processed'
        });
      }

      // Create notification for sender
      const notification = {
        userId: request.senderId,
        type: 'connection_rejected',
        title: 'Connection Request Rejected',
        message: `${receiver?.displayName || 'Someone'} rejected your connection request`,
        senderId: request.receiverId,
        senderName: receiver?.displayName,
        senderPhotoURL: receiver?.photoURL,
        targetId: requestId,
        targetType: 'connection',
        read: false,
        createdAt: new Date()
      };

      await notificationsCollection.insertOne(notification);

      res.json({
        success: true,
        message: 'Connection request rejected'
      });
    } catch (error) {
      console.error('Error rejecting connection request:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Withdraw connection request
  router.delete('/withdraw-request/:requestId', async (req, res) => {
    try {
      const { requestId } = req.params;

      if (!ObjectId.isValid(requestId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid request ID'
        });
      }

      const result = await connectionsCollection.deleteOne({
        _id: new ObjectId(requestId),
        status: 'pending'
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Connection request not found or already processed'
        });
      }

      res.json({
        success: true,
        message: 'Connection request withdrawn'
      });
    } catch (error) {
      console.error('Error withdrawing connection request:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Remove connection (unfriend)
  router.delete('/remove-connection/:connectionId', async (req, res) => {
    try {
      const { connectionId } = req.params;

      if (!ObjectId.isValid(connectionId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid connection ID'
        });
      }

      const result = await connectionsCollection.deleteOne({
        _id: new ObjectId(connectionId),
        status: 'accepted'
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Connection not found'
        });
      }

      res.json({
        success: true,
        message: 'Connection removed successfully'
      });
    } catch (error) {
      console.error('Error removing connection:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Get user's connections
  router.get('/user/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const { status } = req.query;

      // Build query
      const query = {
        $or: [
          { senderId: userId },
          { receiverId: userId }
        ]
      };

      if (status) {
        query.status = status;
      }

      const connections = await connectionsCollection
        .find(query)
        .sort({ updatedAt: -1 })
        .toArray();

      // Get user details for each connection
      const connectionsWithUsers = await Promise.all(
        connections.map(async (connection) => {
          const otherUserId = connection.senderId === userId 
            ? connection.receiverId 
            : connection.senderId;

          const user = await usersCollection.findOne(
            { uid: otherUserId },
            { projection: { uid: 1, displayName: 1, photoURL: 1, profession: 1, location: 1 } }
          );

          return {
            ...connection,
            otherUser: user || null,
            role: connection.senderId === userId ? 'sender' : 'receiver'
          };
        })
      );

      res.json({
        success: true,
        connections: connectionsWithUsers,
        count: connections.length
      });
    } catch (error) {
      console.error('Error fetching connections:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Get pending connection requests for a user
  router.get('/pending/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      const pendingRequests = await connectionsCollection
        .find({
          receiverId: userId,
          status: 'pending'
        })
        .sort({ sentAt: -1 })
        .toArray();

      // Get sender details
      const requestsWithSenders = await Promise.all(
        pendingRequests.map(async (request) => {
          const sender = await usersCollection.findOne(
            { uid: request.senderId },
            { projection: { uid: 1, displayName: 1, photoURL: 1, profession: 1, location: 1 } }
          );

          return {
            ...request,
            sender: sender || null
          };
        })
      );

      res.json({
        success: true,
        requests: requestsWithSenders,
        count: pendingRequests.length
      });
    } catch (error) {
      console.error('Error fetching pending requests:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Get sent connection requests
  router.get('/sent/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      const sentRequests = await connectionsCollection
        .find({
          senderId: userId,
          status: 'pending'
        })
        .sort({ sentAt: -1 })
        .toArray();

      // Get receiver details
      const requestsWithReceivers = await Promise.all(
        sentRequests.map(async (request) => {
          const receiver = await usersCollection.findOne(
            { uid: request.receiverId },
            { projection: { uid: 1, displayName: 1, photoURL: 1, profession: 1, location: 1 } }
          );

          return {
            ...request,
            receiver: receiver || null
          };
        })
      );

      res.json({
        success: true,
        requests: requestsWithReceivers,
        count: sentRequests.length
      });
    } catch (error) {
      console.error('Error fetching sent requests:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Get suggested connections (users not connected yet)
  router.get('/suggestions/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const limit = parseInt(req.query.limit) || 10;

      // Get user's current connections
      const connections = await connectionsCollection
        .find({
          $or: [
            { senderId: userId },
            { receiverId: userId }
          ]
        })
        .toArray();

      const connectedUserIds = connections.map(conn => 
        conn.senderId === userId ? conn.receiverId : conn.senderId
      );
      connectedUserIds.push(userId); // Exclude self

      // Get suggested users (same profession or location)
      const currentUser = await usersCollection.findOne({ uid: userId });
      
      let suggestedUsersQuery = {
        uid: { $nin: connectedUserIds },
        userType: { $ne: 'recruiter' } // Exclude recruiters if needed
      };

      // If user has profession or location, prioritize similar users
      if (currentUser.profession || currentUser.location) {
        const professionFilter = currentUser.profession ? { profession: currentUser.profession } : {};
        const locationFilter = currentUser.location ? { location: currentUser.location } : {};
        
        // First try to find users with same profession
        const professionMatches = await usersCollection
          .find({
            ...suggestedUsersQuery,
            ...professionFilter
          })
          .limit(limit)
          .toArray();

        if (professionMatches.length >= limit) {
          return res.json({
            success: true,
            suggestions: professionMatches,
            count: professionMatches.length
          });
        }

        // If not enough, include location matches
        suggestedUsersQuery = {
          $or: [
            professionFilter,
            locationFilter
          ],
          uid: { $nin: connectedUserIds }
        };
      }

      const suggestedUsers = await usersCollection
        .find(suggestedUsersQuery)
        .limit(limit)
        .toArray();

      res.json({
        success: true,
        suggestions: suggestedUsers,
        count: suggestedUsers.length
      });
    } catch (error) {
      console.error('Error fetching suggestions:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Check connection status between two users
  router.get('/status/:userId/:otherUserId', async (req, res) => {
    try {
      const { userId, otherUserId } = req.params;

      const connection = await connectionsCollection.findOne({
        $or: [
          { senderId: userId, receiverId: otherUserId },
          { senderId: otherUserId, receiverId: userId }
        ]
      });

      res.json({
        success: true,
        connected: !!connection,
        status: connection?.status || null,
        connectionId: connection?._id || null
      });
    } catch (error) {
      console.error('Error checking connection status:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Get connection statistics
  router.get('/stats/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      const [totalConnections, pendingRequests, sentRequests] = await Promise.all([
        connectionsCollection.countDocuments({
          $or: [
            { senderId: userId },
            { receiverId: userId }
          ],
          status: 'accepted'
        }),
        connectionsCollection.countDocuments({
          receiverId: userId,
          status: 'pending'
        }),
        connectionsCollection.countDocuments({
          senderId: userId,
          status: 'pending'
        })
      ]);

      res.json({
        success: true,
        stats: {
          totalConnections,
          pendingRequests,
          sentRequests
        }
      });
    } catch (error) {
      console.error('Error fetching connection stats:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  return router;
};