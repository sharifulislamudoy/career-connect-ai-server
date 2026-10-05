const express = require("express");
const { ObjectId } = require("mongodb");
const { generateJSON, apiError } = require("../services/gemini");
const { loadContext } = require("../services/aiContext");
const { gate } = require("../services/usage");
const { effectivePlan } = require("../config/plans");
const { normalizeResume } = require("../services/resumeDocument");
const tools = {
  "cover-letter": {
    feature: "coverLetter",
    instruction:
      "Write a concise job-specific cover letter using only recorded qualifications. Name specific matches and avoid invented achievements.",
  },
  "resume-tailoring": {
    feature: "tailoring",
    instruction:
      "Tailor the selected resume to the supplied job description. Reorder emphasis and rewrite descriptions without inventing experience, skills, metrics, dates or qualifications. Explain keywords that are genuinely supported and missing qualifications.",
  },
  "resume-rewrite": {
    feature: "rewrite",
    instruction:
      "Improve the supplied summary or experience bullet using actual resume evidence. Provide clear action-oriented alternatives without inventing numbers or achievements.",
  },
  "job-match": {
    feature: "jobMatch",
    instruction:
      "Compare the user to the supplied job description. Explain demonstrated matches, missing skills and unknown requirements. Estimate fit conservatively; no prediction of selection.",
  },
  "skill-gap": {
    feature: "skillGap",
    instruction:
      "Identify skill gaps for the target role, distinguishing unknown skills from demonstrated weaknesses. Prioritize a practical learning plan and project exercises.",
  },
  linkedin: {
    feature: "linkedin",
    instruction:
      "Draft a LinkedIn headline, About section and experience descriptions based only on supplied facts. Do not claim to edit LinkedIn or view external profiles.",
  },
  "salary-negotiation": {
    feature: "negotiation",
    instruction:
      "Provide a salary negotiation email and practice dialogue based on the user supplied offer and goals. Do not invent market salary data. Make assumptions explicit.",
  },
  "weekly-plan": {
    feature: "weeklyPlan",
    instruction:
      "Create a seven-day career action plan from current resume, interview weaknesses, applications and self-reported learning progress. Include realistic daily priorities and checkpoints.",
  },
};
const string = { type: "STRING" };
const reportSchema = {
  type: "OBJECT",
  properties: {
    title: string,
    summary: string,
    draft: string,
    score: { type: "NUMBER" },
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          heading: string,
          items: { type: "ARRAY", items: string },
        },
        required: ["heading", "items"],
      },
    },
    resumeEdits: {
      type: "OBJECT",
      properties: {
        summary: string,
        experience: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { index: { type: "INTEGER" }, description: string },
            required: ["index", "description"],
          },
        },
        projects: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              index: { type: "INTEGER" },
              description: string,
              achievements: string,
            },
            required: ["index", "description", "achievements"],
          },
        },
      },
      required: ["summary", "experience", "projects"],
    },
  },
  required: ["title", "summary", "draft", "sections"],
};
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(e.status || 503).json({
      success: false,
      error: e.status ? e.message : "Career tool unavailable. Retry shortly.",
    });
  }
};
function objectId(value) {
  if (!ObjectId.isValid(value) || !/^[a-f0-9]{24}$/i.test(value))
    throw apiError(400, "Invalid item ID.");
  return new ObjectId(value);
}
module.exports = (db) => {
  const router = express.Router();
  router.use(require("../middleware/aiAuth")(db.collection("users")));
  router.get("/catalog", (req, res) =>
    res.json({
      success: true,
      tools: Object.entries(tools).map(([id, t]) => ({
        id,
        feature: t.feature,
      })),
    }),
  );
  router.get(
    "/reports",
    handle(async (req, res) => {
      const data = await require("../services/listPage")(
        db.collection("career_reports"),
        { userId: req.identity.uid },
        req,
        { createdAt: -1 },
        { document: 0 },
      );
      res.json({
        success: true,
        reports: data.records,
        total: data.total,
        page: data.page,
      });
    }),
  );
  router.get(
    "/reports/:id",
    handle(async (req, res) => {
      const report = await db
        .collection("career_reports")
        .findOne({ _id: objectId(req.params.id), userId: req.identity.uid });
      if (!report) throw apiError(404, "Report not found.");
      res.json({ success: true, report });
    }),
  );
  router.delete(
    "/reports/:id",
    handle(async (req, res) => {
      await db
        .collection("career_reports")
        .deleteOne({ _id: objectId(req.params.id), userId: req.identity.uid });
      res.json({ success: true });
    }),
  );
  router.post(
    "/generate/:tool",
    require("../middleware/aiLimit"),
    gate(db, (req) => {
      const tool = tools[req.params.tool];
      if (!tool) throw apiError(404, "Unknown career tool.");
      return { features: [tool.feature] };
    }),
    handle(async (req, res) => {
      const tool = tools[req.params.tool];
      const prompt = String(req.body.prompt || "").trim();
      const description = String(req.body.jobDescription || "").trim();
      if (prompt.length > 10000 || description.length > 10000)
        throw apiError(400, "Keep each input under 10,000 characters.");
      if (
        ["cover-letter", "resume-tailoring", "job-match"].includes(
          req.params.tool,
        ) &&
        description.length < 40
      )
        throw apiError(
          400,
          "Paste a job description with at least 40 characters.",
        );
      const user = req.member;
      const context = await loadContext(db, user, prompt || description);
      if (req.body.resumeId) {
        const document = await db
          .collection("resumes")
          .findOne({ _id: objectId(req.body.resumeId), userId: user.uid });
        if (!document) throw apiError(404, "Resume not found.");
        context.SELECTED_RESUME = normalizeResume(document);
      }
      if (req.params.tool === "resume-tailoring" && !context.SELECTED_RESUME)
        throw apiError(400, "Select a saved resume to tailor.");
      if (req.params.tool === "weekly-plan") {
        context.OWN_APPLICATIONS = await db
          .collection("applications")
          .find({ jobSeekerId: user.uid })
          .sort({ appliedAt: -1 })
          .limit(20)
          .toArray();
        context.OWN_WORKSPACE = await db
          .collection("application_workspace")
          .find({ userId: user.uid, archived: { $ne: true } })
          .limit(30)
          .toArray();
      }
      const result = await generateJSON(
        {
          action: req.params.tool,
          instructions:
            tool.instruction +
            " Return title, summary, draft and useful sections. For job-match return score from 0 to 100. For resume-tailoring ALSO return resumeEdits with a summary and descriptions keyed by original zero-based array index. Keep original facts intact. For all other tools omit resumeEdits.",
          prompt,
          jobDescription: description,
        },
        context,
        reportSchema,
        7000,
      );
      if (
        typeof result.title !== "string" ||
        typeof result.summary !== "string" ||
        typeof result.draft !== "string" ||
        !Array.isArray(result.sections) ||
        result.sections.length > 20 ||
        result.sections.some(
          (s) =>
            typeof s.heading !== "string" ||
            !Array.isArray(s.items) ||
            s.items.some((i) => typeof i !== "string"),
        )
      )
        throw apiError(502, "AI returned an invalid report.");
      if (
        req.params.tool === "job-match" &&
        (!Number.isFinite(result.score) ||
          result.score < 0 ||
          result.score > 100)
      )
        throw apiError(502, "AI returned an invalid fit estimate.");
      let document;
      if (req.params.tool === "resume-tailoring") {
        const edits = result.resumeEdits;
        if (
          !edits ||
          typeof edits.summary !== "string" ||
          !Array.isArray(edits.experience) ||
          !Array.isArray(edits.projects)
        )
          throw apiError(502, "Missing tailored resume edits.");
        document = structuredClone(context.SELECTED_RESUME);
        document.personal.summary = edits.summary;
        for (const edit of edits.experience) {
          if (
            !Number.isInteger(edit.index) ||
            !document.experience[edit.index] ||
            typeof edit.description !== "string"
          )
            throw apiError(502, "Invalid experience edit.");
          document.experience[edit.index].description = edit.description;
        }
        for (const edit of edits.projects) {
          if (
            !Number.isInteger(edit.index) ||
            !document.projects[edit.index] ||
            typeof edit.description !== "string" ||
            typeof edit.achievements !== "string"
          )
            throw apiError(502, "Invalid project edit.");
          Object.assign(document.projects[edit.index], {
            description: edit.description,
            achievements: edit.achievements,
          });
        }
        document = normalizeResume({
          ...document,
          title: `${document.title} — tailored`,
        });
      }
      const report = {
        ...result,
        document,
        userId: user.uid,
        tool: req.params.tool,
        sourceResumeId: req.body.resumeId || null,
        jobDescription: description,
        createdAt: new Date(),
      };
      const inserted = await db.collection("career_reports").insertOne(report);
      res.json({
        success: true,
        report: { ...report, _id: inserted.insertedId },
      });
    }),
  );
  router.get(
    "/progress",
    handle(async (req, res) => {
      const uid = req.identity.uid;
      const plan = effectivePlan(req.member);
      const interviews = await db
        .collection("interviews")
        .find({ userId: uid })
        .sort({ createdAt: 1 })
        .toArray();
      const completed = interviews.filter((i) => i.status === "completed");
      const paths = await db
        .collection("learning_paths")
        .find({ userId: uid })
        .toArray();
      const trends =
        plan === "basic"
          ? []
          : completed.map((i) => ({
              date: i.createdAt,
              topic: i.interviewConfig?.topic,
              score: i.averageScore,
            }));
      const improvements =
        plan === "premium"
          ? interviews
              .flatMap((i) =>
                (i.answers || []).flatMap(
                  (a) => a.evaluation?.improvements || [],
                ),
              )
              .reduce(
                (map, item) => ({ ...map, [item]: (map[item] || 0) + 1 }),
                {},
              )
          : {};
      res.json({
        success: true,
        plan,
        documents: await db
          .collection("resumes")
          .countDocuments({ userId: uid }),
        atsChecks: await db
          .collection("ats_scores")
          .countDocuments({ userId: uid }),
        applications: await db
          .collection("applications")
          .countDocuments({ jobSeekerId: uid }),
        interviews: interviews.length,
        completedInterviews: completed.length,
        trends,
        recurringImprovements: Object.entries(improvements)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15),
        learning: paths.map((p) => ({
          _id: p._id,
          skill: p.skill,
          level: p.level,
          completed: (p.completedTaskIds || []).length,
          total: (p.weeklySchedule || []).reduce(
            (n, w) => n + w.tasks.length,
            0,
          ),
        })),
      });
    }),
  );
  return router;
};
