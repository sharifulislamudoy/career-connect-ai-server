// middleware/auth.js
module.exports = (usersCollection) => {
  return async (req, res, next) => {
    const userId = req.headers["x-user-id"];
    if (!userId) {
      return res
        .status(401)
        .json({ success: false, message: "Unauthorized: missing user ID" });
    }

    try {
      const user = await usersCollection.findOne({ uid: userId });
      if (!user) {
        return res
          .status(401)
          .json({ success: false, message: "User not found" });
      }
      req.user = user;
      next();
    } catch (error) {
      console.error("Auth middleware error:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  };
};