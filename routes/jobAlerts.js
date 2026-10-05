const express = require("express");
const { ObjectId } = require("mongodb");
const { gate } = require("../services/usage");
const { apiError } = require("../services/gemini");
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res
      .status(e.status || 503)
      .json({ error: e.status ? e.message : "Job alerts unavailable." });
  }
};
function clean(body) {
  const data = Object.fromEntries(
    ["name", "search", "location", "type", "experience"].map((k) => [
      k,
      String(body[k] || "")
        .trim()
        .slice(0, 150),
    ]),
  );
  if (
    !data.name ||
    ![data.search, data.location, data.type, data.experience].some(Boolean)
  )
    throw apiError(400, "Enter a name and at least one filter.");
  return { ...data, enabled: body.enabled !== false };
}
module.exports = (db) => {
  const router = express.Router();
  const c = db.collection("job_alerts");
  const owned = (req) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id))
      throw apiError(400, "Invalid alert.");
    return { _id: new ObjectId(req.params.id), userId: req.identity.uid };
  };
  router.get(
    "/",
    handle(async (req, res) => {
      const data = await require("../services/listPage")(
        c,
        { userId: req.identity.uid },
        req,
        { createdAt: -1 },
        undefined,
      );
      res.json({
        success: true,
        alerts: data.records,
        total: data.total,
        page: data.page,
      });
    }),
  );
  router.post(
    "/",
    gate(db, () => ({
      features: [],
      resources: [["alerts", "job_alerts", {}]],
    })),
    handle(async (req, res) => {
      const data = {
        ...clean(req.body),
        userId: req.identity.uid,
        email: req.member.email,
        createdAt: new Date(),
      };
      const r = await c.insertOne(data);
      res.json({ success: true, alert: { ...data, _id: r.insertedId } });
    }),
  );
  router.put(
    "/:id",
    handle(async (req, res) => {
      await c.updateOne(owned(req), { $set: clean(req.body) });
      res.json({ success: true });
    }),
  );
  router.delete(
    "/:id",
    handle(async (req, res) => {
      await c.deleteOne(owned(req));
      res.json({ success: true });
    }),
  );
  return router;
};
