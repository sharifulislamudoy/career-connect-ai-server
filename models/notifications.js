const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    ref: 'User',
    index: true
  },
  type: {
    type: String,
    required: true,
    enum: [
      'connection_request',
      'connection_accepted', 
      'connection_rejected',
      'new_message',
      'job_application',
      'job_application_status',
      'post_like',
      'post_comment',
      'system_announcement'
    ]
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  senderId: {
    type: String,
    ref: 'User'
  },
  senderName: String,
  senderPhotoURL: String,
  targetId: String,
  targetType: {
    type: String,
    enum: ['connection', 'message', 'post', 'job', 'application', 'system']
  },
  read: {
    type: Boolean,
    default: false,
    index: true
  },
  readAt: Date,
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Index for faster queries
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);