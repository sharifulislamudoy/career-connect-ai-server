const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 5000;

// Socket.io configuration
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    credentials: true,
  },
});

// Middleware
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());

// MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.jcakfyu.mongodb.net/career-connect-ai?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Database collections
let db;
let usersCollection;
let connectionsCollection;
let messagesCollection;
let notificationsCollection;
let paymentsCollection;
let atsScoresCollection;
let interviewsCollection;
let postsCollection;
let jobsCollection;
let applicationsCollection;
let verificationCodesCollection;

// Socket.io connection handling
const onlineUsers = new Map(); // userId -> socketId

// Helper function to get unread count
async function getUnreadCount(userId) {
  const count = await notificationsCollection.countDocuments({
    userId,
    read: false,
  });
  return count;
}

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  socket.on("user-online", async (userId) => {
    onlineUsers.set(userId, socket.id);
    console.log(`User ${userId} is online`);

    socket.broadcast.emit("user-status-changed", {
      userId,
      status: "online",
    });

    socket.join(`notifications_${userId}`);

    const count = await getUnreadCount(userId);
    socket.emit("notification-count", count);
  });

  socket.on("join-conversation", (conversationId) => {
    socket.join(conversationId);
    console.log(`Socket ${socket.id} joined conversation ${conversationId}`);
  });

  socket.on("leave-conversation", (conversationId) => {
    socket.leave(conversationId);
    console.log(`Socket ${socket.id} left conversation ${conversationId}`);
  });

  socket.on("send-message", async (data) => {
    try {
      const { conversationId, senderId, receiverId, content } = data;

      const message = {
        conversationId,
        senderId,
        receiverId,
        content,
        timestamp: new Date(),
        read: false,
      };

      const result = await messagesCollection.insertOne(message);
      message._id = result.insertedId;

      const sender = await usersCollection.findOne({ uid: senderId });

      const notification = {
        userId: receiverId,
        type: "new_message",
        title: "New Message",
        message: content.substring(0, 100) + (content.length > 100 ? "..." : ""),
        senderId,
        senderName: sender?.displayName || "Someone",
        senderPhotoURL: sender?.photoURL,
        targetId: conversationId,
        targetType: "message",
        read: false,
        createdAt: new Date(),
      };

      await notificationsCollection.insertOne(notification);

      const receiverSocketId = onlineUsers.get(receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("new-notification", notification);
        io.to(`notifications_${receiverId}`).emit(
          "notification-count",
          await getUnreadCount(receiverId)
        );
      }

      io.to(conversationId).emit("receive-message", message);
      socket.emit("message-sent", message);
    } catch (error) {
      console.error("Error sending message:", error);
      socket.emit("message-error", { error: "Failed to send message" });
    }
  });

  socket.on("typing", (data) => {
    const { conversationId, userId, isTyping } = data;
    socket.to(conversationId).emit("user-typing", {
      userId,
      isTyping,
    });
  });

  socket.on("mark-read", async (data) => {
    try {
      const { conversationId, userId } = data;

      await messagesCollection.updateMany(
        {
          conversationId,
          receiverId: userId,
          read: false,
        },
        {
          $set: { read: true, readAt: new Date() },
        }
      );

      socket.to(conversationId).emit("messages-read", { userId });
    } catch (error) {
      console.error("Error marking messages as read:", error);
    }
  });

  socket.on("mark-notification-read", async (data) => {
    try {
      const { notificationId, userId } = data;

      await notificationsCollection.updateOne(
        { _id: new ObjectId(notificationId), userId },
        { $set: { read: true, readAt: new Date() } }
      );

      io.to(`notifications_${userId}`).emit(
        "notification-count",
        await getUnreadCount(userId)
      );
    } catch (error) {
      console.error("Error marking notification as read:", error);
    }
  });

  socket.on("mark-all-notifications-read", async (data) => {
    try {
      const { userId } = data;

      await notificationsCollection.updateMany(
        { userId, read: false },
        { $set: { read: true, readAt: new Date() } }
      );

      io.to(`notifications_${userId}`).emit("notification-count", 0);
    } catch (error) {
      console.error("Error marking all notifications as read:", error);
    }
  });

  socket.on("disconnect", async () => {
    for (const [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userId);
        console.log(`User ${userId} disconnected`);
        socket.broadcast.emit("user-status-changed", {
          userId,
          status: "offline",
        });
        break;
      }
    }
  });
});

