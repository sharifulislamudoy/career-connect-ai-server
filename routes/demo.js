const express = require("express");
const { randomUUID } = require("node:crypto");
const { getFirebaseAuth } = require("../middleware/aiAuth");
const roles = Object.freeze({
  jobSeeker: { label: "Job seeker", path: "/jobs", profession: "Frontend developer" },
  recruiter: { label: "Recruiter", path: "/my-jobs", profession: "Talent acquisition specialist" },
  moderator: { label: "Moderator", path: "/admin/reports", profession: "Community moderator" },
  admin: { label: "Admin", path: "/admin/dashboard", profession: "Platform administrator" },
});

function enabled() { return process.env.DEMO_MODE === "true"; }
function assertDemoIsolation(db) {
  if (!enabled()) return false;
  // Public staff accounts may exist only in an explicitly named demo database
  // and a dedicated Firebase demo project. Never copy live data into these.
  const database = process.env.DEMO_MONGODB_DB;
  const project = process.env.DEMO_FIREBASE_PROJECT_ID;
  if (!database || !database.endsWith("_demo") || db.databaseName !== database || process.env.MONGODB_DB !== database)
    throw new Error("Demo mode requires MONGODB_DB=DEMO_MONGODB_DB ending in _demo.");
  if (!project || !project.endsWith("-demo") || getFirebaseAuth().app.options.projectId !== project)
    throw new Error("Demo mode requires a dedicated Firebase project ending in -demo, matching DEMO_FIREBASE_PROJECT_ID.");
  if (process.env.STRIPE_SECRET_KEY || process.env.EMAIL_USER)
    throw new Error("Remove Stripe and email credentials from the public demo server.");
  return true;
}

module.exports = (db) => {
  const router = express.Router();
  const active = assertDemoIsolation(db);
  let windowEnd = Date.now() + 3600000;
  let attempts = 0;
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/", (_req, res) => res.json({ success: true, enabled: active }));
  router.post("/login", async (req, res) => {
    if (!active) return res.status(404).json({ error: "Demo access is disabled." });
    const role = req.body?.role;
    if (typeof role !== "string" || !Object.hasOwn(roles, role))
      return res.status(400).json({ error: "Choose a valid demo role." });
    if (Date.now() > windowEnd) { attempts = 0; windowEnd = Date.now() + 3600000; }
    // Bound public account creation even when a reverse proxy shares one IP.
    if (++attempts > 100) {
      res.set("Retry-After", String(Math.ceil((windowEnd - Date.now()) / 1000)));
      return res.status(429).json({ error: "Demo login limit reached. Please try again later." });
    }
    try {
      const uid = `demo-${randomUUID()}`;
      const now = new Date();
      const profile = {
        uid,
        email: `${uid}@example.invalid`,
        displayName: `Demo ${roles[role].label}`,
        userType: role,
        profession: roles[role].profession,
        location: "Dhaka, Bangladesh",
        photoURL: "",
        bio: "Sample profile for exploring Career Connect AI.",
        skills: ["React", "Next.js", "TypeScript", "Communication"],
        profileCompleted: true,
        isDemo: true,
        status: "active",
        isBanned: false,
        isBlocked: false,
        package: "Premium",
        packageExpiry: new Date(Date.now() + 86400000).toISOString(),
        subscriptionStatus: "trialing",
        moderatorModules: role === "moderator" ? ["users", "jobs", "reports", "reviews"] : [],
        devices: [],
        createdAt: now,
        updatedAt: now,
      };
      // Signed by Firebase Admin; all existing session/device/role checks apply.
      const customToken = await getFirebaseAuth().createCustomToken(uid, { demo: true });
      await db.collection("users").insertOne(profile);
      if (role === "recruiter") {
        await db.collection("jobs").insertOne(sampleJob(uid, now));
      }
      return res.json({ success: true, customToken, uid, role, redirectTo: roles[role].path });
    } catch (error) {
      console.error("[demo] Login unavailable:", error.code || "demo/setup-error");
      return res.status(503).json({ error: "Demo login is unavailable. Check the demo Firebase service account configuration." });
    }
  });
  return router;
};
module.exports.assertDemoIsolation = assertDemoIsolation;

function sampleJob(recruiterId, now = new Date()) {
  return {
    recruiterId, title: "Frontend Developer (Demo)", company: "Demo Studio",
    location: "Remote", type: "Full-time", experience: "Mid",
    salary: "BDT 40,000–60,000 / month",
    description: "Sample opportunity for testing the job application flow. This is not a real vacancy.",
    requirements: "React and TypeScript\nResponsive UI development\nClear communication",
    responsibilities: "Build accessible web interfaces\nWork with a product team",
    contactEmail: "careers@example.invalid", status: "active", isVerified: false,
    applicants: 0, createdAt: now, updatedAt: now, isDemo: true,
  };
}
module.exports.seedDemo = async (db) => {
  if (!assertDemoIsolation(db)) return;
  const now = new Date();
  await db.collection("users").updateOne({ uid: "demo-sample-recruiter" }, {
    $setOnInsert: {
      uid: "demo-sample-recruiter", email: "careers@example.invalid",
      displayName: "Demo Studio Recruiter", userType: "recruiter",
      profession: "Talent acquisition", location: "Remote", isDemo: true,
      profileCompleted: true, status: "active", package: "Basic",
      createdAt: now, updatedAt: now,
    },
  }, { upsert: true });
  await db.collection("jobs").updateOne({ demoSeed: "frontend-job" }, {
    $setOnInsert: { ...sampleJob("demo-sample-recruiter", now), demoSeed: "frontend-job" },
  }, { upsert: true });
};
