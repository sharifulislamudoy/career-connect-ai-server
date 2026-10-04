const fs = require("node:fs");
const path = require("node:path");
const {
  getApps,
  initializeApp,
  applicationDefault,
  cert,
} = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

let firebaseAuth;

const invalidTokenCodes = new Set([
  "auth/argument-error",
  "auth/invalid-id-token",
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/user-disabled",
  "auth/user-not-found",
]);

function getFirebaseOptions() {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const credentialsPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();

  let serviceAccount;

  if (credentialsPath) {
    const filename = path.isAbsolute(credentialsPath)
      ? credentialsPath
      : path.resolve(__dirname, "..", credentialsPath);

    serviceAccount = JSON.parse(
      fs.readFileSync(filename, "utf8")
    );
  } else if (clientEmail || privateKey) {
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        "Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY together."
      );
    }

    serviceAccount = {
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey,
    };
  }

  if (serviceAccount) {
    if (
      !serviceAccount.project_id ||
      !serviceAccount.client_email ||
      !serviceAccount.private_key
    ) {
      throw new Error(
        "Firebase service account is missing required fields."
      );
    }

    if (
      projectId &&
      projectId !== serviceAccount.project_id
    ) {
      throw new Error(
        "FIREBASE_PROJECT_ID does not match the service account project."
      );
    }

    return {
      projectId: serviceAccount.project_id,
      credential: cert({
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email,
        privateKey: serviceAccount.private_key.replace(
          /\\n/g,
          "\n"
        ),
      }),
    };
  }

  // Google-hosted environments can supply credentials automatically.
  return {
    credential: applicationDefault(),
    ...(projectId ? { projectId } : {}),
  };
}

function getFirebaseAuth() {
  if (!firebaseAuth) {
    const existingApp = getApps().find(
      (app) => app.name === "career-connect-auth"
    );

    const app =
      existingApp ||
      initializeApp(
        getFirebaseOptions(),
        "career-connect-auth"
      );

    firebaseAuth = getAuth(app);
  }

  return firebaseAuth;
}

module.exports = (usersCollection) => {
  return async (req, res, next) => {
    const authorization = req.headers.authorization || "";
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);

    if (!match) {
      return res.status(401).json({
        success: false,
        error: "Please sign in to use AI.",
      });
    }

    let identity;

    try {
      // Also reject revoked sessions and disabled Firebase users.
      identity = await getFirebaseAuth().verifyIdToken(
        match[1],
        true
      );
    } catch (error) {
      const invalidSession = invalidTokenCodes.has(error.code);

      if (!invalidSession) {
        // Never log tokens, private keys or credential contents.
        console.error(
          "[aiAuth] Firebase verification unavailable:",
          error.code || "firebase/configuration-error"
        );
      }

      return res.status(invalidSession ? 401 : 503).json({
        success: false,
        error: invalidSession
          ? "Your session is invalid or expired. Please sign in again."
          : "Authentication service unavailable. Check server Firebase Admin credentials.",
      });
    }

    try {
      const user = await usersCollection.findOne(
        { uid: identity.uid },
        {
          projection: {
            uid: 1,
            displayName: 1,
            fullName: 1,
            profession: 1,
            bio: 1,
            location: 1,
            skills: 1,
            experience: 1,
            education: 1,
            careerGoals: 1,
            userType: 1,
            status: 1,
            isBlocked: 1,
            isBanned: 1,
          },
        }
      );

      if (!user) {
        return res.status(404).json({
          success: false,
          error: "Create your profile before using AI.",
        });
      }

      if (
        user.isBlocked ||
        user.isBanned ||
        ["blocked", "banned", "suspended"].includes(user.status)
      ) {
        return res.status(403).json({
          success: false,
          error: "This account cannot use AI.",
        });
      }

      req.aiUser = user;
      req.aiIdentity = {
        uid: identity.uid,
        email: identity.email || "",
      };
    } catch {
      return res.status(503).json({
        success: false,
        error: "Profile database is temporarily unavailable.",
      });
    }

    return next();
  };
};
// Shared verifier for HTTP and Socket.IO member sessions.
module.exports.getFirebaseAuth = getFirebaseAuth;
