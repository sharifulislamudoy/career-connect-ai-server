// middleware/roleCheck.js
module.exports = (...allowedRoles) => {
  return (req, res, next) => {
    const userRole = req.user?.userType;
    if (!userRole) {
      return res
        .status(403)
        .json({ success: false, message: "Forbidden: no role" });
    }
    if (allowedRoles.includes(userRole)) {
      next();
    } else {
      res
        .status(403)
        .json({ success: false, message: "Forbidden: insufficient permissions" });
    }
  };
};