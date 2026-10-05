const express = require("express");
const { ObjectId } = require("mongodb");
const { generatePlan, languageTag } = require("../services/careerLearning");
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
  router.use(aiAuth(db.collection("users")));
  router.use((req, res, next) => req.method === "POST" ? aiLimit(req, res, next) : next());

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
      instructions: "Use current OWN_RESUME, OWN_CV, OWN_ATS, OWN_INTERVIEWS and OWN_LEARNING_PATHS as the latest evidence. Prefer current stored data over older HISTORY. Distinguish planned/self-reported learning from verified competence. When Resume and CV conflict ask which is current, rather than silently combining them. Never invent skills, merge old resume variants, or claim model training. When OWN_RESUME is absent, explain that no saved Coach-enabled resume is available if resume advice is requested. Recommend only relevant JOBS from context. Return their exact IDs in recommendedJobIds. Use /jobs/ID links only for supplied jobs. Available platform links: /jobs, /create-resume, /ats-score, /mock-interview, /learning-path, /create-cv, /settings. Never claim this selection is the complete catalogue." }, context, schemas.chat);
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

  router.post("/interview/start", route(async (req, res) => {
    const topic = input(req.body.topic, "Interview topic", 200);
    const difficulty = req.body.difficulty || "beginner";
    const questionCount = req.body.questionCount ?? 5;
    const language = languageTag(req.body.language);
    const mode = ["text", "voice", "video"].includes(req.body.mode) ? req.body.mode : "voice";
    if (!["beginner", "intermediate", "advanced"].includes(difficulty) || !Number.isInteger(questionCount) || questionCount < 3 || questionCount > 10) throw apiError(400, "Choose a level and 3–10 questions.");
    const context = await loadContext(db, req.aiUser, topic);
    const questions = await generateJSON({ action: "interview_questions", topic, difficulty, count: questionCount, language,
      instructions: `Conduct an AI practice interview in ${language}. Generate exactly ${questionCount} distinct questions with 3–5 specific evaluationCriteria each. Use a natural interview flow: fundamentals, applied scenarios and trade-offs appropriate to ${difficulty}. Personalize using recorded career context without inventing experience. Keep every question under 1500 characters and each criterion under 300. Do not grade accent, identity, appearance or facial expression.` }, context, schemas.questions, 8000);
    assertResult(Array.isArray(questions) && questions.length === questionCount && questions.every(q => typeof q.question === "string" && q.question.trim() && q.question.length <= 1500 && validStrings(q.evaluationCriteria) && q.evaluationCriteria.length >= 3 && q.evaluationCriteria.length <= 5 && q.evaluationCriteria.every(c => c.trim() && c.length <= 300)));
    const now = new Date();
    const session = { userId: req.aiIdentity.uid, interviewConfig: { topic, difficulty, questionCount, language, mode }, questions, answers: [], status: "in_progress", averageScore: null, coachEnabled: true, version: 0, createdAt: now, updatedAt: now };
    const result = await db.collection("interviews").insertOne(session);
    res.status(201).json({ success: true, session: { ...session, _id: result.insertedId } });
  }));
  router.post("/interview/:id/answer", route(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw apiError(400, "Invalid interview ID.");
    const collection = db.collection("interviews");
    const filter = { _id: new ObjectId(req.params.id), userId: req.aiIdentity.uid };
    const session = await collection.findOne(filter);
    if (!session) throw apiError(404, "Interview not found.");
    const index = session.answers.length;
    if (session.status === "completed" || req.body.questionIndex !== index) throw apiError(409, "This question was already submitted. Reload the saved interview.");
    const answer = input(req.body.answer, "Answer transcript", 10000);
    const question = session.questions[index];
    const context = await loadContext(db, req.aiUser, session.interviewConfig.topic);
    const evaluation = validateAssessment(await generateJSON({ action: "interview_evaluation", question: question.question, answer, criteria: question.evaluationCriteria,
      instructions: `Evaluate only this reviewed answer transcript, score 0–10. Respond in ${session.interviewConfig.language}. Explain specific strengths, missing concepts and an actionable next practice exercise. Calibrate to ${session.interviewConfig.difficulty}. Do not infer technical ability from accent, speech-recognition errors, video appearance or confidence. Do not award credit for absent content.` }, context, schemas.evaluation), 10);
    const answers = [...session.answers, { questionIndex: index, question: question.question, answer, evaluation, answeredAt: new Date() }];
    const averageScore = Math.round(answers.reduce((total, item) => total + item.evaluation.score, 0) / answers.length * 10) / 10;
    const update = { answers, averageScore, status: answers.length === session.questions.length ? "completed" : "in_progress", updatedAt: new Date(), version: session.version + 1 };
    const result = await collection.updateOne({ ...filter, version: session.version }, { $set: update });
    if (!result.matchedCount) throw apiError(409, "Interview changed in another tab. Reload it before continuing.");
    res.json({ success: true, session: { ...session, ...update } });
  }));
  router.post("/learning-path", route(async (req, res) => {
    const skill = input(req.body.skill || req.body.title, "Skill", 200);
    const context = await loadContext(db, req.aiUser, skill);
    const plan = await generatePlan(req.body, context);
    const now = new Date();
    const doc = { ...plan, userId: req.aiIdentity.uid, createdAt: now, updatedAt: now };
    const result = await db.collection("learning_paths").insertOne(doc);
    res.status(201).json({ success: true, learningPath: { ...doc, _id: result.insertedId } });
  }));
  router.get("/learning-paths", route(async (req, res) => {
    const plans = await db.collection("learning_paths").find({ userId: req.aiIdentity.uid }, { projection: { weeklySchedule: 0 } }).sort({ updatedAt: -1 }).limit(50).toArray();
    res.json({ success: true, plans });
  }));
  router.get("/learning-path/:id", route(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw apiError(400, "Invalid learning path ID.");
    const plan = await db.collection("learning_paths").findOne({ _id: new ObjectId(req.params.id), userId: req.aiIdentity.uid });
    if (!plan) throw apiError(404, "Learning path not found.");
    res.json({ success: true, learningPath: plan });
  }));
  router.patch("/learning-path/:id/progress", route(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw apiError(400, "Invalid learning path ID.");
    const collection = db.collection("learning_paths"); const filter = { _id: new ObjectId(req.params.id), userId: req.aiIdentity.uid };
    const plan = await collection.findOne(filter); if (!plan) throw apiError(404, "Learning path not found.");
    const taskId = req.body.taskId;
    if (typeof req.body.completed !== "boolean" || !plan.weeklySchedule.some(week => week.tasks.some(task => task.id === taskId))) throw apiError(400, "Select a valid task and completion state.");
    const completed = new Set(plan.completedTaskIds || []); req.body.completed ? completed.add(taskId) : completed.delete(taskId);
    const update = { completedTaskIds: [...completed], updatedAt: new Date(), version: plan.version + 1 };
    const result = await collection.updateOne({ ...filter, version: plan.version }, { $set: update });
    if (!result.matchedCount) throw apiError(409, "Progress changed in another tab. Reload this plan.");
    res.json({ success: true, learningPath: { ...plan, ...update } });
  }));
  router.delete("/learning-path/:id", route(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw apiError(400, "Invalid learning path ID.");
    const result = await db.collection("learning_paths").deleteOne({ _id: new ObjectId(req.params.id), userId: req.aiIdentity.uid });
    if (!result.deletedCount) throw apiError(404, "Learning path not found.");
    res.json({ success: true });
  }));
  return router;
};
