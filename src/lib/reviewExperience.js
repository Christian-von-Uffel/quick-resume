import { normalizeStoredList } from "./resumeModel";
import { renderPromptTemplate } from "./promptTemplate";

// The "address missing experience" flow on the Generate Resume tab. Unlike the
// clarity review (fix what's written) or the enrichment flow (expand one thin
// role from its title alone), this flow reads ONE specific job description and
// finds what it asks for that the stored work history doesn't show yet:
//   Call 1  buildMissingExperienceReviewPrompt -> what the posting asks for that
//           the history already shows (coveredSkills), plus gap questions, each
//           connected to the existing role(s) that plausibly involved it
//   Call 2  formatExperienceElaboration        -> the person's answer, rewritten
//           as one plainspoken work-history detail
// Every question is a candidate to confirm, never an asserted fact.

// The stages of the review, in the order the UI reports progress. The LLM call
// covers step 1; step 2 is the local pass that validates the questions and
// connects each one to the stored roles it names.
export const MISSING_EXPERIENCE_STEPS = [
  { id: "review", label: "Reading the job description against your work history" },
  { id: "connect", label: "Connecting each gap to the role where it probably happened" },
];

// The kinds of things a posting asks for. The prompt requires sweeping ALL of
// them so questions cover the posting's breadth — responsibilities, leadership,
// stakeholders, ways of working — instead of collapsing into a tool checklist.
export const MISSING_EXPERIENCE_KINDS = [
  "responsibility",
  "leadership",
  "collaboration",
  "communication",
  "method",
  "tool",
  "domain",
  "approach",
];

export const MISSING_EXPERIENCE_KIND_LABELS = {
  responsibility: "Core responsibility",
  leadership: "Leadership",
  collaboration: "Collaboration",
  communication: "Communication",
  method: "Method",
  tool: "Tool",
  domain: "Domain",
  approach: "Way of working",
};

const MISSING_EXPERIENCE_KIND_SET = new Set(MISSING_EXPERIENCE_KINDS);

export const MAX_MISSING_EXPERIENCE_ITEMS = 12;
// Cap on the "already shown" list. Wider than the gap cap because a covered
// item costs the person nothing — it's a check mark, not a question.
export const MAX_COVERED_SKILLS = 16;

