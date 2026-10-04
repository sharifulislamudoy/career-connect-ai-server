const { ObjectId } = require("mongodb");
const { apiError } = require("./gemini");

function text(value, max = 2000) { return typeof value === "string" ? value.slice(0, max) : ""; }
function field(value, max = 2000) { return typeof value === "number" ? value : text(value, max); }
function records(value, fields) {
  if (typeof value === "string") return text(value, 4000);
  if (!Array.isArray(value)) return [];
  return value.slice(0, 15).map(item => {
    if (typeof item === "string") return text(item, 500);
    if (!item || typeof item !== "object") return "";
    return Object.fromEntries(fields.filter(key => item[key] !== undefined).map(key => [key, field(item[key])]));
  });
}
function profile(user) {
  return {
    displayName: text(user.displayName || user.fullName || user.name, 120),
    profession: text(user.profession, 150), bio: text(user.bio, 3000),
    location: text(user.location, 150), careerGoals: text(user.careerGoals, 1500),
    skills: records(user.skills, ["name", "skill", "level"]),
    experience: records(user.experience || user.workExperience, ["title", "position", "company", "startDate", "endDate", "description"]),
    education: records(user.education, ["degree", "institution", "field", "startDate", "endDate"]),
  };
}
function resumeContext(resume) {
  if (!resume) return null;
  return {
    title: text(resume.personal?.title, 200),
    summary: text(resume.personal?.summary || resume.summary, 4000),
    skills: records(resume.skills, ["name", "level"]),
    experience: records(resume.experience, ["position", "title", "company", "startDate", "endDate", "description"]),
    education: records(resume.education, ["degree", "institution", "field", "startDate", "endDate"]),
    projects: records(resume.projects, ["name", "description", "technologies"]),
  };
}
function jobContext(job) {
  return {
    id: String(job._id), title: text(job.title, 200), company: text(job.company, 200),
    location: text(job.location, 200), type: text(job.type, 100),
    experience: field(job.experience, 400), salary: typeof job.salary === "object" && job.salary
      ? { min: field(job.salary.min), max: field(job.salary.max), currency: field(job.salary.currency) } : field(job.salary, 300),
    description: text(job.description, 3500),
    requirements: records(job.requirements, ["name", "description"]),
    skills: records(job.skills, ["name", "level"]),
    applicationDeadline: job.applicationDeadline ? String(job.applicationDeadline) : "",
    link: `/jobs/${job._id}`,
  };
}
function activeFilter() {
  const now = new Date();
  return { status: "active", $or: [
    { applicationDeadline: { $exists: false } }, { applicationDeadline: null },
    { applicationDeadline: "" }, { applicationDeadline: { $gte: now } },
    { applicationDeadline: { $gte: now.toISOString() } },
  ] };
}
function isOpen(job) {
  if (job.status !== "active") return false;
  if (!job.applicationDeadline) return true;
  const deadline = new Date(job.applicationDeadline).getTime();
  return Number.isFinite(deadline) && deadline >= Date.now();
}

async function loadContext(db, user, query = "", jobId = "") {
  const current = profile(user);
  // Only this user's most recent resume; contact details, IDs, tokens and passwords never enter the prompt.
  const resume = await db.collection("resumes").findOne({ userId: user.uid }, {
    sort: { updatedAt: -1, createdAt: -1 },
    projection: { "personal.title": 1, "personal.summary": 1, summary: 1, skills: 1, experience: 1, education: 1, projects: 1 },
  });
  const ownResume = resumeContext(resume);
  const tokens = [...new Set(`${query} ${current.profession} ${JSON.stringify(current.skills)} ${JSON.stringify(ownResume?.skills || [])}`
    .toLowerCase().match(/[\p{L}\p{N}+#.]{3,}/gu) || [])]
    .filter(word => !["the", "and", "for", "with", "that", "this", "job", "jobs", "name", "skill", "level", "find", "please"].includes(word)).slice(0, 20);
  const jobs = db.collection("jobs");
  const projection = { title: 1, company: 1, location: 1, type: 1, experience: 1, salary: 1,
    description: 1, requirements: 1, skills: 1, applicationDeadline: 1, status: 1, createdAt: 1 };
  let matched = [];
  if (tokens.length) {
    const pattern = tokens.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    matched = await jobs.find({ $and: [activeFilter(), { $or: ["title", "description", "skills", "requirements"]
      .map(key => ({ [key]: { $regex: pattern, $options: "i" } })) }] }, { projection })
      .sort({ createdAt: -1 }).limit(80).toArray();
  }
  const recent = await jobs.find(activeFilter(), { projection }).sort({ createdAt: -1 }).limit(20).toArray();
  const unique = new Map([...matched, ...recent].filter(isOpen).map(job => [String(job._id), job]));
  const ranked = [...unique.values()].map(job => {
    const value = JSON.stringify(jobContext(job)).toLowerCase();
    return { job, score: tokens.reduce((score, token) => score + (value.includes(token) ? 1 : 0), 0) };
  }).sort((a, b) => b.score - a.score || new Date(b.job.createdAt) - new Date(a.job.createdAt)).slice(0, 12).map(item => item.job);
  if (jobId) {
    if (typeof jobId !== "string" || !/^[a-f0-9]{24}$/i.test(jobId)) throw apiError(400, "Invalid job ID.");
    const selected = await jobs.findOne({ _id: new ObjectId(jobId), status: "active" }, { projection });
    if (!selected || !isOpen(selected)) throw apiError(404, "Job is unavailable or its deadline has passed.");
    ranked.unshift(selected);
  }
  return { CURRENT_USER: current, OWN_RESUME: ownResume,
    JOBS: [...new Map(ranked.map(job => [String(job._id), jobContext(job)])).values()].slice(0, 12),
    contextScope: "A bounded selection of relevant active jobs, not the entire jobs collection." };
}
module.exports = { loadContext, text };
