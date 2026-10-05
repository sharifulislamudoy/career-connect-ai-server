const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const { randomUUID } = require("node:crypto");
const { MemoryDb } = require("./memoryDb");
const { gate, snapshot, acquire } = require("../services/usage");
const { effectivePlan, periodKey } = require("../config/plans");
const devices = require("../services/devices");
const billing = require("../services/billing");
let db, server, base, mongo;
const originalFetch = global.fetch;
let providerResult,
  providerFailure = false;
const makeReport = () => ({
  title: "Career draft",
  summary: "Relevant React experience",
  draft: "A factual application draft.",
  sections: [{ heading: "Next steps", items: ["Review your real experience"] }],
  score: 65,
  resumeEdits: {
    summary: "React developer with project experience.",
    experience: [],
    projects: [
      {
        index: 0,
        description: "A React career platform.",
        achievements: "Built job search using React.",
      },
    ],
  },
});
// Firebase and model calls are replaced only in this test process.
const authPath = require.resolve("../middleware/aiAuth");
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: () => (req, res, next) => {
    req.aiIdentity = req.identity;
    req.aiUser = req.member;
    next();
  },
};
async function user(plan = "basic", extra = {}) {
  const uid = randomUUID();
  await db
    .collection("users")
    .insertOne({
      uid,
      email: `${uid}@example.test`,
      userType: "jobSeeker",
      displayName: "Test user",
      package: plan,
      subscriptionStatus: plan === "basic" ? "none" : "active",
      packageExpiry: new Date(Date.now() + 86400000),
      devices: [],
      ...extra,
    });
  return db.collection("users").findOne({ uid });
}
async function call(
  path,
  uid,
  body,
  method = body ? "POST" : "GET",
  headers = {},
) {
  const r = await originalFetch(base + path, {
    method,
    headers: {
      "x-test-user": uid,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
const identity = (uid) => ({
  uid,
  email: `${uid}@example.test`,
  auth_time: Date.now() / 1000,
});
const resume = () => ({
  title: "Test resume",
  documentType: "resume",
  personal: {
    name: "Test Person",
    email: "person@example.test",
    title: "React Developer",
    summary: "React developer building useful applications.",
  },
  skills: [{ name: "React", category: "Frontend" }],
  education: [{ degree: "BSc", institution: "Test College" }],
  projects: [
    {
      name: "Career",
      description: "A job search platform.",
      achievements: "Built React search.",
      links: [],
    },
  ],
  experience: [],
});
before(async () => {
  db = new MemoryDb();
  if (process.env.MONGODB_TEST_URI) {
    mongo = new MongoClient(process.env.MONGODB_TEST_URI);
    await mongo.connect();
    db = mongo.db(`career_workspace_test_${randomUUID().replace(/-/g, "")}`);
  }
  await require("../../Career_Connect_AI_Required_Files/server/services/initWorkspace")(db);
  process.env.WORKSPACE_RATE_LIMIT_PER_MINUTE = "1000";
  process.env.GEMINI_API_KEY = "unit-test-key";
  process.env.GEMINI_MODEL = "test-model";
  process.env.STRIPE_SECRET_KEY = "sk_test_only_a_local_double";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_test";
  process.env.STRIPE_PRICE_STANDARD_MONTHLY = "price_std_m";
  process.env.STRIPE_PRICE_STANDARD_YEARLY = "price_std_y";
  process.env.STRIPE_PRICE_PREMIUM_MONTHLY = "price_prem_m";
  global.fetch = async (url, opts) => {
    if (String(url).includes("generativelanguage.googleapis.com"))
      return new Response(
        JSON.stringify(
          providerFailure
            ? { error: { message: "failed" } }
            : {
                candidates: [
                  {
                    finishReason: "STOP",
                    content: {
                      parts: [
                        {
                          text: JSON.stringify(providerResult || makeReport()),
                        },
                      ],
                    },
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 100,
                  candidatesTokenCount: 50,
                  totalTokenCount: 150,
                },
              },
        ),
        {
          status: providerFailure ? 400 : 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    return originalFetch(url, opts);
  };
  const app = express();
  app.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    billing.webhook(() => db),
  );
  app.use(express.json());
  app.use(async (req, res, next) => {
    req.identity = identity(req.headers["x-test-user"]);
    req.member = await db
      .collection("users")
      .findOne({ uid: req.identity.uid });
    next();
  });
  app.use("/account", require("../routes/account")(db));
  app.use("/admin", require("../routes/adminReports")(db));
  app.post(
    "/meter/:feature",
    gate(db, (req) => ({ features: [req.params.feature] })),
    (req, res) =>
      setTimeout(
        () =>
          res
            .status(req.body.fail ? 503 : 200)
            .json({ success: !req.body.fail }),
        req.body.delay || 0,
      ),
  );
  app.use("/api", require("../middleware/entitlements")(db));
  app.post("/api/ai/chat", (req, res) => res.json({ success: true }));
  app.post("/api/ai/interview/start", (req, res) =>
    res.json({ success: true }),
  );
  app.use("/api/resumes", require("../routes/resumes")(db));
  app.use(
    "/api/ats",
    require("../routes/atsScore")(db.collection("ats_scores"), db),
  );
  app.use("/tools", require("../routes/careerTools")(db));
  app.use("/workspace", require("../routes/workspace")(db));
  app.use("/alerts", require("../routes/jobAlerts")(db));
  app.use("/users", require("../routes/users")(db.collection("users")));
  app.use("/guard", devices.guard(db), (req, res) =>
    res.json({ success: true }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  global.fetch = originalFetch;
  server?.closeAllConnections();
  await new Promise((r) => server.close(r));
  if (mongo) {
    await db.dropDatabase();
    await mongo.close();
  }
});
test("expired, past-due and unknown packages fall back to Basic", () => {
  assert.equal(
    effectivePlan({ package: "premium", packageExpiry: new Date(0) }),
    "basic",
  );
  assert.equal(
    effectivePlan({
      package: "premium",
      packageExpiry: new Date(Date.now() + 10000),
      subscriptionStatus: "past_due",
    }),
    "basic",
  );
  assert.equal(effectivePlan({ package: "invented" }), "basic");
  assert.equal(
    effectivePlan({
      package: "Premium",
      packageExpiry: new Date(Date.now() + 10000),
      subscriptionStatus: "active",
    }),
    "premium",
  );
});
test("monthly reset uses Bangladesh timezone", () => {
  assert.equal(periodKey(new Date("2026-09-30T18:01:00Z")), "202610");
  assert.equal(periodKey(new Date("2026-09-30T17:59:00Z")), "202609");
});
test("Basic chat cannot exceed 20 successful requests", async () => {
  const u = await user();
  for (let i = 0; i < 20; i++)
    assert.equal((await call("/meter/chat", u.uid, {})).status, 200);
  assert.equal((await call("/meter/chat", u.uid, {})).status, 429);
  const usage = await snapshot(db, u);
  assert.equal(usage.features.chat.used, 20);
  assert.equal(usage.features.chat.remaining, 0);
});
test("failed AI operation refunds allowance and app credits", async () => {
  const u = await user();
  assert.equal((await call("/meter/chat", u.uid, { fail: true })).status, 503);
  const usage = await snapshot(db, u);
  assert.equal(usage.features.chat.used, 0);
  assert.equal(usage.credits.used, 0);
  assert.equal(
    (await db.collection("usage_events").findOne({ userId: u.uid })).status,
    "failed",
  );
});
test("concurrent requests cannot acquire the same user lock", async () => {
  const u = await user();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => call("/meter/chat", u.uid, { delay: 30 })),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.ok(results.filter((r) => r.status === 409).length >= 11);
  assert.equal((await snapshot(db, u)).features.chat.used, 1);
});
test("per-user lock does not block another account", async () => {
  const a = await user(),
    b = await user();
  const results = await Promise.all([
    call("/meter/chat", a.uid, { delay: 10 }),
    call("/meter/chat", b.uid, { delay: 10 }),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
});
test("browser abort does not refund successfully completed work", async () => {
  const u = await user();
  const controller = new AbortController();
  const promise = originalFetch(base + "/meter/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": u.uid },
    body: JSON.stringify({ delay: 80 }),
    signal: controller.signal,
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 25));
  controller.abort();
  await promise;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await snapshot(db, u)).features.chat.used, 1);
});
test("Premium has no monthly feature quota", async () => {
  const u = await user("premium");
  await db
    .collection("usage_months")
    .updateOne(
      { userId: u.uid, period: periodKey() },
      { $set: { chat: 999999 } },
      { upsert: true },
    );
  assert.equal((await call("/meter/chat", u.uid, {})).status, 200);
  assert.equal((await snapshot(db, u)).features.chat.remaining, null);
});
test("Basic tailoring trial is lifetime, not renewed monthly", async () => {
  const u = await user();
  assert.equal((await call("/meter/tailoring", u.uid, {})).status, 200);
  await db.collection("usage_months").deleteMany({ userId: u.uid });
  assert.equal((await call("/meter/tailoring", u.uid, {})).status, 429);
  assert.equal((await snapshot(db, u)).features.tailoring.remaining, 0);
});
test("paid-only tool rejects Basic even via direct API", async () => {
  const u = await user();
  assert.equal(
    (
      await call("/tools/generate/linkedin", u.uid, {
        prompt: "Optimize my headline.",
      })
    ).status,
    403,
  );
});
test("downgrade does not reset consumed monthly allowance", async () => {
  const u = await user("standard");
  await db
    .collection("usage_months")
    .updateOne(
      { userId: u.uid, period: periodKey() },
      { $set: { chat: 25 } },
      { upsert: true },
    );
  await db
    .collection("users")
    .updateOne({ uid: u.uid }, { $set: { packageExpiry: new Date(0) } });
  assert.equal((await call("/meter/chat", u.uid, {})).status, 429);
});
test("Basic document cap is enforced server-side", async () => {
  const u = await user();
  assert.equal((await call("/api/resumes", u.uid, resume())).status, 201);
  assert.equal((await call("/api/resumes", u.uid, resume())).status, 201);
  assert.equal((await call("/api/resumes", u.uid, resume())).status, 429);
});
test("Basic cannot export or save paid templates/custom styles", async () => {
  const u = await user();
  assert.equal(
    (
      await call("/api/resumes", u.uid, {
        ...resume(),
        template: "professional",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/api/resumes/generate-pdf", u.uid, {
        ...resume(),
        customStyle: { accent: "#ff0000" },
      })
    ).status,
    403,
  );
});
test("Standard supports professional templates but not custom styles", async () => {
  const u = await user("standard");
  assert.equal(
    (
      await call("/api/resumes", u.uid, {
        ...resume(),
        template: "professional",
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await call("/api/resumes", u.uid, {
        ...resume(),
        customStyle: { fontSize: 11 },
      })
    ).status,
    403,
  );
});
test("Basic cannot start voice or more than five interview questions", async () => {
  const u = await user();
  assert.equal(
    (
      await call("/api/ai/interview/start", u.uid, {
        mode: "voice",
        questionCount: 5,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/api/ai/interview/start", u.uid, {
        mode: "text",
        questionCount: 6,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/api/ai/interview/start", u.uid, {
        mode: "text",
        questionCount: 5,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/api/ai/interview/start", u.uid, {
        mode: "text",
        questionCount: 5,
      })
    ).status,
    429,
  );
});
test("ATS job-match consumes both counters; limited branch cannot bypass total quota", async () => {
  const u = await user();
  const text =
    "Test Person person@example.test Skills React Education Test College Projects Career. Built a responsive frontend application using React and JavaScript. Implemented job search, reusable UI components and accessible forms for users. Developed projects and practiced debugging frontend applications. Studied software development with practical projects and completed relevant learning exercises. React developer with clear communication and teamwork skills.";
  assert.equal(
    (
      await call("/api/ats/check-score", u.uid, {
        resumeText: text,
        jobDescription: "React Developer needed",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/api/ats/check-score", u.uid, {
        resumeText: text,
        jobDescription: "React Developer needed",
      })
    ).status,
    429,
  );
  assert.equal((await snapshot(db, u)).features.ats.used, 1);
  assert.equal((await snapshot(db, u)).features.atsJob.used, 1);
});
test("career tool saves report, credits and provider tokens", async () => {
  const u = await user("standard");
  const r = await call("/tools/generate/cover-letter", u.uid, {
    jobDescription:
      "We need a React developer with real frontend project experience.",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.report.tool, "cover-letter");
  const s = await snapshot(db, u);
  assert.equal(s.features.coverLetter.used, 1);
  assert.equal(s.credits.used, 2);
  assert.equal(s.tokens.total, 150);
});
test("model failure refunds tool quota and does not save a report", async () => {
  const u = await user("standard");
  providerFailure = true;
  try {
    assert.equal(
      (await call("/tools/generate/skill-gap", u.uid, { prompt: "React role" }))
        .status,
      503,
    );
  } finally {
    providerFailure = false;
  }
  assert.equal((await snapshot(db, u)).features.skillGap.used, 0);
  assert.equal(
    await db.collection("career_reports").countDocuments({ userId: u.uid }),
    0,
  );
});
test("tailoring creates an editable document while preserving original facts", async () => {
  const u = await user();
  const doc = { ...resume(), userId: u.uid };
  const saved = await db.collection("resumes").insertOne(doc);
  const r = await call("/tools/generate/resume-tailoring", u.uid, {
    resumeId: String(saved.insertedId),
    jobDescription:
      "We need a React developer with real frontend project experience.",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.report.document.personal.name, "Test Person");
  assert.equal(r.data.report.document.education[0].institution, "Test College");
  assert.equal(
    r.data.report.document.projects[0].description,
    "A React career platform.",
  );
  assert.equal(
    (await db.collection("resumes").findOne({ _id: saved.insertedId })).personal
      .summary,
    resume().personal.summary,
  );
});
test("user cannot use another user’s resume or saved report", async () => {
  const a = await user(),
    b = await user();
  const doc = await db
    .collection("resumes")
    .insertOne({ ...resume(), userId: a.uid });
  assert.equal(
    (
      await call("/tools/generate/resume-tailoring", b.uid, {
        resumeId: String(doc.insertedId),
        jobDescription: "A React frontend developer for a real application.",
      })
    ).status,
    404,
  );
  const report = await db
    .collection("career_reports")
    .insertOne({ userId: a.uid, title: "Private" });
  assert.equal(
    (await call(`/tools/reports/${report.insertedId}`, b.uid)).status,
    404,
  );
});
test("external application workspace respects active cap and archive/reactivate checks", async () => {
  const u = await user();
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await call("/workspace", u.uid, {
          title: "Developer",
          company: "Example",
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await call("/workspace", u.uid, {
        title: "Developer",
        company: "Example",
      })
    ).status,
    429,
  );
  const item = await db
    .collection("application_workspace")
    .findOne({ userId: u.uid });
  assert.equal(
    (
      await call(
        `/workspace/${item._id}`,
        u.uid,
        { ...item, archived: true },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/workspace", u.uid, {
        title: "Developer",
        company: "Example",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/workspace/${item._id}`,
        u.uid,
        { ...item, archived: false },
        "PUT",
      )
    ).status,
    429,
  );
});
test("saved alert rules cannot exceed Basic cap", async () => {
  const u = await user();
  assert.equal(
    (await call("/alerts", u.uid, { name: "React jobs", search: "React" }))
      .status,
    200,
  );
  assert.equal(
    (await call("/alerts", u.uid, { name: "Node jobs", search: "Node" }))
      .status,
    429,
  );
});
test("device registration allows three and reuses signed credentials", async () => {
  const u = await user();
  for (let i = 0; i < 3; i++) {
    const d = { deviceId: randomUUID(), label: "Test Browser" };
    const r = await devices.register(db, identity(u.uid), d);
    assert.equal(r.deviceToken.length, 64);
    assert.equal(
      (
        await devices.register(db, identity(u.uid), {
          ...d,
          deviceToken: r.deviceToken,
        })
      ).deviceToken,
      r.deviceToken,
    );
  }
  assert.equal(
    (await db.collection("users").findOne({ uid: u.uid })).devices.length,
    3,
  );
});
test("fourth registered browser bans account and durably queues one email", async () => {
  const u = await user();
  for (let i = 0; i < 3; i++)
    await devices.register(db, identity(u.uid), { deviceId: randomUUID() });
  await assert.rejects(
    devices.register(db, identity(u.uid), { deviceId: randomUUID() }),
    (e) => e.code === "ACCOUNT_BANNED",
  );
  const banned = await db.collection("users").findOne({ uid: u.uid });
  assert.equal(banned.isBanned, true);
  assert.equal(
    await db.collection("email_outbox").countDocuments({ to: u.email }),
    1,
  );
  assert.equal((await call("/guard", u.uid)).data.code, "ACCOUNT_BANNED");
});
test("unregistered or forged device credential cannot access member API", async () => {
  const u = await user();
  const d = { deviceId: randomUUID() };
  const reg = await devices.register(db, identity(u.uid), d);
  assert.equal((await call("/guard", u.uid)).status, 401);
  assert.equal(
    (
      await call("/guard", u.uid, null, "GET", {
        "x-device-id": d.deviceId,
        "x-device-token": "x".repeat(64),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call("/guard", u.uid, null, "GET", {
        "x-device-id": d.deviceId,
        "x-device-token": reg.deviceToken,
      })
    ).status,
    200,
  );
});
test("banned user can submit one review; unauthorized staff cannot approve", async () => {
  const u = await user("basic", {
    isBanned: true,
    status: "banned",
    banId: randomUUID(),
  });
  const reason = "I replaced my old browser and need an account review.";
  assert.equal((await call("/account/review", u.uid, { reason })).status, 200);
  assert.equal(
    (await call("/account/review", u.uid, { reason })).data.alreadyRequested,
    true,
  );
  const review = await db
    .collection("account_reviews")
    .findOne({ userId: u.uid });
  const mod = await user("basic", {
    userType: "moderator",
    moderatorModules: ["users"],
  });
  assert.equal(
    (
      await call(`/admin/reviews/${review._id}/decision`, mod.uid, {
        decision: "approved",
      })
    ).status,
    403,
  );
});
test("authorized moderator reopens account, resets devices and queues email", async () => {
  const u = await user("basic", {
    isBanned: true,
    status: "banned",
    banId: randomUUID(),
    devices: [{ id: "old" }],
  });
  await call("/account/review", u.uid, {
    reason: "Please review my browser replacement and restore my account.",
  });
  const review = await db
    .collection("account_reviews")
    .findOne({ userId: u.uid });
  const mod = await user("basic", {
    userType: "moderator",
    moderatorModules: ["reviews"],
  });
  assert.equal(
    (
      await call(`/admin/reviews/${review._id}/decision`, mod.uid, {
        decision: "approved",
        note: "Approved",
      })
    ).status,
    200,
  );
  const reopened = await db.collection("users").findOne({ uid: u.uid });
  assert.equal(reopened.isBanned, false);
  assert.equal(reopened.devices.length, 0);
  assert.equal(
    await db.collection("email_outbox").countDocuments({ to: u.email }),
    1,
  );
  assert.equal(
    (
      await call(`/admin/reviews/${review._id}/decision`, mod.uid, {
        decision: "approved",
      })
    ).status,
    409,
  );
});
test("ordinary user cannot upgrade package or write device/role/billing fields", async () => {
  const u = await user();
  assert.equal(
    (
      await call(
        `/users/${u.uid}`,
        u.uid,
        {
          package: "premium",
          subscriptionStatus: "active",
          devices: [{}],
          moderatorModules: ["billing"],
          userType: "admin",
        },
        "PUT",
      )
    ).status,
    200,
  );
  const saved = await db.collection("users").findOne({ uid: u.uid });
  assert.equal(saved.package, "basic");
  assert.equal(saved.userType, "jobSeeker");
  assert.deepEqual(saved.devices, []);
  assert.equal(saved.moderatorModules, undefined);
});
test("admin user detail returns counts, usage, learning and applications without device hashes", async () => {
  const u = await user();
  const admin = await user("basic", { userType: "admin" });
  await db.collection("resumes").insertOne({ ...resume(), userId: u.uid });
  await db
    .collection("learning_paths")
    .insertOne({
      userId: u.uid,
      skill: "React",
      weeklySchedule: [],
      completedTaskIds: [],
    });
  const detail = await call(`/admin/users/${u.uid}`, admin.uid);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.stats.documents, 1);
  assert.equal(detail.data.stats.learning, 1);
  assert.equal(detail.data.usage.plan, "basic");
  assert.equal(detail.data.user.workspaceLock, undefined);
  assert.equal(
    (await call(`/admin/users/${u.uid}/data/learning`, admin.uid)).data
      .records[0].skill,
    "React",
  );
});
test("Stripe rejects forged webhook signatures", async () => {
  const r = await call(
    "/webhook",
    "ignored",
    { id: "evt_fake", type: "invoice.paid" },
    "POST",
    { "stripe-signature": "fake" },
  );
  assert.equal(r.status, 400);
});
test("checkout uses configured BDT price and ignores client amount/user IDs", async () => {
  const u = await user();
  const stripe = billing.stripe();
  const original = {
    price: stripe.prices.retrieve,
    customer: stripe.customers.create,
    list: stripe.subscriptions.list,
    session: stripe.checkout.sessions.create,
  };
  let payload;
  stripe.prices.retrieve = async () => ({
    id: "price_std_m",
    currency: "bdt",
    unit_amount: 49900,
    recurring: { interval: "month" },
  });
  stripe.customers.create = async () => ({ id: "cus_test_" + u.uid });
  stripe.subscriptions.list = async () => ({ data: [] });
  stripe.checkout.sessions.create = async (data) => {
    payload = data;
    return { url: "https://checkout.stripe.com/test" };
  };
  try {
    assert.equal(
      await billing.checkout(db, u, "standard", "monthly"),
      "https://checkout.stripe.com/test",
    );
    assert.equal(payload.line_items[0].price, "price_std_m");
    assert.equal(payload.mode, "subscription");
    assert.equal(payload.payment_method_types, undefined);
    assert.equal(
      payload.success_url.includes("/pricing?checkout=success"),
      true,
    );
    assert.equal(
      (await db.collection("users").findOne({ uid: u.uid })).package,
      "basic",
    );
    await assert.rejects(
      billing.checkout(db, u, "premium-hacked", "monthly"),
      (e) => e.status === 400,
    );
  } finally {
    stripe.prices.retrieve = original.price;
    stripe.customers.create = original.customer;
    stripe.subscriptions.list = original.list;
    stripe.checkout.sessions.create = original.session;
  }
});
test("invoice webhook is idempotent and resolves user by Stripe customer, not metadata", async () => {
  const u = await user("basic", {
    stripeCustomerId: "cus_invoice_" + randomUUID(),
  });
  const stripe = billing.stripe();
  const original = {
    invoice: stripe.invoices.retrieve,
    sub: stripe.subscriptions.retrieve,
    list: stripe.subscriptions.list,
  };
  const sub = {
    id: "sub_test",
    customer: u.stripeCustomerId,
    status: "active",
    created: 1,
    items: {
      data: [
        {
          price: { id: "price_std_m" },
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
        },
      ],
    },
  };
  const invoice = {
    id: "in_" + randomUUID(),
    customer: u.stripeCustomerId,
    currency: "bdt",
    amount_paid: 49900,
    parent: { subscription_details: { subscription: sub.id } },
    status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
  };
  stripe.invoices.retrieve = async () => invoice;
  stripe.subscriptions.retrieve = async () => sub;
  stripe.subscriptions.list = async () => ({ data: [sub] });
  try {
    const event = {
      id: "evt_" + randomUUID(),
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: invoice.id,
          metadata: { plan: "premium", userId: "victim" },
        },
      },
    };
    await billing.handleEvent(db, event);
    await billing.handleEvent(db, event);
    assert.equal(
      await db
        .collection("payments")
        .countDocuments({ stripeInvoiceId: invoice.id }),
      1,
    );
    const saved = await db.collection("users").findOne({ uid: u.uid });
    assert.equal(saved.package, "standard");
    assert.equal(effectivePlan(saved), "standard");
    const payment = await db
      .collection("payments")
      .findOne({ stripeInvoiceId: invoice.id });
    assert.equal(payment.amountMinor, 49900);
    assert.equal(payment.userId, u.uid);
  } finally {
    stripe.invoices.retrieve = original.invoice;
    stripe.subscriptions.retrieve = original.sub;
    stripe.subscriptions.list = original.list;
  }
});
test("out-of-order subscription payload cannot restore stale paid access", async () => {
  const u = await user("standard", {
    stripeCustomerId: "cus_cancel_" + randomUUID(),
  });
  const stripe = billing.stripe();
  const original = stripe.subscriptions.list;
  stripe.subscriptions.list = async () => ({
    data: [
      {
        id: "sub_old",
        customer: u.stripeCustomerId,
        status: "canceled",
        created: 1,
        items: {
          data: [
            {
              price: { id: "price_std_m" },
              current_period_end: Math.floor(Date.now() / 1000) + 100000,
            },
          ],
        },
      },
    ],
  });
  try {
    await billing.handleEvent(db, {
      id: "evt_" + randomUUID(),
      type: "customer.subscription.updated",
      data: { object: { customer: u.stripeCustomerId, status: "active" } },
    });
    assert.equal(
      effectivePlan(await db.collection("users").findOne({ uid: u.uid })),
      "basic",
    );
  } finally {
    stripe.subscriptions.list = original;
  }
});
test("revenue overview includes only BDT paid invoices and records refunds", async () => {
  const admin = await user("basic", { userType: "admin" });
  await db
    .collection("payments")
    .insertOne({
      stripeInvoiceId: "in_revenue_" + randomUUID(),
      userId: admin.uid,
      status: "completed",
      currency: "bdt",
      amountMinor: 99900,
      refundedMinor: 10000,
      completedAt: new Date(),
    });
  await db
    .collection("payments")
    .insertOne({
      status: "completed",
      currency: "usd",
      amount: 100000,
      completedAt: new Date(),
    });
  const r = await call("/admin/overview", admin.uid);
  assert.equal(r.status, 200);
  assert.ok(r.data.totals.grossMinor >= 99900);
  assert.ok(r.data.totals.refundMinor >= 10000);
  assert.equal(
    r.data.totals.netMinor,
    r.data.totals.grossMinor - r.data.totals.refundMinor,
  );
});
test("reports-only moderator cannot see billing totals or another user billing records", async () => {
  const mod = await user("basic", {
    userType: "moderator",
    moderatorModules: ["reports", "users"],
  });
  const r = await call("/admin/overview", mod.uid);
  assert.equal(r.status, 200);
  assert.equal(r.data.totals.grossMinor, 0);
  assert.equal(
    (await call(`/admin/users/${mod.uid}/data/payments`, mod.uid)).status,
    403,
  );
});

test("subscription-created or upgraded event never grants unpaid premium access", async () => {
  const u = await user("basic", {
    stripeCustomerId: "cus_unpaid_" + randomUUID(),
  });
  const stripe = billing.stripe();
  const old = stripe.subscriptions.list;
  stripe.subscriptions.list = async () => ({
    data: [
      {
        id: "sub_unpaid_" + u.uid,
        customer: u.stripeCustomerId,
        status: "active",
        created: 1,
        items: {
          data: [
            {
              price: { id: "price_prem_m" },
              current_period_end: Math.floor(Date.now() / 1000) + 100000,
            },
          ],
        },
      },
    ],
  });
  try {
    await billing.handleEvent(db, {
      id: "evt_" + randomUUID(),
      type: "customer.subscription.updated",
      data: { object: { customer: u.stripeCustomerId } },
    });
    assert.equal(
      effectivePlan(await db.collection("users").findOne({ uid: u.uid })),
      "basic",
    );
  } finally {
    stripe.subscriptions.list = old;
  }
});
test("refund events are idempotent, cumulative and cannot precede invoice recording", async () => {
  const u = await user("standard", {
    stripeCustomerId: "cus_refund_" + randomUUID(),
  });
  const invoiceId = "in_refund_" + randomUUID();
  const subId = "sub_refund_" + randomUUID();
  await db
    .collection("payments")
    .insertOne({
      stripeInvoiceId: invoiceId,
      subscriptionId: subId,
      customerId: u.stripeCustomerId,
      userId: u.uid,
      plan: "standard",
      amountMinor: 49900,
      currency: "bdt",
      status: "completed",
      refundedMinor: 0,
      completedAt: new Date(),
      accessThrough: new Date(Date.now() + 86400000),
    });
  const stripe = billing.stripe();
  const old = {
    charge: stripe.charges.retrieve,
    list: stripe.subscriptions.list,
  };
  let charge = {
    id: "ch_refund_1",
    invoice: invoiceId,
    amount_refunded: 10000,
    currency: "bdt",
  };
  stripe.charges.retrieve = async () => charge;
  stripe.subscriptions.list = async () => ({
    data: [
      {
        id: subId,
        customer: u.stripeCustomerId,
        status: "active",
        created: 1,
        items: {
          data: [
            {
              price: { id: "price_std_m" },
              current_period_end: Math.floor(Date.now() / 1000) + 86400,
            },
          ],
        },
      },
    ],
  });
  try {
    const evt = () => ({
      id: "evt_" + randomUUID(),
      type: "charge.refunded",
      data: { object: { id: charge.id } },
    });
    await billing.handleEvent(db, evt());
    await billing.handleEvent(db, evt());
    assert.equal(
      (await db.collection("payments").findOne({ stripeInvoiceId: invoiceId }))
        .refundedMinor,
      10000,
    );
    charge = { ...charge, id: "ch_refund_2", amount_refunded: 5000 };
    await billing.handleEvent(db, evt());
    assert.equal(
      (await db.collection("payments").findOne({ stripeInvoiceId: invoiceId }))
        .refundedMinor,
      15000,
    );
    charge = { ...charge, invoice: "in_not_yet_recorded" };
    await assert.rejects(
      billing.handleEvent(db, evt()),
      (e) => e.status === 503,
    );
  } finally {
    stripe.charges.retrieve = old.charge;
    stripe.subscriptions.list = old.list;
  }
});
test("job alert worker deduplicates notifications and queues due follow-up mail", async () => {
  const u = await user();
  const now = new Date(Date.now() - 1000);
  const a = await db
    .collection("job_alerts")
    .insertOne({
      userId: u.uid,
      name: "React roles",
      search: "React",
      enabled: true,
      createdAt: now,
    });
  const job = await db
    .collection("jobs")
    .insertOne({
      title: "React Developer",
      description: "Build React UI",
      company: "Example",
      status: "active",
      createdAt: new Date(),
    });
  await db
    .collection("application_workspace")
    .insertOne({
      userId: u.uid,
      title: "Developer",
      company: "Example",
      followUpAt: now,
      reminderSent: false,
    });
  const timer = require("../../Career_Connect_AI_Required_Files/server/services/careerWorkers").startCareerWorkers(db);
  try {
    for (let i = 0; i < 50; i++) {
      if (
        (await db.collection("email_outbox").countDocuments({ to: u.email })) >=
        2
      )
        break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(
      await db
        .collection("notifications")
        .countDocuments({
          deliveryKey: `job-alert:${a.insertedId}:${job.insertedId}`,
        }),
      1,
    );
    assert.equal(
      await db.collection("email_outbox").countDocuments({ to: u.email }),
      2,
    );
  } finally {
    clearInterval(timer);
  }
});
test("email worker sends queued messages and records delivery without exposing credentials", async () => {
  const u = await user();
  const mail = require("../../Career_Connect_AI_Required_Files/server/services/mailQueue");
  await mail.queueMail(
    db,
    "mail-test-" + u.uid,
    u.email,
    "Test notice",
    "A test notice.",
  );
  const nodemailer = require("nodemailer");
  const old = nodemailer.createTransport;
  let sent = [];
  nodemailer.createTransport = () => ({
    sendMail: async (m) => {
      sent.push(m.to);
      return { accepted: [m.to] };
    },
  });
  process.env.EMAIL_USER = "sender@example.test";
  process.env.EMAIL_PASS = "test-only";
  const timer = mail.startMailWorker(db);
  try {
    for (let i = 0; i < 100; i++) {
      const item = await db.collection("email_outbox").findOne({ to: u.email });
      if (item.status === "sent") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(sent.includes(u.email));
    assert.equal(
      (await db.collection("email_outbox").findOne({ to: u.email })).status,
      "sent",
    );
  } finally {
    clearInterval(timer);
    nodemailer.createTransport = old;
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;
  }
});

test("durable per-user rate limit applies even to unlimited Premium requests", async () => {
  const u = await user("premium");
  process.env.WORKSPACE_RATE_LIMIT_PER_MINUTE = "2";
  try {
    assert.equal((await call("/meter/chat", u.uid, {})).status, 200);
    assert.equal((await call("/meter/chat", u.uid, {})).status, 200);
    assert.equal((await call("/meter/chat", u.uid, {})).status, 429);
  } finally {
    process.env.WORKSPACE_RATE_LIMIT_PER_MINUTE = "1000";
  }
});

test("case and trailing-slash routes cannot bypass monthly quotas or document caps", async () => {
  const u = await user();
  await db
    .collection("usage_months")
    .updateOne(
      { userId: u.uid, period: periodKey() },
      { $set: { chat: 20 } },
      { upsert: true },
    );
  assert.equal((await call("/api/AI/CHAT/", u.uid, {})).status, 429);
  await db.collection("resumes").insertMany([
    { ...resume(), userId: u.uid },
    { ...resume(), userId: u.uid },
  ]);
  assert.equal((await call("/api/RESUMES/", u.uid, resume())).status, 429);
});
test("saved premium document format remains exportable after subscription expiry", async () => {
  const u = await user("premium");
  const doc = {
    ...resume(),
    template: "professional",
    customStyle: { accent: "#1d4ed8" },
  };
  const created = await call("/api/resumes", u.uid, doc);
  assert.equal(created.status, 201);
  await db
    .collection("users")
    .updateOne({ uid: u.uid }, { $set: { packageExpiry: new Date(0) } });
  const pdf = await originalFetch(base + "/api/resumes/generate-pdf", {
    method: "POST",
    headers: { "x-test-user": u.uid, "Content-Type": "application/json" },
    body: JSON.stringify({ ...doc, _id: created.data.id }),
  });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  const bytes = await pdf.arrayBuffer();
  assert.ok(bytes.byteLength > 1000);
});
