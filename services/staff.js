const { apiError } = require("./gemini");
const modules = ["users", "jobs", "reports", "billing", "reviews"];
function allowed(user, module) {
  return (
    user?.userType === "admin" ||
    (user?.userType === "moderator" &&
      (user.moderatorModules || []).includes(module))
  );
}
function permit(module) {
  return (req, res, next) =>
    allowed(req.member || req.user, module)
      ? next()
      : res.status(403).json({ error: `Staff permission required: ${module}` });
}
module.exports = { allowed, permit, modules };
