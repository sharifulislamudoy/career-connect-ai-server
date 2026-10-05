const express = require("express");
const { ObjectId } = require("mongodb");
const { permit, modules } = require("../services/staff");
const { snapshot, acquire } = require("../services/usage");
const { effectivePlan } = require("../config/plans");
const { apiError } = require("../services/gemini");
const { queueMail } = require("../services/mailQueue");
const {
  normalizeResume,
  createResumePDF,
  validateResume,
} = require("../services/resumeDocument");
const { loadPhoto } = require("../services/cvPhoto");
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res
      .status(e.status || 503)
      .json({ error: e.status ? e.message : "Admin reports unavailable." });
  }
};
const oid = (value) => {
  if (!/^[a-f0-9]{24}$/i.test(value)) throw apiError(400, "Invalid record.");
  return new ObjectId(value);
};
const page = (req) => ({
  skip: Math.max(0, Math.min(100000, Number(req.query.page) || 1) - 1) * 25,
  limit: 25,
});
const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
module.exports = (db, io) => {
  const router = express.Router();
  router.get(
    "/overview",
    permit("reports"),
    handle(async (req, res) => {
      const counts = {};
      for (const name of [
        "users",
        "jobs",
        "applications",
        "resumes",
        "ats_scores",
        "interviews",
        "learning_paths",
        "career_reports",
        "posts",
      ])
        counts[name] = await db.collection(name).countDocuments();
      const roles = await db
        .collection("users")
        .aggregate([{ $group: { _id: "$userType", count: { $sum: 1 } } }])
        .toArray();
      const now = new Date();
      const plans = await db
        .collection("users")
        .aggregate([
          {
            $project: {
              plan: {
                $cond: [
                  {
                    $and: [
                      { $in: ["$package", ["standard", "premium"]] },
                      { $gt: ["$packageExpiry", now] },
                      {
                        $in: [
                          { $ifNull: ["$subscriptionStatus", "active"] },
                          ["active", "trialing"],
                        ],
                      },
                    ],
                  },
                  "$package",
                  "basic",
                ],
              },
            },
          },
          { $group: { _id: "$plan", count: { $sum: 1 } } },
        ])
        .toArray();
      const revenue = await db
        .collection("payments")
        .aggregate([
          { $match: { status: "completed", currency: "bdt" } },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m",
                  date: "$completedAt",
                  timezone: "Asia/Dhaka",
                },
              },
              grossMinor: { $sum: "$amountMinor" },
              refundMinor: { $sum: { $ifNull: ["$refundedMinor", 0] } },
              payments: { $sum: 1 },
            },
          },
          { $sort: { _id: -1 } },
        ])
        .toArray();
      const monthKey = `${now.toLocaleString("en-US", { timeZone: "Asia/Dhaka", year: "numeric" })}-${String(Number(now.toLocaleString("en-US", { timeZone: "Asia/Dhaka", month: "numeric" }))).padStart(2, "0")}`;
      const totals = revenue.reduce(
        (t, r) => ({
          grossMinor: t.grossMinor + r.grossMinor,
          refundMinor: t.refundMinor + r.refundMinor,
        }),
        { grossMinor: 0, refundMinor: 0 },
      );
      const usage = await db
        .collection("usage_events")
        .aggregate([
          {
            $group: {
              _id: "$status",
              requests: { $sum: 1 },
              credits: { $sum: { $ifNull: ["$chargedCredits", 0] } },
              inputTokens: { $sum: "$inputTokens" },
              outputTokens: { $sum: "$outputTokens" },
              totalTokens: { $sum: "$totalTokens" },
            },
          },
        ])
        .toArray();
      const canBill = require("../services/staff").allowed(
        req.member,
        "billing",
      );
      res.json({
        success: true,
        counts,
        roles,
        plans,
        revenue: canBill ? revenue : [],
        totals: canBill
          ? { ...totals, netMinor: totals.grossMinor - totals.refundMinor }
          : { grossMinor: 0, refundMinor: 0, netMinor: 0 },
        thisMonth: canBill
          ? revenue.find((r) => r._id === monthKey) || {
              grossMinor: 0,
              refundMinor: 0,
              payments: 0,
            }
          : { grossMinor: 0, refundMinor: 0, payments: 0 },
        usage,
        pendingReviews: await db
          .collection("account_reviews")
          .countDocuments({ status: "pending" }),
        emailQueue: {
          pending: await db
            .collection("email_outbox")
            .countDocuments({ status: { $ne: "sent" } }),
          sent: await db
            .collection("email_outbox")
            .countDocuments({ status: "sent" }),
        },
      });
    }),
  );
  router.get(
    "/users",
    permit("users"),
    handle(async (req, res) => {
      const filter = {};
      if (req.query.role) filter.userType = req.query.role;
      if (req.query.search)
        filter.$or = ["email", "displayName", "uid"].map((k) => ({
          [k]: { $regex: escape(req.query.search), $options: "i" },
        }));
      if (req.query.plan === "basic")
        filter.$and = [
          ...(filter.$or ? [{ $or: filter.$or }] : []),
          {
            $or: [
              { package: "basic" },
              { packageExpiry: { $lte: new Date() } },
              { subscriptionStatus: { $nin: ["active", "trialing"] } },
            ],
          },
        ];
      else if (["standard", "premium"].includes(req.query.plan))
        Object.assign(filter, {
          package: req.query.plan,
          packageExpiry: { $gt: new Date() },
          subscriptionStatus: { $in: ["active", "trialing"] },
        });
      const { skip, limit } = page(req);
      const users = await db
        .collection("users")
        .find(filter, { projection: { devices: 0, workspaceLock: 0 } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();
      res.json({
        success: true,
        total: await db.collection("users").countDocuments(filter),
        users: users.map((u) => ({ ...u, effectivePlan: effectivePlan(u) })),
      });
    }),
  );
  router.get(
    "/users/:uid",
    permit("users"),
    handle(async (req, res) => {
      const u = await db
        .collection("users")
        .findOne(
          { uid: req.params.uid },
          { projection: { workspaceLock: 0, "devices.tokenHash": 0 } },
        );
      if (!u) throw apiError(404, "User not found.");
      const uid = u.uid;
      const stats = {};
      for (const [label, c, filter] of [
        ["documents", "resumes", { userId: uid }],
        ["interviews", "interviews", { userId: uid }],
        ["ats", "ats_scores", { userId: uid }],
        ["learning", "learning_paths", { userId: uid }],
        ["jobs", "jobs", { recruiterId: uid }],
        ["applications", "applications", { jobSeekerId: uid }],
        ["reports", "career_reports", { userId: uid }],
      ])
        stats[label] = await db.collection(c).countDocuments(filter);
      res.json({ success: true, user: u, stats, usage: await snapshot(db, u) });
    }),
  );
  const sources = {
    documents: ["resumes", "userId"],
    interviews: ["interviews", "userId"],
    ats: ["ats_scores", "userId"],
    learning: ["learning_paths", "userId"],
    jobs: ["jobs", "recruiterId"],
    applications: ["applications", "jobSeekerId"],
    reports: ["career_reports", "userId"],
    usage: ["usage_events", "userId"],
    payments: ["payments", "userId"],
    workspace: ["application_workspace", "userId"],
  };
  router.get(
    "/users/:uid/data/:type",
    permit("users"),
    handle(async (req, res) => {
      const config = sources[req.params.type];
      if (!config) throw apiError(400, "Unknown data type.");
      if (
        ["payments"].includes(req.params.type) &&
        !require("../services/staff").allowed(req.member, "billing")
      )
        throw apiError(403, "Billing permission required.");
      const { skip, limit } = page(req);
      const c = db.collection(config[0]);
      const filter = { [config[1]]: req.params.uid };
      let records = await c
        .find(filter)
        .sort({ createdAt: -1, appliedAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();
      if (req.params.type === "applications") {
        const ids = records
          .map((r) => r.jobId)
          .filter((v) => /^[a-f0-9]{24}$/i.test(v));
        const jobs = await db
          .collection("jobs")
          .find({ _id: { $in: ids.map(oid) } })
          .toArray();
        records = records.map((r) => ({
          ...r,
          job: jobs.find((j) => String(j._id) === String(r.jobId)) || null,
        }));
      }
      res.json({
        success: true,
        records,
        total: await c.countDocuments(filter),
      });
    }),
  );
  router.get(
    "/documents/:id/pdf",
    permit("users"),
    handle(async (req, res) => {
      const saved = await db
        .collection("resumes")
        .findOne({ _id: oid(req.params.id) });
      if (!saved) throw apiError(404, "Document not found.");
      const data = normalizeResume(saved);
      validateResume(data, false);
      if (
        /[^\u0000-\u024f\u2000-\u206f\u20ac\u2122\u2212]/u.test(
          JSON.stringify(data),
        )
      )
        throw apiError(
          400,
          "This PDF renderer requires English/Latin document text.",
        );
      const photoBuffer =
        data.documentType === "cv" ? await loadPhoto(data.photoUrl) : undefined;
      const doc = createResumePDF(data, { photoBuffer });
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", 'inline; filename="Resume.pdf"');
      doc.pipe(res);
      doc.end();
    }),
  );
  router.get(
    "/billing",
    permit("billing"),
    handle(async (req, res) => {
      const { skip, limit } = page(req);
      res.json({
        success: true,
        records: await db
          .collection("payments")
          .find({})
          .sort({ completedAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        total: await db.collection("payments").countDocuments(),
      });
    }),
  );
  router.get(
    "/reviews",
    permit("reviews"),
    handle(async (req, res) => {
      const { skip, limit } = page(req);
      const filter = req.query.status ? { status: req.query.status } : {};
      res.json({
        success: true,
        records: await db
          .collection("account_reviews")
          .find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        total: await db.collection("account_reviews").countDocuments(filter),
      });
    }),
  );
  router.post(
    "/reviews/:id/decision",
    permit("reviews"),
    handle(async (req, res) => {
      const decision = req.body.decision;
      if (!["approved", "rejected"].includes(decision))
        throw apiError(400, "Select approved or rejected.");
      const review = await db
        .collection("account_reviews")
        .findOne({ _id: oid(req.params.id) });
      if (!review || review.status !== "pending")
        throw apiError(409, "Review is no longer pending.");
      const target = await db
        .collection("users")
        .findOne({ uid: review.userId });
      if (!target) throw apiError(404, "User not found.");
      if (target.userType === "admin" && req.member.userType !== "admin")
        throw apiError(403, "Only an admin can reopen an admin account.");
      if ((target.banId || "manual") !== review.banId)
        throw apiError(
          409,
          "A newer restriction exists. Review that restriction instead.",
        );
      const lock = await acquire(db, review.userId);
      try {
        const fresh = await db
          .collection("account_reviews")
          .findOne({ _id: review._id });
        if (fresh.status !== "pending")
          throw apiError(409, "Review already processed.");
        const note = String(req.body.note || "").slice(0, 2000);
        if (decision === "approved") {
          await db.collection("users").updateOne(
            { uid: review.userId },
            {
              $set: {
                isBanned: false,
                isBlocked: false,
                status: "active",
                devices: [],
                reopenedAt: new Date(),
              },
              $unset: { banReason: "", banId: "" },
            },
          );
          await queueMail(
            db,
            `reopen:${review._id}`,
            target.email,
            "Career Connect AI — account reopened",
            "Your review was approved and your account is open again. Your registered devices were reset. Sign out and sign in again to register your browser. " +
              note,
          );
        }
        await db.collection("account_reviews").updateOne(
          { _id: review._id, status: "pending" },
          {
            $set: {
              status: decision,
              note,
              reviewedBy: req.identity.uid,
              reviewedAt: new Date(),
            },
          },
        );
        if (io) io.in(`account_${target.uid}`).disconnectSockets(true);
        res.json({ success: true });
      } finally {
        await lock.release();
      }
    }),
  );
  router.put(
    "/users/:uid/permissions",
    handle(async (req, res) => {
      if (req.member.userType !== "admin") throw apiError(403, "Admin only.");
      if (
        !Array.isArray(req.body.modules) ||
        req.body.modules.some((m) => !modules.includes(m))
      )
        throw apiError(400, "Invalid modules.");
      const r = await db
        .collection("users")
        .updateOne(
          { uid: req.params.uid, userType: "moderator" },
          { $set: { moderatorModules: [...new Set(req.body.modules)] } },
        );
      if (!r.matchedCount) throw apiError(404, "Moderator not found.");
      res.json({ success: true });
    }),
  );
  return router;
};
