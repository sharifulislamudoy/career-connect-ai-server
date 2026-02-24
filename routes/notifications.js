const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

module.exports = (usersCollection, notificationsCollection) => {
  // Check if collections are available
  router.use((req, res, next) => {
    if (!notificationsCollection || !usersCollection) {
      return res.status(503).json({
        success: false,
        message: 'Database not initialized. Please try again later.'
      });
    }
    next();
  });

  // Get user's notifications
  router.get('/user/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const { limit = 20, offset = 0, unreadOnly = false } = req.query;

      // Build query
      const query = { userId };
      if (unreadOnly === 'true') {
        query.read = false;
      }

      const notifications = await notificationsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip(parseInt(offset))
        .limit(parseInt(limit))
        .toArray();

      const total = await notificationsCollection.countDocuments(query);
      const unreadCount = await notificationsCollection.countDocuments({ 
        userId, 
        read: false 
      });

      res.json({
        success: true,
        notifications,
        total,
        unreadCount,
        hasMore: total > parseInt(offset) + notifications.length
      });
    } catch (error) {
      console.error('Error fetching notifications:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Get unread notification count
  router.get('/unread-count/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      const count = await notificationsCollection.countDocuments({
        userId,
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

  // Mark notification as read
  router.put('/mark-read/:notificationId', async (req, res) => {
    try {
      const { notificationId } = req.params;
      const { userId } = req.body;

      if (!ObjectId.isValid(notificationId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid notification ID'
        });
      }

      const result = await notificationsCollection.updateOne(
        { _id: new ObjectId(notificationId), userId },
        { $set: { read: true, readAt: new Date() } }
      );

      if (result.modifiedCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Notification not found'
        });
      }

      const unreadCount = await notificationsCollection.countDocuments({
        userId,
        read: false
      });

      res.json({
        success: true,
        message: 'Notification marked as read',
        unreadCount
      });
    } catch (error) {
      console.error('Error marking notification as read:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Mark all notifications as read
  router.put('/mark-all-read/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      const result = await notificationsCollection.updateMany(
        { userId, read: false },
        { $set: { read: true, readAt: new Date() } }
      );

      res.json({
        success: true,
        message: 'All notifications marked as read',
        modifiedCount: result.modifiedCount
      });
    } catch (error) {
      console.error('Error marking all notifications as read:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Delete a notification
  router.delete('/:notificationId', async (req, res) => {
    try {
      const { notificationId } = req.params;
      const { userId } = req.body;

      if (!ObjectId.isValid(notificationId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid notification ID'
        });
      }

      const result = await notificationsCollection.deleteOne({
        _id: new ObjectId(notificationId),
        userId
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Notification not found'
        });
      }

      const unreadCount = await notificationsCollection.countDocuments({
        userId,
        read: false
      });

      res.json({
        success: true,
        message: 'Notification deleted',
        unreadCount
      });
    } catch (error) {
      console.error('Error deleting notification:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Clear all notifications
  router.delete('/clear-all/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      const result = await notificationsCollection.deleteMany({ userId });

      res.json({
        success: true,
        message: 'All notifications cleared',
        deletedCount: result.deletedCount
      });
    } catch (error) {
      console.error('Error clearing notifications:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  // Create notification (for testing or admin use)
  router.post('/create', async (req, res) => {
    try {
      const {
        userId,
        type,
        title,
        message,
        senderId,
        targetId,
        targetType
      } = req.body;

      // Validate required fields
      if (!userId || !type || !title || !message) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }

      // Get sender info if senderId provided
      let senderName = 'System';
      let senderPhotoURL = null;

      if (senderId) {
        const sender = await usersCollection.findOne({ uid: senderId });
        if (sender) {
          senderName = sender.displayName || senderName;
          senderPhotoURL = sender.photoURL;
        }
      }

      const notification = {
        userId,
        type,
        title,
        message,
        senderId: senderId || null,
        senderName,
        senderPhotoURL,
        targetId: targetId || null,
        targetType: targetType || null,
        read: false,
        createdAt: new Date()
      };

      const result = await notificationsCollection.insertOne(notification);
      notification._id = result.insertedId;

      res.status(201).json({
        success: true,
        message: 'Notification created',
        notification
      });
    } catch (error) {
      console.error('Error creating notification:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  });

  return router;
};