// Shipped gap-review prompt as a lab-loadable template. `$workHistoryJson` is
// the same JSON.stringify(workHistory, null, 2) production sends; `$maxItems`
// and `$maxCovered` are the caps stringified so the template stays a pure string.
export const GAP_REVIEW_PROMPT_TEMPLATE = `<task>
You are helping a candidate address experience this specific job posting asks for that their stored work history does not clearly show yet.
1. Read the ENTIRE job description — summary, responsibilities, qualifications, technical lists — and collect what it asks for across every kind below, not just tools.
2. Cross-reference against the candidate's work history. Everything a stored detail already demonstrates outright goes in coveredSkills, naming the role whose detail shows it; everything else is a gap.
3. For each remaining gap, check whether one of the candidate's existing roles PLAUSIBLY involved it even though the description never says so — infer from the role's title, company, dates, and existing details. When it does, name those roles in likelyRoles and phrase the question so it connects that role to the gap.
4. Only when no existing role plausibly implies the gap, ask a plain direct question about it.
</task>

<kinds_of_experience>
- "responsibility": day-to-day work the posting expects (e.g. building predictive models, designing data workflows).
- "leadership": leading initiatives, mentoring, coaching, providing direction to others.
- "collaboration": partnering with or influencing specific stakeholders (executives, legal, engineering, HR).
- "communication": presenting, writing, or explaining complex work to non-technical audiences.
- "method": techniques or disciplines (e.g. statistics, experimentation, data engineering, automation).
- "tool": named software, languages, or platforms (e.g. SQL, Streamlit, vector databases).
- "domain": industry or operating context (e.g. people analytics, regulated environments).
- "approach": ways of working the posting emphasizes (e.g. handling ambiguity, rapid prototyping, judgment about what to build).
</kinds_of_experience>

<work_history>
$workHistoryJson
</work_history>

<job_description>
$jobDescription
</job_description>

<instructions>
- Cover every kind the posting genuinely asks about. AT MOST a third of your items may be kind "tool" — hiring managers are persuaded by demonstrated responsibilities, judgment, and stakeholder work, not only tool checklists.
- Write each "question" conversationally, the way a colleague would ask, and so it can be answered yes or no. One discrete topic per question — never use "and", "or", "/", or "&", and never bundle several skills into one question.
- When likelyRoles names a role, the question should connect it to the gap, e.g. "When you built churn models at Beta Inc, did you present the results to executives?" — the role gives the person a concrete memory to check.
- In likelyRoles, copy "position" and "company" VERBATIM from the work history so they can be matched. Add a short "why" naming what in that role implies the gap. List at most 3 roles per question, best match first. Use an empty array when nothing plausibly fits.
- These are candidates for the person to confirm, NOT facts. Never state that they did something — ask.
- Write "whyItMatters" as one short sentence on why the posting cares about this, grounded in the posting's own wording.
- Keep "plainspokenDetail" simple, factual, and reusable as a work-history bullet if the person confirms without elaborating (e.g. "Presented analytical findings to senior leadership.").
- Write "answerPlaceholder" as a short first-person example answer starting with "Yes, I", hinting at the specifics worth including (what they did and, when natural, what came of it). Keep it realistic and plainspoken.
- Avoid vague catch-all questions: never use "various", "overall", "general", "such as", "including", "etc", or the words "duties", "tasks", "functions", "responsibilities" inside a question — ask about one concrete activity instead.
- Limit to the $maxItems most useful gaps, ordered by how much addressing them would strengthen this application. Aim for at least 6 when the posting supports them.
- In coveredSkills, list what the posting asks for that a stored detail shows outright — a named tool, a stated responsibility, a described collaboration. A role title alone is a guess, and a guess belongs in a question instead. For each, copy "position" and "company" VERBATIM from the work history and quote the "detail" that shows it in a few words. Up to $maxCovered items, the posting's most emphasized first.
- Return only valid JSON matching the schema below. Do not wrap it in markdown fences or add comments.
</instructions>

<schema>
{
  "coveredSkills": [
    {
      "skill": "Short name of what the posting asks for (e.g. SQL)",
      "kind": "responsibility | leadership | collaboration | communication | method | tool | domain | approach",
      "evidence": [
        {
          "position": "Copied verbatim from work_history",
          "company": "Copied verbatim from work_history",
          "detail": "The stored detail that shows it, in a few words."
        }
      ]
    }
  ],
  "missingExperienceDetails": [
    {
      "skill": "Short name of the gap (e.g. Executive communication)",
      "kind": "responsibility | leadership | collaboration | communication | method | tool | domain | approach",
      "whyItMatters": "Why the posting cares, in its own terms.",
      "question": "When you built churn models at Beta Inc, did you present the results to executives?",
      "likelyRoles": [
        {
          "position": "Copied verbatim from work_history",
          "company": "Copied verbatim from work_history",
          "why": "What in this role implies the gap."
        }
      ],
      "plainspokenDetail": "Reusable work-history detail if confirmed without elaboration.",
      "answerPlaceholder": "Yes, I presented quarterly model results to our VP of Product."
    }
  ]
}
</schema>`;

export function buildMissingExperienceReviewPrompt({ workHistory, jobDescription }) {
  return renderPromptTemplate(GAP_REVIEW_PROMPT_TEMPLATE, {
    workHistoryJson: JSON.stringify(workHistory, null, 2),
    jobDescription: jobDescription ?? "",
    maxItems: String(MAX_MISSING_EXPERIENCE_ITEMS),
    maxCovered: String(MAX_COVERED_SKILLS),
  });
}

// Hard rejects for questions that bundle topics or hide behind category words —
// they produce mushy answers that don't convert into credible bullets.
function isSpecificExperienceQuestion(value) {
  const question = String(value ?? "").trim().toLowerCase();
  if (!question) return false;

  const broadPatterns = [
    /\band\b/,
    /\bor\b/,
    /[/&]/,
    /\bvarious\b/,
    /\boverall\b/,
    /\bgeneral\b/,
    /\bfunctions?\b/,
    /\bduties\b/,
    /\btasks\b/,
    /\bresponsibilities\b/,
    /\bincluding\b/,
    /\bsuch as\b/,
    /\betc\b/,
  ];

  return !broadPatterns.some((pattern) => pattern.test(question));
}

function normalizeQuestionText(value, skill) {
  const question = String(value ?? "").trim();
  if (!question) return `Do you have experience with ${skill}?`;
  return /[?]$/.test(question) ? question : `${question.replace(/[.!]+$/, "")}?`;
}

const normalizeRoleField = (value) => String(value ?? "").trim().toLowerCase();

