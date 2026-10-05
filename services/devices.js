const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const { acquire } = require("./usage");
const { apiError } = require("./gemini");
const { queueMail } = require("./mailQueue");
const digest = (value) =>
  createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
const restricted = (user) =>
  user?.isBanned ||
  user?.isBlocked ||
  ["banned", "blocked", "suspended"].includes(user?.status);
function validDevice(user, id, token) {
  const device = user?.devices?.find((item) => item.id === id);
  const hash = digest(token);
  return (
    !!device &&
    typeof token === "string" &&
    token.length >= 40 &&
    device.tokenHash?.length === hash.length &&
    timingSafeEqual(Buffer.from(device.tokenHash), Buffer.from(hash))
  );
}
async function register(db, identity, body, io) {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(body.deviceId || ""))
    throw apiError(400, "Invalid browser device ID.");
  let user = await db.collection("users").findOne({ uid: identity.uid });
  if (!user) return { success: true, needsProfile: true }; // New accounts are registered after profile creation.
  const lock = await acquire(db, identity.uid);
  try {
    user = lock.user;
    if (restricted(user))
      throw Object.assign(
        apiError(403, "Your account is restricted. Request a review."),
        { code: "ACCOUNT_BANNED" },
      );
    const existing = (user.devices || []).find(
      (device) => device.id === body.deviceId,
    );
    if (validDevice(user, body.deviceId, body.deviceToken)) {
      await db
        .collection("users")
        .updateOne(
          { uid: user.uid, "devices.id": body.deviceId },
          { $set: { "devices.$.lastSeenAt": new Date() } },
        );
      return { success: true, deviceToken: body.deviceToken };
    }
    // A lost token may only be replaced by a recent Firebase re-authentication.
    if (existing && Date.now() / 1000 - identity.auth_time > 300)
      throw apiError(401, "Sign out and sign in again to restore this device.");
    if (!existing && (user.devices || []).length >= 3) {
      const banId = randomBytes(16).toString("hex");
      await db.collection("users").updateOne(
        { uid: user.uid },
        {
          $set: {
            isBanned: true,
            status: "banned",
            banReason: "DEVICE_LIMIT",
            bannedAt: new Date(),
            banId,
          },
        },
      );
      await queueMail(
        db,
        `ban:${banId}`,
        user.email,
        "Career Connect AI — account restricted",
        "Your account was restricted because a fourth browser/device tried to sign in. Sign in and open Account Review to explain the activity. An admin or moderator can review your account.",
      );
      if (io) io.in(`account_${user.uid}`).disconnectSockets(true);
      throw Object.assign(
        apiError(
          403,
          "More than three devices attempted to sign in. Your account is banned pending review.",
        ),
        { code: "ACCOUNT_BANNED" },
      );
    }
    const token = randomBytes(32).toString("hex");
    const now = new Date();
    const entry = {
      id: body.deviceId,
      tokenHash: digest(token),
      label: String(body.label || "Browser").slice(0, 120),
      createdAt: existing?.createdAt || now,
      lastSeenAt: now,
    };
    const devices = [
      ...(user.devices || []).filter((d) => d.id !== body.deviceId),
      entry,
    ];
    await db
      .collection("users")
      .updateOne({ uid: user.uid }, { $set: { devices } });
    return { success: true, deviceToken: token };
  } finally {
    await lock.release();
  }
}
function guard(db) {
  return async (req, res, next) => {
    try {
      const user = await db
        .collection("users")
        .findOne({ uid: req.identity.uid });
      if (!user && req.method === "POST" && req.path === "/users")
        return next();
      if (!user) throw apiError(404, "Create your profile first.");
      if (restricted(user))
        return res.status(403).json({
          success: false,
          code: "ACCOUNT_BANNED",
          error: "Your account is restricted. Request a review.",
          message: "Your account is restricted. Request a review.",
        });
      if (
        !validDevice(
          user,
          req.headers["x-device-id"],
          req.headers["x-device-token"],
        )
      )
        return res.status(401).json({
          success: false,
          code: "DEVICE_REQUIRED",
          error: "Register this device by signing in again.",
        });
      req.member = user;
      return next();
    } catch (error) {
      res.status(error.status || 503).json({
        error: error.status ? error.message : "Account checks unavailable.",
      });
    }
  };
}
module.exports = { register, guard, validDevice, restricted, digest };
