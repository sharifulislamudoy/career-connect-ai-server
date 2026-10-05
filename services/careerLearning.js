const { generateJSON, apiError, assertResult, validStrings } = require('./gemini');
const str = { type: 'STRING' }; const num = { type: 'NUMBER' }; const arr = items => ({ type: 'ARRAY', items });
const obj = properties => ({ type: 'OBJECT', properties, required: Object.keys(properties) });
const schema = obj({ overview: str, prerequisites: arr(str), outcomes: arr(str),
  weeklySchedule: arr(obj({ week: num, title: str, topics: arr(str), milestone: str,
    tasks: arr(obj({ title: str, instructions: str, deliverable: str, estimatedMinutes: num, resourceQueries: arr(str) })) })) });
function languageTag(value = 'en-US') {
  if (typeof value !== 'string' || value.length > 35) throw apiError(400, 'Enter a valid language code, for example bn-BD or en-US.');
  try { return Intl.getCanonicalLocales(value)[0] || 'en-US'; } catch { throw apiError(400, 'Invalid language code. Use a BCP 47 code such as bn-BD.'); }
}
async function generatePlan(body, context) {
  const skill = typeof (body.skill || body.title) === 'string' ? (body.skill || body.title).trim() : '';
  const level = body.level || 'beginner'; const weeks = body.weeks ?? (body.days ? Math.ceil(body.days / 7) : 4); const hoursPerWeek = body.hoursPerWeek ?? 5;
  const language = languageTag(body.language);
  if (!skill || skill.length > 200) throw apiError(400, 'Enter a skill or career goal, at most 200 characters.');
  if (!['beginner', 'intermediate', 'advanced'].includes(level) || !Number.isInteger(weeks) || weeks < 2 || weeks > 24 || !Number.isFinite(hoursPerWeek) || hoursPerWeek < 2 || hoursPerWeek > 40) throw apiError(400, 'Select a level, 2–24 weeks and 2–40 hours per week.');
  const data = await generateJSON({ action: 'skill_learning_roadmap', skill, level, weeks, hoursPerWeek, language,
    instructions: `Write all natural-language guidance in ${language}. Create exactly ${weeks} sequential weeks. Adapt the starting point to ${level}, stated skill and this user's recorded skills and interview/ATS gaps. Beginner: prerequisites and fundamentals before applications; intermediate: applied patterns, debugging, testing and projects; advanced: depth, trade-offs, architecture and challenging assessment. Each week must contain 3–5 DISTINCT tasks, detailed step-by-step instructions, a concrete deliverable and realistic estimatedMinutes. Sum of minutes in EVERY week must not exceed ${hoursPerWeek * 60}. Include at least one hands-on project and a way to evaluate readiness. Weekly milestones must be demonstrable outcomes. ResourceQueries should be 1–3 specific search queries for official documentation/tutorials; do not invent or return URLs. Do not repeat a generic task to fill a schedule. Never mark planned work as completed or infer mastery from a resume claim.` }, context, schema, Math.min(26000, 3000 + weeks * 900));
  assertResult(data && typeof data.overview === 'string' && validStrings(data.prerequisites) && validStrings(data.outcomes) && data.outcomes.length > 0 && Array.isArray(data.weeklySchedule) && data.weeklySchedule.length === weeks);
  const weeklySchedule = [...data.weeklySchedule].sort((a, b) => a.week - b.week).map((week, index) => {
    assertResult(week.week === index + 1 && typeof week.title === 'string' && typeof week.milestone === 'string' && validStrings(week.topics) && Array.isArray(week.tasks) && week.tasks.length >= 3 && week.tasks.length <= 5);
    const tasks = week.tasks.map((task, taskIndex) => {
      assertResult(task && ['title', 'instructions', 'deliverable'].every(key => typeof task[key] === 'string' && task[key].trim() && task[key].length <= 5000) && Number.isFinite(task.estimatedMinutes) && task.estimatedMinutes >= 1 && validStrings(task.resourceQueries) && task.resourceQueries.length <= 3);
      return { ...task, id: `w${index + 1}-t${taskIndex + 1}`, estimatedMinutes: Math.round(task.estimatedMinutes) };
    });
    assertResult(tasks.reduce((total, task) => total + task.estimatedMinutes, 0) <= hoursPerWeek * 60);
    return { ...week, tasks, hoursRequired: tasks.reduce((total, task) => total + task.estimatedMinutes, 0) / 60 };
  });
  return { skill, title: skill, level, weeks, hoursPerWeek, language, overview: data.overview, prerequisites: data.prerequisites, outcomes: data.outcomes, weeklySchedule, completedTaskIds: [], coachEnabled: true, version: 0 };
}
module.exports = { generatePlan, languageTag };
