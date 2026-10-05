const { validatePhotoUrl, loadPhoto } = require('../services/cvPhoto');
const express = require('express');
const {
  ObjectId
} = require('mongodb');
const aiAuth = require('../middleware/aiAuth');
const {
  normalizeResume,
  validateResume,
  createResumePDF
} = require('../services/resumeDocument');
module.exports = db => {
  const router = express.Router();
  const collection = db.collection('resumes');
  router.use(aiAuth(db.collection('users')));
  router.param('id', (req, res, next, id) => /^[a-f0-9]{24}$/i.test(id) ? next() : res.status(400).json({
    error: 'Invalid resume ID.'
  }));
  const owned = req => ({
    _id: new ObjectId(req.params.id),
    userId: req.aiIdentity.uid
  });
  const readData = (req, res, complete = false) => {
    try {
      const data = normalizeResume(req.body);
      validateResume(data, complete);
      validatePhotoUrl(data.photoUrl);
      return data;
    } catch (error) {
      res.status(400).json({
        error: error.message
      });
      return null;
    }
  };
  router.get('/user/:userId', async (req, res) => {
    if (req.params.userId !== req.aiIdentity.uid) return res.status(403).json({
      error: 'You can only access your own resumes.'
    });
    try {
      res.json(await collection.find({
        userId: req.aiIdentity.uid
      }).sort({
        updatedAt: -1,
        _id: -1
      }).toArray());
    } catch {
      res.status(503).json({
        error: 'Unable to load saved resumes.'
      });
    }
  });
  router.post('/', async (req, res) => {
    const data = readData(req, res);
    if (!data) return;
    try {
      const now = new Date();
      const result = await collection.insertOne({
        ...data,
        userId: req.aiIdentity.uid,
        createdAt: now,
        updatedAt: now
      });
      res.status(201).json({
        success: true,
        id: result.insertedId
      });
    } catch {
      res.status(503).json({
        error: 'Unable to save resume. Please retry.'
      });
    }
  });
  router.put('/:id', async (req, res) => {
    const data = readData(req, res);
    if (!data) return;
    try {
      const result = await collection.updateOne(owned(req), {
        $set: {
          ...data,
          updatedAt: new Date()
        }
      });
      if (!result.matchedCount) return res.status(404).json({
        error: 'Resume not found.'
      });
      res.json({
        success: true,
        id: req.params.id
      });
    } catch {
      res.status(503).json({
        error: 'Unable to update resume.'
      });
    }
  });
  router.post('/generate-pdf', async (req, res) => {
    const data = readData(req, res, true);
    if (!data) return;
    // Core PDF fonts cannot represent Bangla. Reject instead of silently corrupting text.
    if (/[^\u0000-\u024f\u2000-\u206f\u20ac\u2122\u2212]/u.test(JSON.stringify(data))) return res.status(400).json({
      error: 'This template supports English/Latin text. Use English for this ATS resume.'
    });
    try {
      const photoBuffer = data.documentType === "cv" ? await loadPhoto(data.photoUrl) : undefined;
      const doc = createResumePDF(data, { photoBuffer });
      const chunks = [];
      const buffer = await new Promise((resolve, reject) => {
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
      });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${data.personal.name.replace(/[^a-z0-9_-]/gi, '_')}_${data.documentType === 'cv' ? 'CV' : 'Resume'}.pdf"`);
      res.send(buffer);
    } catch (error) {
      res.status(error.status || 400).json({ error: error.message || 'Unable to export PDF.' });
    }
  });
  router.get('/:id', async (req, res) => {
    try {
      const resume = await collection.findOne(owned(req));
      if (!resume) return res.status(404).json({
        error: 'Resume not found.'
      });
      res.json(resume);
    } catch {
      res.status(503).json({
        error: 'Unable to load resume.'
      });
    }
  });
  router.delete('/:id', async (req, res) => {
    try {
      const result = await collection.deleteOne(owned(req));
      if (!result.deletedCount) return res.status(404).json({
        error: 'Resume not found.'
      });
      res.json({
        success: true
      });
    } catch {
      res.status(503).json({
        error: 'Unable to delete resume.'
      });
    }
  });
  return router;
};
