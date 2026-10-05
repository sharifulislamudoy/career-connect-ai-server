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
      .json({ error: e.status ? e.message : "Workspace unavailable." });
  }
};
const id = (value) => {
  if (!/^[a-f0-9]{24}$/i.test(value)) throw apiError(400, "Invalid item.");
  return new ObjectId(value);
};
function clean(body) {
  const title = String(body.title || "")
    .trim()
    .slice(0, 200);
  const company = String(body.company || "")
    .trim()
    .slice(0, 200);
  if (!title || !company)
    throw apiError(400, "Job title and company are required.");
  let url = String(body.url || "").trim();
  if (url && !/^https?:\/\/\S+$/i.test(url))
    throw apiError(400, "Use an http/https job URL.");
  const status = [
    "saved",
    "applied",
    "interview",
    "offer",
    "rejected",
  ].includes(body.status)
    ? body.status
    : "saved";
  const date = body.followUpAt ? new Date(body.followUpAt) : null;
  if (date && Number.isNaN(date.getTime()))
    throw apiError(400, "Invalid reminder date.");
  return {
    title,
    company,
    url: url.slice(0, 2000),
    status,
    notes: String(body.notes || "").slice(0, 5000),
    followUpAt: date,
    archived: body.archived === true,
    reminderSent: false,
    updatedAt: new Date(),
  };
}
module.exports = (db) => {
  const router = express.Router();
  const collection = db.collection("application_workspace");
  router.get(
    "/",
    handle(async (req, res) => {
      const data = await require("../../Career_Connect_AI_Required_Files/server/services/listPage")(
        collection,
        { userId: req.identity.uid },
        req,
        { updatedAt: -1 },
        undefined,
      );
      res.json({
        success: true,
        items: data.records,
        total: data.total,
        page: data.page,
      });
    }),
  );
  router.post(
    "/",
    gate(db, () => ({
      features: [],
      resources: [
        ["workspace", "application_workspace", { archived: { $ne: true } }],
      ],
    })),
    handle(async (req, res) => {
      const data = {
        ...clean(req.body),
        userId: req.identity.uid,
        createdAt: new Date(),
      };
      const r = await collection.insertOne(data);
      res.json({ success: true, item: { ...data, _id: r.insertedId } });
    }),
  );
  router.put(
    "/:id",
    gate(db, async (req) => {
      const old = await collection.findOne({
        _id: id(req.params.id),
        userId: req.identity.uid,
      });
      if (!old) throw apiError(404, "Entry not found.");
      return {
        features: [],
        resources:
          old.archived && req.body.archived !== true
            ? [
                [
                  "workspace",
                  "application_workspace",
                  { archived: { $ne: true } },
                ],
              ]
            : [],
      };
    }),
    handle(async (req, res) => {
      const r = await collection.findOneAndUpdate(
        { _id: id(req.params.id), userId: req.identity.uid },
        { $set: clean(req.body) },
        { returnDocument: "after" },
      );
      res.json({ success: true, item: r });
    }),
  );
  router.delete(
    "/:id",
    handle(async (req, res) => {
      await collection.deleteOne({
        _id: id(req.params.id),
        userId: req.identity.uid,
      });
      res.json({ success: true });
    }),
  );
  return router;
};
