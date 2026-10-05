const express = require("express");
const { catalog } = require("../config/plans");
const { snapshot } = require("../services/usage");
const billing = require("../services/billing");
module.exports = (users, payments, db) => {
  const router = express.Router();
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 503).json({
        success: false,
        error: e.status ? e.message : "Billing temporarily unavailable.",
      });
    }
  };
  router.get("/plans", (req, res) =>
    res.json({ success: true, currency: "bdt", plans: catalog() }),
  );
  router.get(
    "/status",
    handle(async (req, res) =>
      res.json({
        success: true,
        ...(await snapshot(db, req.member)),
        cancelAtPeriodEnd: req.member.cancelAtPeriodEnd || false,
      }),
    ),
  );
  router.post(
    "/checkout",
    handle(async (req, res) =>
      res.json({
        success: true,
        url: await billing.checkout(
          db,
          req.member,
          req.body.plan,
          req.body.billingCycle,
        ),
      }),
    ),
  );
  router.post(
    "/portal",
    handle(async (req, res) => {
      if (!req.member.stripeCustomerId)
        return res.status(400).json({ error: "No billing account yet." });
      const session = await billing.stripe().billingPortal.sessions.create({
        customer: req.member.stripeCustomerId,
        return_url: `${new URL(process.env.APP_URL || "http://localhost:5173").origin}/pricing`,
      });
      res.json({ success: true, url: session.url });
    }),
  );
  router.get(
    "/history",
    handle(async (req, res) =>
      res.json({
        success: true,
        payments: await payments
          .find({ userId: req.identity.uid })
          .sort({ completedAt: -1 })
          .limit(100)
          .toArray(),
      }),
    ),
  );
  router.get(
    "/user/:uid",
    handle(async (req, res) => {
      if (req.params.uid !== req.identity.uid)
        return res.status(403).json({ error: "Own billing history only." });
      res.json({
        success: true,
        payments: await payments
          .find({ userId: req.identity.uid })
          .sort({ completedAt: -1 })
          .limit(100)
          .toArray(),
      });
    }),
  );
  return router;
};
