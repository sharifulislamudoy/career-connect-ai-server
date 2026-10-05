const { gate } = require("../services/usage");
const { catalog } = require("../config/plans");
const { apiError } = require("../services/gemini");
function documentAccess(body, plan) {
  const allowed = catalog().find((item) => item.id === plan);
  if (!allowed.templates.includes(body.template || "ats"))
    throw apiError(403, "Upgrade to use this template.");
  if (
    body.customStyle &&
    Object.keys(body.customStyle).length &&
    !allowed.customStyle
  )
    throw apiError(403, "Custom document styling requires Premium.");
}
async function checkDocument(db, req, plan) {
  try {
    documentAccess(req.body || {}, plan);
  } catch (error) {
    const id =
      req.path.toLowerCase().replace(/\/+$/, "") === "/resumes/generate-pdf"
        ? req.body._id
        : req.path.split("/")[2];
    if (!/^[a-f0-9]{24}$/i.test(id || "")) throw error;
    const { ObjectId } = require("mongodb");
    const existing = await db
      .collection("resumes")
      .findOne({ _id: new ObjectId(id), userId: req.identity.uid });
    // Existing saved formats remain editable/exportable after a downgrade; new formats are gated.
    if (
      !existing ||
      (existing.template || "ats") !== (req.body.template || "ats") ||
      JSON.stringify(existing.customStyle || {}) !==
        JSON.stringify(req.body.customStyle || {})
    )
      throw error;
  }
}
function resolver(db) {
  return async (req, user, plan) => {
    const path = req.path.toLowerCase().replace(/\/+$/, "") || "/";
    const body = req.body || {};
    if (req.method === "POST" && path === "/ai/chat")
      return { features: ["chat"] };
    if (
      req.method === "POST" &&
      ["/ai/interview/start", "/ai/interview/questions"].includes(path)
    )
      return {
        features: ["interviews"],
        validate() {
          const count = body.questionCount ?? 5;
          if (plan === "basic" && count > 5)
            throw apiError(403, "Basic supports up to five questions.");
          if (
            !catalog()
              .find((p) => p.id === plan)
              .modes.includes(body.mode || "text")
          )
            throw apiError(
              403,
              "This interview mode requires an upgraded plan.",
            );
        },
      };
    if (
      req.method === "POST" &&
      (/^\/ai\/interview\/[^/]+\/answer$/.test(path) ||
        path === "/ai/interview/evaluate")
    )
      return {
        features: [],
        validate: async () => {
          if (path.endsWith("/evaluate"))
            throw apiError(
              400,
              "Use a saved interview session for evaluations.",
            );
          // Answers to already-created sessions remain available after a downgrade.
        },
      };
    if (req.method === "POST" && path === "/ai/learning-path")
      return { features: ["learning"] };
    if (req.method === "POST" && path === "/resumes")
      return {
        features: [],
        resources: [["documents", "resumes", {}]],
        validate: () => checkDocument(db, req, plan),
      };
    if (
      (req.method === "PUT" && /^\/resumes\/[^/]+$/.test(path)) ||
      (req.method === "POST" && path === "/resumes/generate-pdf")
    )
      return { features: [], validate: () => checkDocument(db, req, plan) };
    if (req.method === "POST" && path === "/ats/check-score") return null; // Multipart fields are inspected inside the ATS route.
    return null;
  };
}
module.exports = (db) => {
  const check = gate(db, resolver(db));
  return (req, res, next) => {
    const p = req.path.toLowerCase().replace(/\/+$/, "") || "/";
    const guarded =
      (req.method === "POST" &&
        ([
          "/ai/chat",
          "/ai/interview/start",
          "/ai/interview/questions",
          "/ai/interview/evaluate",
          "/ai/learning-path",
          "/resumes",
          "/resumes/generate-pdf",
        ].includes(p) ||
          /^\/ai\/interview\/[^/]+\/answer$/.test(p))) ||
      (req.method === "PUT" && /^\/resumes\/[^/]+$/.test(p));
    return guarded ? check(req, res, next) : next();
  };
};
module.exports.documentAccess = documentAccess;