// Match a role the model named back to a stored work-history item, tolerating
// light rewording the same way the resume generator's isSameRole does.
function findWorkItemForRole(entry, workHistory) {
  const position = normalizeRoleField(entry?.position);
  const company = normalizeRoleField(entry?.company);
  if (!position && !company) return null;

  return (
    (workHistory ?? []).find((item) => {
      const itemPosition = normalizeRoleField(item.position);
      const itemCompany = normalizeRoleField(item.company);
      const companyMatches = company && itemCompany === company;
      const positionMatches = position && itemPosition === position;
      if (companyMatches && positionMatches) return true;
      if (companyMatches && !position) return true;
      if (positionMatches && !company) return true;
      return false;
    }) ?? null
  );
}

function normalizeLikelyRoles(value, workHistory) {
  const seen = new Set();

  return normalizeStoredList(value, [])
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const item = findWorkItemForRole(entry, workHistory);
      if (!item || seen.has(item.id)) return null;
      seen.add(item.id);
      return {
        workId: item.id,
        label: [item.position, item.company].filter(Boolean).join(" at ") || "Untitled role",
        why: typeof entry.why === "string" ? entry.why.trim() : "",
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}

function normalizeMissingExperienceDetail(value, workHistory) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const skill = typeof value.skill === "string" ? value.skill.replace(/\s+/g, " ").trim() : "";
  if (!skill) return null;

  const question = normalizeQuestionText(value.question, skill);
  if (!isSpecificExperienceQuestion(question)) return null;

  const kindRaw = typeof value.kind === "string" ? value.kind.trim().toLowerCase() : "";
  const kind = MISSING_EXPERIENCE_KIND_SET.has(kindRaw) ? kindRaw : "responsibility";

  const plainspokenDetail =
    typeof value.plainspokenDetail === "string" && value.plainspokenDetail.trim()
      ? value.plainspokenDetail.trim()
      : `Experience with ${skill}.`;

  const answerPlaceholder =
    typeof value.answerPlaceholder === "string" && value.answerPlaceholder.trim()
      ? value.answerPlaceholder.trim()
      : `Yes, I ${skill.charAt(0).toLowerCase()}${skill.slice(1)}...`;

  return {
    skill,
    kind,
    whyItMatters: typeof value.whyItMatters === "string" ? value.whyItMatters.trim() : "",
    question,
    likelyRoles: normalizeLikelyRoles(value.likelyRoles, workHistory),
    plainspokenDetail,
    answerPlaceholder,
  };
}

export function validateMissingExperienceReview(value, workHistory) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid missing experience JSON.");
  }

  const seenSkills = new Set();

  return normalizeStoredList(value.missingExperienceDetails, [])
    .map((entry) => normalizeMissingExperienceDetail(entry, workHistory))
    .filter(Boolean)
    .filter((detail) => {
      const key = detail.skill.toLowerCase();
      if (seenSkills.has(key)) return false;
      seenSkills.add(key);
      return true;
    })
    .slice(0, MAX_MISSING_EXPERIENCE_ITEMS)
    .map((detail, index) => ({ id: `missing-${index}`, ...detail }));
}

// The evidence behind one covered skill: the stored role (resolved to its
// work-history id) and the detail the model quoted from it. An entry naming a
// role that isn't in the history is dropped — a check mark is a claim about
// the person's own record, so it has to point at something in that record.
function normalizeCoveredEvidence(value, workHistory) {
  const seen = new Set();

  return normalizeStoredList(value, [])
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const item = findWorkItemForRole(entry, workHistory);
      if (!item || seen.has(item.id)) return null;
      seen.add(item.id);
      return {
        workId: item.id,
        label: [item.position, item.company].filter(Boolean).join(" at ") || "Untitled role",
        detail: typeof entry.detail === "string" ? entry.detail.replace(/\s+/g, " ").trim() : "",
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}

function normalizeCoveredSkill(value, workHistory) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const skill = typeof value.skill === "string" ? value.skill.replace(/\s+/g, " ").trim() : "";
  if (!skill) return null;

  const evidence = normalizeCoveredEvidence(value.evidence, workHistory);
  if (!evidence.length) return null;

  const kindRaw = typeof value.kind === "string" ? value.kind.trim().toLowerCase() : "";
  const kind = MISSING_EXPERIENCE_KIND_SET.has(kindRaw) ? kindRaw : "responsibility";

  return { skill, kind, evidence };
}

