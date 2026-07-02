import { normalizeStoredList } from "./resumeModel";

export function findMissingExperience({ workHistory, jobDescription }) {
  return `<task>
1. Analyze the job description below to compile a list of necessary skills, experiences, and responsibilities.
2. Cross-reference this list against the candidate's work history to identify gaps (things requested in the job description but not clearly demonstrated or mentioned in the work history).
3. Generate simple, direct, conversational questions to ask the candidate about those gaps so they can fill in their work history.
</task>

<work_history>
${JSON.stringify(workHistory, null, 2)}
</work_history>

<job_description>
${jobDescription}
</job_description>

<instructions>
- Identify concrete skills, tools, technologies, methodologies, or hands-on responsibilities in the job description that are missing from the candidate's work history.
- For each gap, generate a simple, direct, conversational question.
- Every question MUST start with the exact phrase "Do you have experience" (e.g. "Do you have experience conducting customer discovery interviews?").
- Write questions in natural, active, plainspoken language—exactly how a recruiter or hiring manager would ask a candidate during an interview. Avoid robotic, academic, corporate, or policy-heavy jargon.
- Each question must be extremely simple and focus on exactly ONE discrete topic or skill that can be answered with a clear "yes" or "no". Never ask multi-part questions.
- Keep "plainspokenDetail" simple, factual, and reusable as a bullet point in a work history description (e.g., "Conducted customer discovery interviews to identify user needs.").
- Write "answerPlaceholder" as a short, first-person example answer that starts with "Yes, I" and hints at the kind of specifics we want (what they did and, when natural, what came of it). Keep it realistic and plainspoken, not fancy. For "Do you have experience designing product literature?" a good placeholder is "Yes, I designed product brochures and one-pagers our sales team handed out at trade shows."

CRITICAL VALIDATION RULES - Violating these will cause the question to be rejected:
1. Do NOT use the word "and" or "or" anywhere in the question (split combined requirements into separate questions).
2. Do NOT use the symbols "/" or "&" anywhere in the question.
3. Do NOT use any of the following banned broad or category words anywhere in the question:
   - "all", "any", "various", "multiple", "overall", "general"
   - "function", "functions", "duties", "tasks", "responsibilities"
   - "frontend", "front-end"
   - "including", "such as", "like", "etc"
Instead of asking broad questions, ask about a single, specific activity (e.g., instead of "Do you have experience with agile tasks?", ask "Do you have experience working in an agile team?").

Limit to the 10 most useful missing details. Generate at least 5 details if possible.
Return only valid JSON matching the schema below. Do not wrap it in markdown block code or add comments.
</instructions>

<schema>
{
  "missingExperienceDetails": [
    {
      "skill": "Specific skill or detail from the job description (e.g., Customer discovery interviews)",
      "whyItMatters": "Short reason this appears important in the job description.",
      "question": "Do you have experience...",
      "plainspokenDetail": "Reusable work history detail (e.g., Conducted customer discovery interviews to identify user needs.)",
      "answerPlaceholder": "Yes, I ... (a short first-person example answer that fits the question)"
    }
  ]
}
</schema>`;
}

function isSpecificExperienceQuestion(value) {
  const question = String(value ?? "").trim().toLowerCase();
  if (!question) return false;

  const broadPatterns = [
    /\band\b/,
    /[/&]/,
    /\ball\b/,
    /\bany\b/,
    /\bvarious\b/,
    /\bmultiple\b/,
    /\boverall\b/,
    /\bgeneral\b/,
    /\bfunctions?\b/,
    /\bduties\b/,
    /\btasks\b/,
    /\bresponsibilities\b/,
    /\bfront[-\s]?end\b/,
    /\bincluding\b/,
    /\bsuch as\b/,
    /\blike\b/,
    /\betc\b/,
  ];

  return !broadPatterns.some((pattern) => pattern.test(question));
}

function formatExperienceQuestion(value) {
  const question = String(value ?? "").trim();
  if (!question) return "";
  if (/^do you have experience\b/i.test(question)) return question;

  const normalized = question
    .replace(/^have you\s+/i, "")
    .replace(/^are you experienced (?:with|in)\s+/i, "")
    .replace(/^can you\s+/i, "")
    .replace(/^do you know how to\s+/i, "")
    .replace(/[?.!]*$/, "")
    .trim();

  return `Do you have experience ${normalized}?`;
}

function normalizeMissingExperienceDetail(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const skill = typeof value.skill === "string" ? value.skill.trim() : "";
  if (!skill) return null;

  const plainspokenDetail =
    typeof value.plainspokenDetail === "string" && value.plainspokenDetail.trim()
      ? value.plainspokenDetail.trim()
      : `Experience with ${skill}.`;
  const question =
    typeof value.question === "string" && value.question.trim()
      ? formatExperienceQuestion(value.question)
      : `Do you have experience with ${skill}?`;

  if (!isSpecificExperienceQuestion(question)) return null;

  const answerPlaceholder =
    typeof value.answerPlaceholder === "string" && value.answerPlaceholder.trim()
      ? value.answerPlaceholder.trim()
      : `Yes, I ${skill.charAt(0).toLowerCase()}${skill.slice(1)}...`;

  return {
    skill,
    whyItMatters: typeof value.whyItMatters === "string" ? value.whyItMatters.trim() : "",
    question,
    plainspokenDetail,
    answerPlaceholder,
  };
}

export function validateMissingExperienceDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid missing experience JSON.");
  }

  return normalizeStoredList(value.missingExperienceDetails, [])
    .map(normalizeMissingExperienceDetail)
    .filter(Boolean);
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