async function run() {
  try {
    await client.connect();
    db = client.db("career_connect");
    usersCollection = db.collection("users");
    connectionsCollection = db.collection("connections");
    messagesCollection = db.collection("messages");
    notificationsCollection = db.collection("notifications");
    paymentsCollection = db.collection("payments");
    atsScoresCollection = db.collection("ats_scores");
    interviewsCollection = db.collection("interviews");
    postsCollection = db.collection("posts");
    jobsCollection = db.collection("jobs");
    applicationsCollection = db.collection("applications");
    verificationCodesCollection = db.collection("verification_codes");
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Successfully connected to MongoDB!");

    initializeRoutes();
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1);
  }
}

function initializeRoutes() {
  // Auth middleware (factory)
  const authMiddleware = require("./middleware/auth")(usersCollection);

  // Role check middleware (factory)
  const roleCheck = require("./middleware/roleCheck");

  // User Routes
  const userRoutes = require("./routes/users")(usersCollection);
  app.use("/api/users", userRoutes);

  const authRoutes = require("./routes/auth")(db);
  app.use("/api/auth", authRoutes);

  // Connections Routes
  const connectionRoutes = require("./routes/connections")(
    usersCollection,
    connectionsCollection,
    notificationsCollection
  );
  app.use("/api/connections", connectionRoutes);

  // Messages Routes
  const messageRoutes = require("./routes/messages")(
    usersCollection,
    connectionsCollection,
    messagesCollection
  );
  app.use("/api/messages", messageRoutes);

  // Notifications Routes
  const notificationRoutes = require("./routes/notifications")(
    usersCollection,
    notificationsCollection
  );
  app.use("/api/notifications", notificationRoutes);

  // Payment Routes
  const paymentRoutes = require("./routes/payments")(
    usersCollection,
    paymentsCollection
  );
  app.use("/api/payments", paymentRoutes);

  // ATS Score Routes
  const atsScoreRoutes = require("./routes/atsScore")(atsScoresCollection);
  app.use("/api/ats", atsScoreRoutes);

  // Interview Routes
  const interviewRoutes = require("./routes/interviews")(interviewsCollection);
  app.use("/api/interviews", interviewRoutes);

  // --- UPDATED: pass usersCollection to posts route ---
  const postRoutes = require("./routes/posts")(postsCollection, usersCollection);
  app.use("/api/posts", postRoutes);

  const jobRoutes = require("./routes/jobs")(
    jobsCollection,
    applicationsCollection,
    usersCollection
  );
  app.use("/api/jobs", jobRoutes);

  // Resume Routes
  const resumeRoutes = require("./routes/resumes")(db);
  app.use("/api/resumes", resumeRoutes);

  // Admin Routes (with auth and role check)
  const adminRoutes = require("./routes/admin")(
    usersCollection,
    notificationsCollection,
    jobsCollection,
    postsCollection,
    paymentsCollection,
    interviewsCollection,
    io,
    onlineUsers
  );
  app.use("/api/admin", adminRoutes);

  console.log("✅ Routes initialized successfully!");
}

// Root route
app.get("/", (req, res) => {
  res.json({
    message: "Creative Career AI Server is running!",
    timestamp: new Date().toISOString(),
  });
});

// Health check
app.get("/health", async (req, res) => {
  try {
    await client.db("admin").command({ ping: 1 });
    res.json({
      status: "OK",
      database: "Connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      database: "Disconnected",
      error: error.message,
    });
  }
});

// Start server
server.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📱 API available at http://localhost:${port}`);
  console.log("🔌 Socket.io is ready");
  console.log("⏳ Connecting to MongoDB...");
  run().catch(console.dir);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");
  await client.close();
  process.exit(0);
});