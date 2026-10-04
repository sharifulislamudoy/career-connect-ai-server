const { getFirebaseAuth } = require("./aiAuth");
const invalidCodes = new Set([
  "auth/argument-error",
  "auth/invalid-id-token",
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/user-disabled",
  "auth/user-not-found",
]);
module.exports = async (req, res, next) => {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || "");
  if (!match)
    return res
      .status(401)
      .json({
        success: false,
        message: "Sign in to access your career workspace.",
      });
  try {
    req.identity = await getFirebaseAuth().verifyIdToken(match[1], true);
    // Legacy route handlers must never trust a caller-supplied identity header.
    req.headers["x-user-id"] = req.identity.uid;
    res.set("Cache-Control", "no-store");
    return next();
  } catch (error) {
    const invalid = invalidCodes.has(error.code);
    return res
      .status(invalid ? 401 : 503)
      .json({
        success: false,
        message: invalid
          ? "Your session expired. Please sign in again."
          : "Authentication is temporarily unavailable. Check Firebase Admin configuration.",
      });
  }
};