// The "already shown" half of the review. Lenient where the gap validator
// throws: a response with no coveredSkills key (an older prompt in the lab, a
// lazy model) still yields its gap questions, just with an empty check list.
export function validateCoveredSkills(value, workHistory) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];

  const seenSkills = new Set();

  return normalizeStoredList(value.coveredSkills, [])
    .map((entry) => normalizeCoveredSkill(entry, workHistory))
    .filter(Boolean)
    .filter((item) => {
      const key = item.skill.toLowerCase();
      if (seenSkills.has(key)) return false;
      seenSkills.add(key);
      return true;
    })
    .slice(0, MAX_COVERED_SKILLS)
    .map((item, index) => ({ id: `covered-${index}`, ...item }));
}

// One row per thing the posting asks for, in the order the checklist shows
// them: what the history already covers first, then the gap questions. Within
// each group, explicitly named tools lead (they're the concrete, checkable
// asks — "Jira", "BigQuery"), and everything else keeps its given order.
// Statuses, by precedence:
//   covered   a stored detail shows it (green check)
//   added     the person confirmed it and saved a detail to a role (green check)
//   confirmed the person said yes, not saved yet (green check)
//   dismissed the person said no (muted dash)
//   open      still a question (orange question mark)
// A skill the model both listed as covered and asked about keeps the question:
// the question is the more careful claim.
export const SKILL_CHECK_STATUSES = ["covered", "added", "confirmed", "dismissed", "open"];

export function buildSkillsChecklist({
  covered = [],
  gaps = [],
  confirmedSkills = [],
  dismissedSkills = [],
  savedSkills = [],
} = {}) {
  const keyOf = (skill) => String(skill ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const confirmed = new Set(confirmedSkills.map(keyOf));
  const dismissed = new Set(dismissedSkills.map(keyOf));
  const saved = new Set(savedSkills.map(keyOf));
  const askedAbout = new Set(gaps.map((gap) => keyOf(gap.skill)));

  // Stable: tools move ahead, the rest stay in their original order.
  const toolsFirst = (list) => [
    ...list.filter((entry) => entry.kind === "tool"),
    ...list.filter((entry) => entry.kind !== "tool"),
  ];

  const items = [];
  for (const item of toolsFirst(covered)) {
    const key = keyOf(item.skill);
    if (!key || askedAbout.has(key)) continue;
    items.push({
      key: `covered:${key}`,
      skill: item.skill,
      kind: item.kind,
      status: "covered",
      evidence: item.evidence ?? [],
    });
  }
  for (const gap of toolsFirst(gaps)) {
    const key = keyOf(gap.skill);
    if (!key) continue;
    const status = saved.has(key)
      ? "added"
      : confirmed.has(key)
        ? "confirmed"
        : dismissed.has(key)
          ? "dismissed"
          : "open";
    items.push({ key: `gap:${key}`, skill: gap.skill, kind: gap.kind, status, evidence: [] });
  }

  const counts = Object.fromEntries(SKILL_CHECK_STATUSES.map((status) => [status, 0]));
  for (const item of items) counts[item.status] += 1;

  return { items, counts };
}

export function formatExperienceElaboration({ question, answer }) {
  return `<task>
Rewrite the person's spoken answer into ONE clean, factual sentence describing what they did.
</task>

<question>
${question}
</question>

<answer>
${answer}
</answer>

<instructions>
- Keep the person's own wording and level of detail. Do NOT add buzzwords, corporate jargon, or embellishment, and do NOT make it sound fancier than what they actually said.
- Remove conversational lead-ins and any direct answer to the question ("Yes, I", "Yeah", "Well", "So", "Basically", "I did"). Start with a past-tense action verb.
- Keep every concrete fact the person gave: names, places, numbers, tools, dates, and outcomes. Invent nothing.
- When the answer includes a result, follow a simple "did X, which resulted in Y" shape. Otherwise just state plainly what they did.
- Fix only grammar, spelling, capitalization, and punctuation. Capitalize proper nouns correctly (e.g., "PAX East", "PS4").
- Return it as a single line with no line breaks and no leading bullet character or dash.
- If the answer has no usable detail, just return the answer cleaned up as best you can.
</instructions>

Return ONLY the rewritten sentence as plain text. No quotes, no labels, no explanation, no markdown.`;
}

export function cleanFormattedDetail(text) {
  if (typeof text !== "string") return "";
  let cleaned = text.trim();

  const fenced = cleaned.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (fenced) cleaned = fenced[1].trim();

  cleaned = cleaned.replace(/\s*\n+\s*/g, " ").trim();
  cleaned = cleaned.replace(/^[-•*]\s*/, "");
  cleaned = cleaned.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();

  return cleaned;
}
