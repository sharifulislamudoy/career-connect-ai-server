const express = require("express");
const { randomUUID } = require("crypto");
const aiAuth = require("../middleware/aiAuth");
const aiLimit = require("../middleware/aiLimit");
const { loadContext } = require("../services/aiContext");
const { generateJSON, schemas, apiError, assertResult, validStrings, validateAssessment } = require("../services/gemini");

function input(value, name, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw apiError(400, `${name} is required and must be at most ${max} characters.`);
  return value.trim();
}
const route = fn => async (req, res) => {
  try { await fn(req, res); } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.status ? error.message : "AI request failed. Please try again." });
  }
};

module.exports = db => {
  const router = express.Router();
  router.use(aiAuth(db.collection("users")), aiLimit);

  router.post("/chat", route(async (req, res) => {
    const message = input(req.body.message, "Message");
    const conversations = db.collection("ai_conversations");
    let conversation;
    if (req.body.conversationId) {
      const id = input(req.body.conversationId, "Conversation ID", 64);
      conversation = await conversations.findOne({ conversationId: id, userId: req.aiIdentity.uid });
      if (!conversation) throw apiError(404, "Conversation not found.");
    }
    const context = await loadContext(db, req.aiUser, message, req.body.jobId);
    context.HISTORY = conversation?.messages?.slice(-10) || [];
    const result = await generateJSON({ action: "career_chat", message,
      instructions: "Recommend only relevant JOBS from context. Return their exact IDs in recommendedJobIds. Use /jobs/ID links only for supplied jobs. Available platform links: /jobs, /create-resume, /ats-score, /mock-interview, /learning-path, /settings. Never claim this selection is the complete catalogue." }, context, schemas.chat);
    assertResult(result && typeof result.reply === "string" && result.reply.trim() && validStrings(result.recommendedJobIds));
    const allowed = new Map(context.JOBS.map(job => [job.id, job]));
    const recommendations = [...new Set(result.recommendedJobIds)].filter(id => allowed.has(id)).slice(0, 6).map(id => allowed.get(id));
    const reply = result.reply.replace(/\]\(\/jobs\/([^\s)]+)\)/g, (match, id) => allowed.has(id) ? match : "](/jobs)");
    const conversationId = conversation?.conversationId || randomUUID();
    const messages = [...(conversation?.messages || []).slice(-10), { role: "user", text: message }, { role: "assistant", text: reply }];
    await conversations.updateOne({ conversationId, userId: req.aiIdentity.uid }, {
      $set: { messages, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() },
    }, { upsert: true });
    res.json({ success: true, reply, conversationId, recommendations });
  }));

  router.post("/interview/questions", route(async (req, res) => {
    const topic = input(req.body.topic, "Topic", 200);
    const difficulty = req.body.difficulty || "beginner";
    const count = req.body.questionCount ?? 5;
    if (!["beginner", "intermediate", "advanced"].includes(difficulty) || !Number.isInteger(count) || count < 3 || count > 10) throw apiError(400, "Select a valid difficulty and 3–10 questions.");
    const context = await loadContext(db, req.aiUser, topic, req.body.jobId);
    const questions = await generateJSON({ action: "interview_questions", topic, difficulty, count,
      instructions: "Generate exactly count practical interview questions with 3–5 evaluationCriteria each. Tailor to the user's real profile and relevant job requirements. Do not assume missing qualifications." }, context, schemas.questions, 6000);
    assertResult(Array.isArray(questions) && questions.length === count && questions.every(q => typeof q.question === "string" && q.question.trim() && validStrings(q.evaluationCriteria) && q.evaluationCriteria.length >= 3));
    res.json({ success: true, questions });
  }));

  router.post("/interview/evaluate", route(async (req, res) => {
    const question = input(req.body.question, "Question", 2000);
    const answer = input(req.body.answer, "Answer", 10000);
    const criteria = req.body.criteria;
    if (!validStrings(criteria) || !criteria.length || criteria.length > 10 || criteria.some(item => item.length > 300)) throw apiError(400, "Invalid evaluation criteria.");
    const context = await loadContext(db, req.aiUser, question, req.body.jobId);
    const evaluation = validateAssessment(await generateJSON({ action: "interview_evaluation", question, answer, criteria,
      instructions: "Evaluate the actual submitted answer, score 0–10. Be constructive and do not award credit for missing content. Identify concrete strengths and improvements." }, context, schemas.evaluation), 10);
    res.json({ success: true, evaluation });
  }));

  router.post("/learning-path", route(async (req, res) => {
    const title = input(req.body.title, "Career title", 200);
    const days = req.body.days;
    if (![30, 60, 90, 180, 365].includes(days)) throw apiError(400, "Select a supported learning duration.");
    const weeks = Math.ceil(days / 7);
    const context = await loadContext(db, req.aiUser, title, req.body.jobId);
    const data = await generateJSON({ action: "learning_path", title, days, weeks,
      instructions: `Generate exactly ${weeks} weeklySchedule entries numbered 1–${weeks}, each with 3–5 actionable tasks, topics, a milestone and realistic hoursRequired. Include 3–6 overall milestones numbered within these weeks, each with tasks. Include 3–8 skillBreakdown entries with percentages totalling 100. Personalize learning gaps using only this user's existing skills and relevant jobs. Avoid fabricated course URLs. This is a planned schedule, not completed progress.` }, context, schemas.learning, 18000);
    assertResult(data && Array.isArray(data.weeklySchedule) && data.weeklySchedule.length === weeks);
    data.weeklySchedule.sort((a, b) => a.week - b.week);
    assertResult(data.weeklySchedule.every((week, index) => week.week === index + 1 && validStrings(week.topics) && week.topics.length && validStrings(week.tasks) && week.tasks.length >= 3 && typeof week.milestone === "string" && Number.isFinite(week.hoursRequired) && week.hoursRequired > 0));
    assertResult(Array.isArray(data.milestones) && data.milestones.length >= 3 && data.milestones.every(m => Number.isInteger(m.week) && m.week >= 1 && m.week <= weeks && typeof m.title === "string" && typeof m.description === "string" && validStrings(m.tasks) && m.tasks.length));
    assertResult(Array.isArray(data.skillBreakdown) && data.skillBreakdown.length >= 3 && data.skillBreakdown.every(s => typeof s.skill === "string" && Number.isFinite(s.percentage) && s.percentage > 0));
    const total = data.skillBreakdown.reduce((sum, skill) => sum + skill.percentage, 0);
    const colors = ["#6366f1", "#14b8a6", "#f59e0b", "#ec4899", "#8b5cf6", "#0ea5e9", "#22c55e", "#f97316"];
    const dailyTasks = Array.from({ length: days }, (_, index) => {
      const week = data.weeklySchedule[Math.floor(index / 7)];
      return { day: index + 1, task: week.tasks[(index % 7) % week.tasks.length], topics: week.topics,
        resources: [], completionTime: Math.round(week.hoursRequired * 60 / Math.min(7, days - (week.week - 1) * 7)) };
    });
    res.json({ success: true, learningPath: {
      title, duration: `${days} days`, totalDays: days,
      weeklySchedule: data.weeklySchedule, dailyTasks,
      milestones: data.milestones.map(m => ({ ...m, achieved: false })),
      skillBreakdown: data.skillBreakdown.map((skill, index) => ({ ...skill, percentage: skill.percentage * 100 / total, color: colors[index % colors.length] })),
      progressData: Array.from({ length: days }, (_, index) => ({ day: index + 1, progress: 0, topicsCompleted: 0 })),
    } });
  }));
  return router;
};
