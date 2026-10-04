const { getApps, initializeApp, applicationDefault } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

let firebaseAuth;
function getFirebaseAuth() {
  if (!firebaseAuth) {
    const existing = getApps().find(app => app.name === "career-connect-auth");
    const app = existing || initializeApp({
      credential: applicationDefault(),
      ...(process.env.FIREBASE_PROJECT_ID ? { projectId: process.env.FIREBASE_PROJECT_ID } : {}),
    }, "career-connect-auth");
    firebaseAuth = getAuth(app);
  }
  return firebaseAuth;
}

module.exports = usersCollection => async (req, res, next) => {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || "");
  if (!match) return res.status(401).json({ success: false, error: "Please sign in to use AI." });
  let identity;
  try {
    identity = await getFirebaseAuth().verifyIdToken(match[1], true);
  } catch (error) {
    const invalid = new Set(["auth/argument-error", "auth/invalid-id-token", "auth/id-token-expired", "auth/id-token-revoked", "auth/user-disabled", "auth/user-not-found"]);
    const status = invalid.has(error.code) ? 401 : 503;
    return res.status(status).json({ success: false, error: status === 401
      ? "Your session is invalid or expired. Please sign in again."
      : "Authentication service unavailable. Check server Firebase Admin credentials." });
  }
  try {
    // Identity comes only from the verified token, never x-user-id, body, or query.
    const user = await usersCollection.findOne({ uid: identity.uid }, { projection: {
      uid: 1, displayName: 1, fullName: 1, profession: 1, bio: 1, location: 1,
      skills: 1, experience: 1, education: 1, careerGoals: 1, userType: 1,
      status: 1, isBlocked: 1, isBanned: 1,
    } });
    if (!user) return res.status(404).json({ success: false, error: "Create your profile before using AI." });
    if (user.isBlocked || user.isBanned || ["blocked", "banned", "suspended"].includes(user.status)) {
      return res.status(403).json({ success: false, error: "This account cannot use AI." });
    }
    req.aiUser = user;
    req.aiIdentity = { uid: identity.uid, email: identity.email || "" };
    next();
  } catch {
    res.status(503).json({ success: false, error: "Profile database is temporarily unavailable." });
  }
};
