const { randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const {
  effectivePlan,
  periodKey,
  limits,
  credits,
} = require("../config/plans");
const { apiError } = require("./gemini");
const usageContext = new AsyncLocalStorage();
async function acquire(db, uid) {
  const token = randomUUID();
  const now = new Date();
  const user = await db.collection("users").findOneAndUpdate(
    {
      uid,
      $or: [
        { "workspaceLock.until": { $lt: now } },
        { workspaceLock: { $exists: false } },
      ],
    },
    {
      $set: {
        workspaceLock: { token, until: new Date(Date.now() + 180000) },
      },
    },
    { returnDocument: "after" },
  );
  if (!user)
    throw apiError(
      409,
      "Another request is running. Wait for it to finish and retry.",
    );
  const timer = setInterval(() => {
    db.collection("users")
      .updateOne(
        { uid, "workspaceLock.token": token },
        { $set: { "workspaceLock.until": new Date(Date.now() + 180000) } },
      )
      .catch(() => {});
  }, 30000);
  timer.unref();
  return {
    user,
    async release() {
      clearInterval(timer);
      await db
        .collection("users")
        .updateOne(
          { uid, "workspaceLock.token": token },
          { $unset: { workspaceLock: "" } },
        );
    },
  };
}
async function snapshot(db, user) {
  const plan = effectivePlan(user);
  const period = periodKey();
  const meter =
    (await db
      .collection("usage_months")
      .findOne({ userId: user.uid, period })) || {};
  const lifetime =
    (await db.collection("usage_lifetime").findOne({ userId: user.uid })) || {};
  const resourceUsed = {
    documents: await db
      .collection("resumes")
      .countDocuments({ userId: user.uid }),
    workspace: await db
      .collection("application_workspace")
      .countDocuments({ userId: user.uid, archived: { $ne: true } }),
    alerts: await db
      .collection("job_alerts")
      .countDocuments({ userId: user.uid }),
  };
  const features = Object.fromEntries(
    Object.entries(limits[plan]).map(([key, limit]) => {
      const used =
        resourceUsed[key] ??
        (plan === "basic" && key === "tailoring"
          ? lifetime.tailoring || 0
          : meter[key] || 0);
      return [
        key,
        {
          used,
          limit,
          remaining: limit === null ? null : Math.max(0, limit - used),
          lifetime: plan === "basic" && key === "tailoring",
        },
      ];
    }),
  );
  const creditAllowance = Object.entries(credits).reduce(
    (n, [key, cost]) => n + (limits[plan][key] || 0) * cost,
    0,
  );
  return {
    plan,
    period,
    expiresAt: user.packageExpiry || null,
    subscriptionStatus: user.subscriptionStatus || "none",
    features,
    credits: {
      used: meter.credits || 0,
      limit: plan === "premium" ? null : creditAllowance,
      remaining:
        plan === "premium"
          ? null
          : Object.entries(credits).reduce(
              (total, [key, cost]) =>
                total + (features[key]?.remaining || 0) * cost,
              0,
            ),
      note: "App credits are weighted usage units, not AI provider billing. Feature limits determine access.",
    },
    tokens: {
      input: meter.inputTokens || 0,
      output: meter.outputTokens || 0,
      total: meter.totalTokens || 0,
    },
  };
}
// A renewable per-user MongoDB lock serializes checks AND reservations across server replicas.
function gate(db, resolve) {
  return async (req, res, next) => {
    let lock;
    let reservations = [];
    let event;
    let context;
    try {
      lock = await acquire(db, req.identity.uid);
      const user = lock.user;
      const plan = effectivePlan(user);
      const period = periodKey();
      if (
        user.isBanned ||
        user.isBlocked ||
        ["banned", "blocked", "suspended"].includes(user.status)
      )
        throw apiError(403, "This account is restricted.");
      const config = await resolve(req, user, plan);
      if (!config) {
        await lock.release();
        return next();
      }
      if (config.validate) await config.validate();
      const meter =
        (await db
          .collection("usage_months")
          .findOne({ userId: user.uid, period })) || {};
      const lifetime =
        (await db.collection("usage_lifetime").findOne({ userId: user.uid })) ||
        {};
      for (const feature of config.features || []) {
        const limit = limits[plan][feature];
        if (limit === undefined) throw apiError(400, "Unknown feature.");
        const used =
          plan === "basic" && feature === "tailoring"
            ? lifetime.tailoring || 0
            : meter[feature] || 0;
        if (limit !== null && used >= limit)
          throw apiError(
            limit === 0 ? 403 : 429,
            `${feature} allowance reached. Upgrade your plan or wait for the next month.`,
            { feature },
          );
      }
      for (const [feature, collection, filter] of config.resources || []) {
        const limit = limits[plan][feature];
        if (
          limit !== null &&
          (await db
            .collection(collection)
            .countDocuments({ userId: user.uid, ...filter })) >= limit
        )
          throw apiError(
            429,
            `${feature} limit reached. Remove an item or upgrade your plan.`,
          );
      }
      const window = await db
        .collection("usage_windows")
        .findOne({ userId: user.uid });
      const rateLimit = Math.max(
        1,
        Math.min(
          1000,
          Number(process.env.WORKSPACE_RATE_LIMIT_PER_MINUTE) || 10,
        ),
      );
      const stillCurrent =
        window && Date.now() - new Date(window.start).getTime() < 60000;
      if (stillCurrent && window.count >= rateLimit)
        throw apiError(
          429,
          "Too many workspace requests. Try again in a minute.",
        );
      await db
        .collection("usage_windows")
        .updateOne(
          { userId: user.uid },
          {
            $set: {
              start: stillCurrent ? window.start : new Date(),
              count: stillCurrent ? window.count + 1 : 1,
            },
          },
          { upsert: true },
        );
      const featureCredits = (config.features || []).reduce(
        (total, feature) => total + (credits[feature] || 0),
        0,
      );
      const increments = Object.fromEntries(
        (config.features || []).map((feature) => [feature, 1]),
      );
      increments.credits = featureCredits;
      const increment = async (collection, filter, fields) => {
        await db
          .collection(collection)
          .updateOne(
            filter,
            { $inc: fields, $setOnInsert: { createdAt: new Date() } },
            { upsert: true },
          );
        reservations.push({ collection, filter, fields });
      };
      await increment("usage_months", { userId: user.uid, period }, increments);
      if (config.features?.includes("tailoring"))
        await increment(
          "usage_lifetime",
          { userId: user.uid },
          { tailoring: 1 },
        );
      context = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: process.env.GEMINI_MODEL || null,
      };
      event = {
        requestId: randomUUID(),
        userId: user.uid,
        plan,
        period,
        features: config.features || [],
        action: config.action || req.originalUrl.split("?")[0],
        credits: featureCredits,
        status: "reserved",
        createdAt: new Date(),
      };
      await db.collection("usage_events").insertOne(event);
      let finalized = false;
      const finalize = async (successful) => {
        if (finalized) return;
        finalized = true;
        try {
          if (!successful)
            for (const r of reservations)
              await db.collection(r.collection).updateOne(r.filter, {
                $inc: Object.fromEntries(
                  Object.entries(r.fields).map(([key, value]) => [key, -value]),
                ),
              });
          await db.collection("usage_months").updateOne(
            { userId: user.uid, period },
            {
              $inc: {
                inputTokens: context.inputTokens,
                outputTokens: context.outputTokens,
                totalTokens: context.totalTokens,
              },
            },
          );
          await db.collection("usage_events").updateOne(
            { requestId: event.requestId },
            {
              $set: {
                ...context,
                status: successful ? "completed" : "failed",
                chargedCredits: successful ? featureCredits : 0,
                finishedAt: new Date(),
              },
            },
          );
        } finally {
          await lock.release();
        }
      };
      // Complete accounting before successful HTTP responses become visible.
      const originalEnd = res.end.bind(res);
      let ending = false;
      res.end = function (...args) {
        if (ending) return res;
        ending = true;
        finalize(res.statusCode < 400)
          .then(() => originalEnd(...args))
          .catch((error) => {
            console.error("[usage] finalization failed", error.name);
            originalEnd(...args);
          });
        return res;
      };
      // Do not refund on browser disconnect: AI may still finish and save work.
      // The handler finalizes when it ends, preventing abort-and-retry quota bypass.

      usageContext.run(context, next);
    } catch (error) {
      for (const r of reservations)
        await db
          .collection(r.collection)
          .updateOne(r.filter, {
            $inc: Object.fromEntries(
              Object.entries(r.fields).map(([key, value]) => [key, -value]),
            ),
          })
          .catch(() => {});
      if (lock) await lock.release().catch(() => {});
      res.status(error.status || 503).json({
        success: false,
        error: error.status
          ? error.message
          : "Usage accounting unavailable. Please retry.",
        code: "ENTITLEMENT_LIMIT",
      });
    }
  };
}
function addProviderUsage(metadata = {}) {
  const current = usageContext.getStore();
  if (!current) return;
  current.inputTokens += metadata.promptTokenCount || 0;
  current.outputTokens +=
    (metadata.candidatesTokenCount || 0) + (metadata.thoughtsTokenCount || 0);
  current.totalTokens += metadata.totalTokenCount || 0;
}
module.exports = { acquire, snapshot, gate, usageContext, addProviderUsage };
