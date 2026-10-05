const express = require('express');
const multer = require('multer');
const {
  ObjectId
} = require('mongodb');
const aiAuth = require('../middleware/aiAuth');
const aiLimit = require('../middleware/aiLimit');
const {
  apiError
} = require('../services/gemini');
const {
  parsePDF,
  analyzeResume
} = require('../services/atsAnalysis');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fields: 5,
    fieldSize: 60000
  },
  fileFilter: (req, file, cb) => cb(file.mimetype === 'application/pdf' ? null : apiError(400, 'Only PDF uploads are supported.'), file.mimetype === 'application/pdf')
});
const handle = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    res.status(error.status || 503).json({
      error: error.status ? error.message : 'Unable to process resume. Please retry.'
    });
  }
};
module.exports = (collection, db) => {
  const router = express.Router();
  router.use(aiAuth(db.collection('users')));
  const owned = req => ({
    $or: [{
      userId: req.aiIdentity.uid
    }, ...(req.aiIdentity.email ? [{
      userId: {
        $exists: false
      },
      userEmail: req.aiIdentity.email
    }] : [])]
  });
  router.post('/extract', aiLimit, upload.single('resume'), handle(async (req, res) => {
    if (!req.file) throw apiError(400, 'Upload a PDF.');
    res.json({
      success: true,
      ...(await parsePDF(req.file.buffer)),
      fileName: req.file.originalname
    });
  }));
  router.post('/check-score', aiLimit, upload.single('resume'), handle(async (req, res) => {
    let resumeText = req.body.resumeText;
    let links = [];
    if (Array.isArray(req.body.links)) links = req.body.links.slice(0, 200).filter(link => link && typeof link.url === 'string' && /^(https?:\/\/|mailto:)/i.test(link.url)).map(link => ({ url: link.url.slice(0, 3000), page: Number.isInteger(link.page) ? link.page : null }));
    let source = 'User-reviewed text';
    let fileName = typeof req.body.fileName === 'string' ? req.body.fileName.trim().slice(0, 180) || 'Pasted resume' : 'Pasted resume';
    if (req.file) {
      const extracted = await parsePDF(req.file.buffer);
      resumeText = extracted.text;
      links = extracted.links;
      fileName = req.file.originalname;
      source = 'PDF extraction (unreviewed)';
    }
    if (typeof resumeText !== 'string' || resumeText.length > 60000 || !resumeText.trim()) throw apiError(400, 'Submit readable resume text, at most 60,000 characters.');
    const jobDescription = req.body.jobDescription || '';
    const targetKeywords = req.body.targetKeywords || '';
    if (typeof jobDescription !== 'string' || jobDescription.length > 10000 || typeof targetKeywords !== 'string' || targetKeywords.length > 2000) throw apiError(400, 'Job description limit is 10,000 characters; keyword limit is 2,000.');
    const analysis = analyzeResume(resumeText, jobDescription, targetKeywords);
    const now = new Date();
    const stored = {
      ...analysis, links,
      userId: req.aiIdentity.uid,
      userEmail: req.aiIdentity.email,
      fileName,
      source,
      resumeText,
      jobDescription,
      targetKeywords,
      createdAt: now,
      updatedAt: now
    };
    const result = await collection.insertOne(stored);
    res.json({
      success: true,
      ...analysis, links,
      scoreId: result.insertedId,
      source,
      resumeText
    });
  }));
  router.get('/history/:userEmail', handle(async (req, res) => {
    if (req.params.userEmail !== req.aiIdentity.email) return res.status(403).json({
      error: 'You can only view your own ATS history.'
    });
    const scores = await collection.find(owned(req), {
      projection: {
        fileName: 1,
        score: 1,
        createdAt: 1,
        method: 1,
        assessmentType: 1
      }
    }).sort({
      createdAt: -1
    }).limit(30).toArray();
    res.json({
      success: true,
      scores: scores.map(s => ({
        ...s,
        id: s._id
      }))
    });
  }));
  router.get('/score/:scoreId', handle(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.scoreId)) throw apiError(400, 'Invalid score ID.');
    const score = await collection.findOne({
      _id: new ObjectId(req.params.scoreId),
      ...owned(req)
    });
    if (!score) throw apiError(404, 'Score not found.');
    res.json({
      success: true,
      score
    });
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(400).json({
      error: error.code === 'LIMIT_FILE_SIZE' ? 'PDF must be 5 MB or smaller.' : 'Invalid upload. Use one PDF up to 5 MB.'
    });
  });
  return router;
};
