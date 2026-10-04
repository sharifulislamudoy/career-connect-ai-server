// Shared by AI generation and ATS generation. State is per server process.
const entries = new Map();
module.exports = (req, res, next) => {
  const now = Date.now();
  for (const [uid, entry] of entries) {
    if (!entry.busy && now - entry.start >= 60000) entries.delete(uid);
  }
  const uid = req.aiIdentity.uid;
  let entry = entries.get(uid);
  if (!entry) { entry = { start: now, count: 0, busy: false }; entries.set(uid, entry); }
  if (entry.busy) return res.status(429).json({ error: "Please wait for your current AI request to finish." });
  if (entry.count >= 10) {
    res.set("Retry-After", String(Math.max(1, Math.ceil((60000 - now + entry.start) / 1000))));
    return res.status(429).json({ error: "Too many AI requests. Please try again in a minute." });
  }
  entry.count++;
  entry.busy = true;
  const release = () => { entry.busy = false; };
  res.once("finish", release);
  res.once("close", release);
  next();
};
