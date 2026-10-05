const express = require("express");
const { register, restricted } = require("../services/devices");
const { snapshot, acquire } = require("../services/usage");
module.exports = (db, io) => {
  const router = express.Router();
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 503).json({
        success: false,
        code: e.code,
        error: e.status ? e.message : "Account service unavailable.",
      });
    }
  };
  router.post(
    "/device",
    handle(async (req, res) =>
      res.json(await register(db, req.identity, req.body, io)),
    ),
  );
  router.get(
    "/status",
    handle(async (req, res) => {
      const user = await db
        .collection("users")
        .findOne({ uid: req.identity.uid });
      const review = await db
        .collection("account_reviews")
        .findOne({ userId: req.identity.uid, banId: user?.banId });
      res.json({
        success: true,
        banned: !!restricted(user),
        reason: user?.banReason,
        review,
        devices: (user?.devices || []).map(
          ({ tokenHash, ...device }) => device,
        ),
      });
    }),
  );
  router.post(
    "/review",
    handle(async (req, res) => {
      const user = await db
        .collection("users")
        .findOne({ uid: req.identity.uid });
      if (!restricted(user))
        return res
          .status(400)
          .json({ error: "Your account is not restricted." });
      const reason = String(req.body.reason || "").trim();
      if (reason.length < 20 || reason.length > 3000)
        return res
          .status(400)
          .json({ error: "Explain the activity in 20–3000 characters." });
      const result = await db.collection("account_reviews").updateOne(
        { userId: user.uid, banId: user.banId || "manual" },
        {
          $setOnInsert: {
            userId: user.uid,
            banId: user.banId || "manual",
            email: user.email,
            reason,
            status: "pending",
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
      res.json({ success: true, alreadyRequested: !result.upsertedCount });
    }),
  );
  router.delete(
    "/devices/:id",
    handle(async (req, res) => {
      const { validDevice } = require("../services/devices");
      const user = await db
        .collection("users")
        .findOne({ uid: req.identity.uid });
      if (
        restricted(user) ||
        !validDevice(
          user,
          req.headers["x-device-id"],
          req.headers["x-device-token"],
        )
      )
        return res
          .status(403)
          .json({ error: "A registered, unrestricted device is required." });
      const lock = await acquire(db, user.uid);
      try {
        await db
          .collection("users")
          .updateOne(
            { uid: user.uid },
            { $pull: { devices: { id: req.params.id } } },
          );
        if (io) io.in(`account_${user.uid}`).disconnectSockets(true);
        res.json({ success: true });
      } finally {
        await lock.release();
      }
    }),
  );
  router.get(
    "/usage",
    require("../services/devices").guard(db),
    handle(async (req, res) =>
      res.json({ success: true, ...(await snapshot(db, req.member)) }),
    ),
  );
  return router;
};
