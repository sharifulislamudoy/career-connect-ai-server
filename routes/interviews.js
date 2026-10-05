const express = require('express');
const { ObjectId } = require('mongodb');
const aiAuth = require('../middleware/aiAuth');
module.exports = (collection, db) => {
  const router = express.Router(); router.use(aiAuth(db.collection('users')));
  const handle = fn => async (req, res) => { try { await fn(req, res); } catch { res.status(503).json({ success: false, error: 'Interview storage is temporarily unavailable.' }); } };
  router.param('id', (req, res, next, id) => /^[a-f0-9]{24}$/i.test(id) ? next() : res.status(400).json({ error: 'Invalid interview ID.' }));
  const owned = req => ({ _id: new ObjectId(req.params.id), userId: req.aiIdentity.uid });
  router.get('/mine', handle(async (req, res) => { const interviews = await collection.find({ userId: req.aiIdentity.uid }, { projection: { questions: 0, answers: 0 } }).sort({ updatedAt: -1 }).limit(50).toArray(); res.json({ success: true, interviews }); }));
  router.get('/user/:email', handle(async (req, res) => { if (req.params.email !== req.aiIdentity.email) return res.status(403).json({ error: 'You can only view your own interviews.' }); res.json({ success: true, interviews: await collection.find({ userId: req.aiIdentity.uid }).sort({ updatedAt: -1 }).limit(50).toArray() }); }));
  router.post('/save', (req, res) => res.status(400).json({ error: 'Use the AI interview session endpoints. Scores are saved by the server after evaluation.' }));
  router.get('/stats/:email', handle(async (req, res) => {
    if (req.params.email !== req.aiIdentity.email) return res.status(403).json({ error: 'You can only view your own statistics.' });
    const interviews = await collection.find({ userId: req.aiIdentity.uid }).sort({ updatedAt: -1 }).toArray();
    const scored = interviews.filter(i => Number.isFinite(i.averageScore));
    res.json({ success: true, stats: { totalInterviews: interviews.length, completedInterviews: interviews.filter(i => i.status === 'completed').length, averageScore: scored.length ? scored.reduce((n, i) => n + i.averageScore, 0) / scored.length : null } });
  }));
  router.get('/:id', handle(async (req, res) => { const interview = await collection.findOne(owned(req)); if (!interview) return res.status(404).json({ error: 'Interview not found.' }); res.json({ success: true, interview }); }));
  router.delete('/:id', handle(async (req, res) => { const result = await collection.deleteOne(owned(req)); if (!result.deletedCount) return res.status(404).json({ error: 'Interview not found.' }); res.json({ success: true }); }));
  return router;
};
