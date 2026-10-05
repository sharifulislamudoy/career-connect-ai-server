const unlimited = null;
const limits = {
  basic: {
    documents: 2,
    chat: 20,
    ats: 3,
    atsJob: 1,
    interviews: 1,
    learning: 1,
    coverLetter: 1,
    tailoring: 1,
    rewrite: 3,
    jobMatch: 0,
    skillGap: 1,
    linkedin: 0,
    negotiation: 0,
    weeklyPlan: 0,
    workspace: 10,
    alerts: 1,
  },
  standard: {
    documents: 15,
    chat: 300,
    ats: 30,
    atsJob: 30,
    interviews: 10,
    learning: 5,
    coverLetter: 20,
    tailoring: 15,
    rewrite: 50,
    jobMatch: 30,
    skillGap: 5,
    linkedin: 2,
    negotiation: 3,
    weeklyPlan: 0,
    workspace: 100,
    alerts: 10,
  },
  premium: Object.fromEntries(
    [
      "documents",
      "chat",
      "ats",
      "atsJob",
      "interviews",
      "learning",
      "coverLetter",
      "tailoring",
      "rewrite",
      "jobMatch",
      "skillGap",
      "linkedin",
      "negotiation",
      "weeklyPlan",
      "workspace",
      "alerts",
    ].map((key) => [key, unlimited]),
  ),
};
const credits = {
  chat: 1,
  ats: 0,
  atsJob: 0,
  interviews: 10,
  learning: 5,
  coverLetter: 2,
  tailoring: 5,
  rewrite: 1,
  jobMatch: 2,
  skillGap: 3,
  linkedin: 3,
  negotiation: 2,
  weeklyPlan: 5,
};
const price = (key, fallback) => {
  const value = Number(process.env[key] || fallback);
  if (!Number.isSafeInteger(value) || value < 100)
    throw new Error(`${key} must be an integer BDT minor-unit price >= 100.`);
  return value;
};
function catalog() {
  return [
    {
      id: "basic",
      name: "Basic",
      monthly: 0,
      yearly: 0,
      limits: limits.basic,
      templates: ["ats"],
      modes: ["text"],
    },
    {
      id: "standard",
      name: "Standard",
      monthly: price("STANDARD_MONTHLY_BDT", 49900),
      yearly: price("STANDARD_YEARLY_BDT", 499000),
      limits: limits.standard,
      templates: ["ats", "professional", "compact"],
      modes: ["text", "voice"],
    },
    {
      id: "premium",
      name: "Premium",
      monthly: price("PREMIUM_MONTHLY_BDT", 99900),
      yearly: price("PREMIUM_YEARLY_BDT", 999000),
      limits: limits.premium,
      templates: ["ats", "professional", "compact"],
      modes: ["text", "voice", "video"],
      customStyle: true,
    },
  ];
}
function effectivePlan(user, now = new Date()) {
  const plan = String(user?.package || "basic").toLowerCase();
  return ["standard", "premium"].includes(plan) &&
    new Date(user?.packageExpiry || 0) > now &&
    ["active", "trialing"].includes(user?.subscriptionStatus || "active")
    ? plan
    : "basic";
}
function periodKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
  })
    .format(now)
    .replace(/[^0-9]/g, "");
}
function quotaLimit(plan, feature) {
  if (!(feature in limits[plan])) throw new Error("Unknown entitlement");
  return limits[plan][feature];
}
module.exports = {
  limits,
  credits,
  catalog,
  effectivePlan,
  periodKey,
  quotaLimit,
};
