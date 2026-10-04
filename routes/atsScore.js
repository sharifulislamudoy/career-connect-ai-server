const express = require("express");
const multer = require("multer");
const PDFParser = require("pdf2json");
const { ObjectId } = require("mongodb");
const aiAuth = require("../middleware/aiAuth");
const aiLimit = require("../middleware/aiLimit");
const { loadContext } = require("../services/aiContext");
const { generateJSON, schemas, apiError, validateAssessment } = require("../services/gemini");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, fieldSize: 12000 },
  fileFilter: (req, file, cb) => cb(file.mimetype === "application/pdf" ? null : apiError(400, "Only PDF files are allowed."), file.mimetype === "application/pdf") });

function parsePDF(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser();
    const timer = setTimeout(() => finish(apiError(400, "PDF parsing timed out. Try a smaller PDF.")), 15000);
    function finish(error, value) { clearTimeout(timer); error ? reject(error) : resolve(value); }
    parser.once("pdfParser_dataError", () => finish(apiError(400, "Unable to read this PDF.")));
    parser.once("pdfParser_dataReady", data => {
      try { finish(null, data.Pages.map(page => page.Texts.map(item => item.R.map(run => decodeURIComponent(run.T)).join("")).join(" ")).join("\n").trim()); }
      catch { finish(apiError(400, "Unable to extract PDF text.")); }
    });
    try { parser.parseBuffer(buffer); } catch { finish(apiError(400, "Invalid PDF file.")); }
  });
}

module.exports = (atsScoresCollection, db) => {
  const router = express.Router();
  router.use(aiAuth(db.collection("users")));
  const owned = req => ({ $or: [ { userId: req.aiIdentity.uid },
    ...(req.aiIdentity.email ? [{ userId: { $exists: false }, userEmail: req.aiIdentity.email }] : []) ] });

  router.post("/check-score", aiLimit, upload.single("resume"), async (req, res) => {
    try {
      if (!req.file) throw apiError(400, "Upload a resume PDF.");
      if (req.body.jobDescription && (typeof req.body.jobDescription !== "string" || req.body.jobDescription.length > 10000)) throw apiError(400, "Job description must be at most 10,000 characters.");
      const resumeText = await parsePDF(req.file.buffer);
      if (resumeText.length < 30) throw apiError(400, "Could not extract readable text. Use a text-based PDF instead of a scanned image.");
      const jobDescription = req.body.jobDescription || "";
      const context = await loadContext(db, req.aiUser, jobDescription, req.body.jobId);
      const analysis = validateAssessment(await generateJSON({ action: "ats_analysis", resumeText: resumeText.slice(0, 20000), jobDescription,
        instructions: "Assess this submitted resume with an estimated 0–100 ATS compatibility score. Prioritize supplied target description or selected job if present. Otherwise explain assessment is general and use relevant jobs only as examples. Analyze only visible text; do not claim to assess visual PDF layout or guarantee hiring outcomes. Give actionable suggestions, strengths, weaknesses, keywords found and missing. Never invent qualifications." }, context, schemas.ats));
      const result = await atsScoresCollection.insertOne({ userId: req.aiIdentity.uid, userEmail: req.aiIdentity.email,
        resumeText: resumeText.slice(0, 1000), fileName: req.file.originalname, fileSize: req.file.size,
        jobDescription, ...analysis, createdAt: new Date(), updatedAt: new Date() });
      res.json({ success: true, scoreId: result.insertedId, ...analysis, resumePreview: resumeText.slice(0, 500) });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to analyze resume. Please try again." });
    }
  });
  router.get("/history/:userEmail", async (req, res) => {
    if (req.params.userEmail !== req.aiIdentity.email) return res.status(403).json({ error: "You can only view your own ATS history." });
    try {
      const scores = await atsScoresCollection.find(owned(req)).sort({ createdAt: -1 }).limit(10).toArray();
      res.json({ success: true, scores: scores.map(score => ({ id: score._id, fileName: score.fileName, score: score.score,
        jobDescription: score.jobDescription, createdAt: score.createdAt, suggestions: score.suggestions })) });
    } catch { res.status(500).json({ error: "Failed to fetch ATS history." }); }
  });
  router.get("/score/:scoreId", async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.scoreId)) return res.status(400).json({ error: "Invalid score ID." });
    try {
      const score = await atsScoresCollection.findOne({ _id: new ObjectId(req.params.scoreId), ...owned(req) });
      if (!score) return res.status(404).json({ error: "Score not found." });
      res.json({ success: true, score: { ...score, id: score._id } });
    } catch { res.status(500).json({ error: "Failed to fetch ATS score." }); }
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "PDF must be smaller than 5 MB." : "Invalid upload. Upload one PDF smaller than 5 MB." });
  });
  return router;
};
