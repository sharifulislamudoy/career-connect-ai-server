const { randomUUID } = require("node:crypto");
const { queueMail } = require("./mailQueue");
const { effectivePlan, limits } = require("../config/plans");
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function startCareerWorkers(db) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    const token = randomUUID();
    try {
      let lock;
      try {
        lock = await db.collection("worker_locks").findOneAndUpdate(
          {
            _id: "career-alerts",
            $or: [
              { until: { $lt: new Date() } },
              { until: { $exists: false } },
            ],
          },
          { $set: { token, until: new Date(Date.now() + 240000) } },
          { upsert: true, returnDocument: "after" },
        );
      } catch (e) {
        if (e.code === 11000) return;
        throw e;
      }
      if (lock.token !== token) return;
      const users = db.collection("users");
      const alerts = await db
        .collection("job_alerts")
        .find({ enabled: true })
        .toArray();
      const allowances = new Map();
      for (const alert of alerts) {
        if (!allowances.has(alert.userId)) {
          const user = await users.findOne({ uid: alert.userId });
          const cap = limits[effectivePlan(user)].alerts;
          const active = alerts
            .filter((a) => a.userId === alert.userId)
            .sort((a, b) => a.createdAt - b.createdAt);
          allowances.set(alert.userId, {
            user,
            ids: new Set(
              (cap === null ? active : active.slice(0, cap)).map((a) =>
                String(a._id),
              ),
            ),
          });
        }
        const state = allowances.get(alert.userId);
        if (
          !state.user ||
          state.user.isBanned ||
          state.user.isBlocked ||
          ["banned", "blocked", "suspended"].includes(state.user.status) ||
          !state.ids.has(String(alert._id))
        )
          continue;
        const filter = {
          status: "active",
          createdAt: { $gte: alert.createdAt },
        };
        if (alert.search)
          filter.$or = ["title", "description", "company"].map((key) => ({
            [key]: { $regex: escape(alert.search), $options: "i" },
          }));
        if (alert.location)
          filter.location = { $regex: escape(alert.location), $options: "i" };
        if (alert.type) filter.type = alert.type;
        if (alert.experience) filter.experience = alert.experience;
        const jobs = await db
          .collection("jobs")
          .find(filter)
          .sort({ createdAt: -1 })
          .limit(50)
          .toArray();
        for (const job of jobs) {
          const key = `job-alert:${alert._id}:${job._id}`;
          await db.collection("notifications").updateOne(
            { deliveryKey: key },
            {
              $setOnInsert: {
                deliveryKey: key,
                userId: alert.userId,
                type: "job_alert",
                title: `New match: ${job.title}`,
                message: `${job.company} · ${alert.name}`,
                targetId: String(job._id),
                targetType: "job",
                read: false,
                createdAt: new Date(),
              },
            },
            { upsert: true },
          );
          await queueMail(
            db,
            key,
            state.user.email,
            `Career Connect AI — ${job.title}`,
            `${job.title} at ${job.company}\n${process.env.APP_URL || "http://localhost:5173"}/job/${job._id}\nMatched your alert: ${alert.name}`,
          );
        }
      }
      const reminders = await db
        .collection("application_workspace")
        .find({
          archived: { $ne: true },
          reminderSent: { $ne: true },
          followUpAt: { $lte: new Date(), $ne: null },
        })
        .limit(100)
        .toArray();
      for (const item of reminders) {
        const user = await users.findOne({ uid: item.userId });
        if (!user || user.isBanned || user.isBlocked) continue;
        const key = `follow-up:${item._id}:${new Date(item.followUpAt).getTime()}`;
        await queueMail(
          db,
          key,
          user.email,
          "Career Connect AI — application follow-up reminder",
          `Follow up on ${item.title} at ${item.company}.\n${process.env.APP_URL || "http://localhost:5173"}/career/workspace`,
        );
        await db.collection("notifications").updateOne(
          { deliveryKey: key },
          {
            $setOnInsert: {
              deliveryKey: key,
              userId: item.userId,
              type: "career_reminder",
              title: "Application follow-up",
              message: `${item.title} at ${item.company}`,
              read: false,
              createdAt: new Date(),
            },
          },
          { upsert: true },
        );
        await db
          .collection("application_workspace")
          .updateOne(
            { _id: item._id, followUpAt: item.followUpAt },
            { $set: { reminderSent: true } },
          );
      }
    } finally {
      await db
        .collection("worker_locks")
        .deleteOne({ _id: "career-alerts", token })
        .catch(() => {});
      busy = false;
    }
  };
  const timer = setInterval(
    () => tick().catch((e) => console.error("[career-worker]", e.name)),
    60000,
  );
  timer.unref();
  tick().catch(() => {});
  return timer;
}
module.exports = { startCareerWorkers };
