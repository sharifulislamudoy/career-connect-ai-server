const express = require("express");
const { ObjectId } = require("mongodb");

module.exports = (
  usersCollection,
  notificationsCollection,
  jobsCollection,
  postsCollection,
  paymentsCollection,
  interviewsCollection,
  io,
  onlineUsers,
) => {
  const router = express.Router();

  // All admin routes require authentication and admin/moderator role
  const auth = require("../middleware/auth")(usersCollection);
  const roleCheck = require("../middleware/roleCheck");

  router.use(auth);
  router.use(roleCheck("admin", "moderator"));
  router.use((req, res, next) => {
    if (req.path === "/posts" || req.path.startsWith("/posts/"))
      return roleCheck("admin")(req, res, next);
    const module = req.path.startsWith("/jobs")
      ? "jobs"
      : req.path.startsWith("/users")
        ? "users"
        : "reports";
    return require("../services/staff").permit(module)(req, res, next);
  });

  // ---------- POST MANAGEMENT (ADMIN ONLY) ----------
  const escapeSearch = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hydratePostAuthors = async (posts) => {
    const ids = [
      ...new Set(
        posts
          .flatMap((post) => [
            post.userId,
            ...(Array.isArray(post.comments) ? post.comments : []).map(
              (comment) => comment.userId,
            ),
          ])
          .filter(Boolean),
      ),
    ];
    const profiles = ids.length
      ? await usersCollection
          .find(
            { uid: { $in: ids } },
            {
              projection: {
                uid: 1,
                displayName: 1,
                photoURL: 1,
                profession: 1,
              },
            },
          )
          .toArray()
      : [];
    const byUid = new Map(profiles.map((profile) => [profile.uid, profile]));
    const author = (entry) => {
      const profile = byUid.get(entry.userId);
      return profile
        ? {
            displayName: profile.displayName || "Member",
            photoURL: profile.photoURL || "",
            profession: profile.profession || "",
          }
        : {
            displayName: entry.userProfile?.displayName || "Deleted member",
            photoURL: "",
            profession: "",
          };
    };
    return posts.map((post) => ({
      ...post,
      userProfile: author(post),
      likes: Array.isArray(post.likes) ? post.likes : [],
      comments: (Array.isArray(post.comments) ? post.comments : []).map(
        (comment) => ({ ...comment, userProfile: author(comment) }),
      ),
    }));
  };
  router.get("/posts", async (req, res) => {
    try {
      const page = Math.max(
        1,
        Math.min(100000, Math.floor(Number(req.query.page) || 1)),
      );
      const limit = 12;
      const search = String(req.query.search || "")
        .trim()
        .slice(0, 150);
      const filter = {};
      if (search) {
        const regex = { $regex: escapeSearch(search), $options: "i" };
        const authors = await usersCollection
          .find({ displayName: regex }, { projection: { uid: 1 } })
          .toArray();
        filter.$or = [
          { content: regex },
          { userEmail: regex },
          { userId: { $in: authors.map((a) => a.uid) } },
        ];
      }
      const [total, totalPosts, records] = await Promise.all([
        postsCollection.countDocuments(filter),
        postsCollection.countDocuments({}),
        postsCollection
          .find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
      ]);
      res.json({
        success: true,
        posts: await hydratePostAuthors(records),
        totalPosts,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      });
    } catch (error) {
      console.error("Error listing admin posts:", error);
      res
        .status(500)
        .json({ success: false, message: "Posts could not be loaded." });
    }
  });
  router.get("/posts/:id", async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid post ID." });
    try {
      const post = await postsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!post)
        return res
          .status(404)
          .json({ success: false, message: "Post not found." });
      res.json({ success: true, post: (await hydratePostAuthors([post]))[0] });
    } catch (error) {
      console.error("Error reading admin post:", error);
      res
        .status(500)
        .json({ success: false, message: "Post could not be loaded." });
    }
  });
  router.delete("/posts/:id", async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid post ID." });
    try {
      const result = await postsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      if (!result.deletedCount)
        return res
          .status(404)
          .json({
            success: false,
            message: "Post not found or already deleted.",
          });
      res.json({ success: true, message: "Post deleted successfully." });
    } catch (error) {
      console.error("Error deleting admin post:", error);
      res
        .status(500)
        .json({ success: false, message: "Post could not be deleted." });
    }
  });

  // ---------- DASHBOARD STATS ----------
  router.get("/dashboard", async (req, res) => {
    try {
      // Run aggregations in parallel
      const [
        totalUsers,
        totalJobs,
        totalActiveJobs,
        totalPosts,
        totalPayments,
        totalInterviews,
        usersByRole,
        jobsByStatus,
        subscriptionStats,
      ] = await Promise.all([
        usersCollection.countDocuments(),
        jobsCollection.countDocuments(),
        jobsCollection.countDocuments({ status: "active" }),
        postsCollection.countDocuments(),
        paymentsCollection.countDocuments({ status: "completed" }),
        interviewsCollection.countDocuments(),
        usersCollection
          .aggregate([{ $group: { _id: "$userType", count: { $sum: 1 } } }])
          .toArray(),
        jobsCollection
          .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
          .toArray(),
        paymentsCollection
          .aggregate([
            { $match: { status: "completed" } },
            { $group: { _id: "$userId" } },
            { $count: "total" },
          ])
          .toArray(),
      ]);

      const totalSubscribedUsers =
        subscriptionStats.length > 0 ? subscriptionStats[0].total : 0;

      const roleStats = {};
      usersByRole.forEach((item) => {
        roleStats[item._id || "unknown"] = item.count;
      });

      const jobStatusStats = {};
      jobsByStatus.forEach((item) => {
        jobStatusStats[item._id || "unknown"] = item.count;
      });

      const recentUsers = await usersCollection
        .find({})
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray();

      const recentJobs = await jobsCollection
        .find({})
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray();

      const recentPosts = await postsCollection
        .find({})
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray();

      res.json({
        success: true,
        stats: {
          totalUsers,
          totalJobs,
          totalActiveJobs,
          totalPosts,
          totalPayments,
          totalInterviews,
          totalSubscribedUsers,
          usersByRole: roleStats,
          jobsByStatus: jobStatusStats,
        },
        recent: {
          users: recentUsers,
          jobs: recentJobs,
          posts: recentPosts,
        },
      });
    } catch (error) {
      console.error("Error fetching dashboard stats:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  });

  // ---------- USER MANAGEMENT ----------
  router.get("/users", async (req, res) => {
    try {
      const users = await usersCollection
        .find({}, { projection: { workspaceLock: 0, devices: 0 } })
        .toArray();
      res.json({ success: true, users });
    } catch (error) {
      console.error("Error fetching users:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  });

  router.get("/users/:uid", async (req, res) => {
    try {
      const { uid } = req.params;
      const user = await usersCollection.findOne(
        { uid },
        { projection: { workspaceLock: 0, devices: 0 } },
      );
      if (!user) {
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }
      res.json({ success: true, user });
    } catch (error) {
      console.error("Error fetching user:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  });

  router.put("/users/:uid/role", async (req, res) => {
    if (req.user.userType !== "admin")
      return res.status(403).json({ error: "Only admins can change roles." });
    try {
      const { uid } = req.params;
      const { newRole } = req.body;
      const currentUser = req.user;

      if (
        !newRole ||
        !["admin", "moderator", "recruiter", "jobSeeker"].includes(newRole)
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid role" });
      }

      const targetUser = await usersCollection.findOne({ uid });
      if (!targetUser) {
        return res
          .status(404)
          .json({ success: false, message: "Target user not found" });
      }

      const currentRole = currentUser.userType;
      const targetRole = targetUser.userType;

      if (currentRole === "admin") {
        // Admin can do anything
      } else if (currentRole === "moderator") {
        if (targetRole === "admin" || targetRole === "moderator") {
          return res.status(403).json({
            success: false,
            message: "Cannot change role of admin or moderator",
          });
        }
        if (newRole === "admin" || newRole === "moderator") {
          return res.status(403).json({
            success: false,
            message: "Cannot assign admin or moderator role",
          });
        }
      } else {
        return res
          .status(403)
          .json({ success: false, message: "Insufficient permissions" });
      }

      await usersCollection.updateOne(
        { uid },
        { $set: { userType: newRole, updatedAt: new Date() } },
      );

      const notification = {
        userId: uid,
        type: "role_changed",
        title: "Role Updated",
        message: `Your role has been changed to ${newRole} by ${
          currentUser.displayName || currentUser.email
        }`,
        senderId: currentUser.uid,
        senderName: currentUser.displayName || currentUser.email,
        targetId: uid,
        targetType: "user",
        read: false,
        createdAt: new Date(),
      };
      await notificationsCollection.insertOne(notification);

      const socketId = onlineUsers.get(uid);
      if (socketId) {
        io.to(socketId).emit("force-logout", {
          reason: "Your role has been changed. Please log in again.",
          newRole,
        });
        io.to(`notifications_${uid}`).emit("new-notification", notification);
        const count = await notificationsCollection.countDocuments({
          userId: uid,
          read: false,
        });
        io.to(`notifications_${uid}`).emit("notification-count", count);
      }

      res.json({ success: true, message: "Role updated successfully" });
    } catch (error) {
      console.error("Error updating role:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  });

  router.delete("/users/:uid", async (req, res) => {
    try {
      const { uid } = req.params;
      const currentUser = req.user;

      const targetUser = await usersCollection.findOne({ uid });
      if (!targetUser) {
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }

      if (currentUser.uid === uid) {
        return res
          .status(403)
          .json({ success: false, message: "Cannot delete your own account" });
      }

      const targetRole = targetUser.userType;

      if (currentUser.userType === "admin") {
        // Admin can delete any other user
      } else if (currentUser.userType === "moderator") {
        if (targetRole === "admin" || targetRole === "moderator") {
          return res.status(403).json({
            success: false,
            message: "Cannot delete admin or moderator",
          });
        }
      } else {
        return res
          .status(403)
          .json({ success: false, message: "Insufficient permissions" });
      }

      await usersCollection.deleteOne({ uid });

      const socketId = onlineUsers.get(uid);
      if (socketId) {
        io.to(socketId).emit("force-logout", {
          reason: "Your account has been deleted by an administrator.",
        });
      }

      res.json({ success: true, message: "User deleted successfully" });
    } catch (error) {
      console.error("Error deleting user:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  });

  // ---------- JOB VERIFICATION ROUTES (NEW) ----------
  // GET pending jobs (those with licenseImage but not verified)
  router.get("/jobs/pending", async (req, res) => {
    try {
      const currentUser = req.user;
      if (!["admin", "moderator"].includes(currentUser.userType)) {
        return res.status(403).json({
          success: false,
          message: "Insufficient permissions",
        });
      }

      const pendingJobs = await jobsCollection
        .find({
          licenseImage: { $exists: true, $ne: "" },
          isVerified: false,
        })
        .sort({ createdAt: -1 })
        .toArray();

      res.json({
        success: true,
        jobs: pendingJobs,
      });
    } catch (error) {
      console.error("Error fetching pending jobs:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  });

  // PUT approve/verify a job
  router.put("/jobs/:id/verify", async (req, res) => {
    try {
      const { id } = req.params;
      const currentUser = req.user;

      if (!["admin", "moderator"].includes(currentUser.userType)) {
        return res.status(403).json({
          success: false,
          message: "Insufficient permissions",
        });
      }

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid job ID",
        });
      }

      const job = await jobsCollection.findOne({ _id: new ObjectId(id) });
      if (!job) {
        return res.status(404).json({
          success: false,
          message: "Job not found",
        });
      }

      if (!job.licenseImage) {
        return res.status(400).json({
          success: false,
          message: "This job does not have a license image to verify",
        });
      }

      await jobsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            isVerified: true,
            verifiedBy: currentUser.uid,
            verifiedAt: new Date(),
          },
        },
      );

      // Optional notification to recruiter
      const notification = {
        userId: job.recruiterId,
        type: "job_verified",
        title: "Job Verified",
        message: `Your job "${job.title}" has been verified by ${currentUser.displayName || currentUser.email}.`,
        senderId: currentUser.uid,
        senderName: currentUser.displayName || currentUser.email,
        targetId: job._id.toString(),
        targetType: "job",
        read: false,
        createdAt: new Date(),
      };
      await notificationsCollection.insertOne(notification);

      const socketId = onlineUsers.get(job.recruiterId);
      if (socketId) {
        io.to(`notifications_${job.recruiterId}`).emit(
          "new-notification",
          notification,
        );
        const count = await notificationsCollection.countDocuments({
          userId: job.recruiterId,
          read: false,
        });
        io.to(`notifications_${job.recruiterId}`).emit(
          "notification-count",
          count,
        );
      }

      res.json({
        success: true,
        message: "Job verified successfully",
      });
    } catch (error) {
      console.error("Error verifying job:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  });

  return router;
};
