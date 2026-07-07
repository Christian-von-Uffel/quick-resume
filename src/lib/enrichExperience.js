import {
  normalizeStoredList,
  splitDescriptionIntoDetails,
  normalizeDetailForComparison,
} from "./resumeModel";
import { cleanFormattedDetail } from "./reviewExperience";

// The "add details" enrichment flow for a single sparse position. Unlike the
// clarity review (fix what's written) or the missing-experience review (gaps vs.
// one specific job description), this flow uses the role title's typical
// job-posting requirements as the source of questions:
//   Call 1  buildResponsibilityMapPrompt  -> areas the person confirms as chips
//   Call 2  buildDrilldownPrompt          -> click-to-answer questions per area
//   Call 3  buildEnrichedBulletPrompt     -> one plainspoken bullet per area
// Every option list is a candidate to confirm, never an asserted fact.

export const MAX_ENRICH_AREAS_PER_ROUND = 4;

// Fixed question archetypes. Each drill-down question declares one so the UI
// knows how to render it; "tools" is the only multi-select kind.
export const ENRICH_QUESTION_KINDS = ["specifics", "scale", "outcome", "ownership", "tools"];

const ENRICH_QUESTION_KIND_SET = new Set(ENRICH_QUESTION_KINDS);

// Ask the model what the requirements sections of typical job postings for this
// title look for, minus anything the current description already demonstrates.
// The output areas are shown as chips: "Which of these were part of your role?"
export function buildResponsibilityMapPrompt({ position, company, description, tenure }) {
  const roleContext = position?.trim() ? position.trim() : "this role";
  const companyContext = company?.trim() ?? "";
  const tenureBlock = tenure?.trim()
    ? `

<tenure>
About ${tenure.trim()} in the role.
</tenure>`
    : "";

  return `<task>
You are helping someone expand a thin resume work-history entry for the role "${roleContext}"${companyContext ? ` at ${companyContext}` : ""}.
1. Think about what the requirements sections of typical job postings for this title ask for.
2. From those, list the responsibility areas this person most likely handled but has not written down yet.
3. Each area will be shown as a clickable chip asking "Which of these were part of your role?" — the person confirms or rejects each one.
</task>

<role_title>
${roleContext}
</role_title>${tenureBlock}

<current_description>
${description?.trim() ? description.trim() : "(none yet)"}
</current_description>

<instructions>
- Suggest 6 to 8 responsibility areas that job postings for this title commonly require.
- Skip any area the current description already demonstrates — only offer things that would ADD information.
- Write "area" as a short chip label of 2 to 5 plain words naming ONE concrete activity (e.g. "Customer discovery interviews", "Sprint planning"). Never use "and", "or", "/", or "&" in a label, and never use broad catch-alls like "various duties" or "general management".
- Write "whyEmployersAsk" as one short sentence on why postings for this title ask for it.
- Match the seniority implied by the title and tenure: only include people-management, budget, or strategy areas when the title or tenure supports them.
- These are candidates for the person to confirm, NOT facts. Assume nothing about this specific job beyond the title, company, and description given.
- Return only valid JSON matching the schema below. Do not wrap it in markdown fences or add comments.
</instructions>

<schema>
{
  "responsibilityAreas": [
    {
      "area": "Customer discovery interviews",
      "whyEmployersAsk": "Postings for this title usually expect direct customer contact."
    }
  ]
}
</schema>`;
}

export function validateResponsibilityMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return a valid responsibility map.");
  }

  const seen = new Set();

  return normalizeStoredList(value.responsibilityAreas, [])
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const area =
        typeof entry.area === "string" ? entry.area.replace(/\s+/g, " ").trim() : "";
      if (!area) return null;
      return {
        area,
        whyEmployersAsk:
          typeof entry.whyEmployersAsk === "string" ? entry.whyEmployersAsk.trim() : "",
      };
    })
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.area.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8)
    .map((entry, index) => ({ id: `area-${index}`, ...entry }));
}

// For the areas the person confirmed, generate 2–3 click-to-answer questions
// each, drawn from the fixed archetypes. Batched into one call so confirming
// several areas costs a single round trip.
export function buildDrilldownPrompt({ position, company, description, areas }) {
  const roleContext = position?.trim() ? position.trim() : "this role";
  const companyContext = company?.trim() ?? "";
  const areaLines = normalizeStoredList(areas, [])
    .map((area) => (typeof area === "string" ? area.trim() : ""))
    .filter(Boolean)
    .map((area) => `- ${area}`)
    .join("\n");

  return `<task>
The person confirmed that the responsibility areas below were part of their job as "${roleContext}"${companyContext ? ` at ${companyContext}` : ""}. For each area, write 2 or 3 quick multiple-choice questions that pull out resume-worthy specifics. Every question is rendered as clickable options, so the options themselves must read as good answers.
</task>

<role_title>
${roleContext}
</role_title>

<confirmed_areas>
${areaLines}
</confirmed_areas>

<current_description>
${description?.trim() ? description.trim() : "(none yet)"}
</current_description>

<instructions>
- For each area, pick the 2 or 3 most useful question kinds from this fixed set, and never repeat a kind within one area:
  - "specifics": what the work concretely looked like. Options are the common concrete variants of this work for this role.
  - "scale": how much, how many, how often, or how big. Options are honest ranges (e.g. "A handful", "10–25", "25+"), smallest first.
  - "outcome": what came of the work. Options are plausible outcome shapes, and the LAST option must be "Nothing concrete I can point to".
  - "ownership": whether they ran it or supported it. Options like "Owned it end-to-end", "Led part of it", "Supported someone else's work".
  - "tools": software, tools, or methods commonly used for this work in this role. This kind is multi-select.
- Write each question conversationally, the way a colleague would ask (e.g. "Roughly how many did you run?"). One topic per question — never use "and" or "or" in a question.
- Options are candidates to confirm, NOT facts. Never state specific numbers, names, or outcomes as if they happened — offer them for the person to pick.
- Keep options short (2 to 8 words) and mutually distinct. Give 3 to 5 options per question.
- Ask nothing the current description already answers.
- Copy each "area" label VERBATIM from confirmed_areas so it can be matched.
- Return only valid JSON matching the schema below. Do not wrap it in markdown fences or add comments.
</instructions>

<schema>
{
  "areaQuestions": [
    {
      "area": "Copied verbatim from confirmed_areas",
      "questions": [
        {
          "kind": "specifics",
          "question": "When you did this, what did it mostly look like?",
          "options": ["First concrete variant", "Second concrete variant", "Third concrete variant"]
        }
      ]
    }
  ]
}
</schema>`;
}

function normalizeDrilldownQuestion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (!question) return null;

  const kindRaw = typeof value.kind === "string" ? value.kind.trim().toLowerCase() : "";
  const kind = ENRICH_QUESTION_KIND_SET.has(kindRaw) ? kindRaw : "specifics";

  const seen = new Set();
  const options = normalizeStoredList(value.options, [])
    .map((option) => (typeof option === "string" ? option.trim() : ""))
    .filter(Boolean)
    .filter((option) => {
      const key = option.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);

  // A question with fewer than two options gives the person nothing to pick.
  if (options.length < 2) return null;

  return { kind, question, options, multiSelect: kind === "tools" };
}

function normalizeAreaLabel(label) {
  return String(label ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Group the model's questions under the areas the person actually confirmed,
// preserving the confirmed order and dropping anything for unknown areas.
export function validateDrilldownQuestions(value, confirmedAreas) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid drill-down questions.");
  }

  const confirmed = normalizeStoredList(confirmedAreas, [])
    .map((area) => (typeof area === "string" ? area.trim() : ""))
    .filter(Boolean);

  const byLabel = new Map();
  normalizeStoredList(value.areaQuestions, []).forEach((group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return;
    const label = normalizeAreaLabel(group.area);
    if (!label || byLabel.has(label)) return;

    const seenKinds = new Set();
    const questions = normalizeStoredList(group.questions, [])
      .map(normalizeDrilldownQuestion)
      .filter(Boolean)
      .filter((question) => {
        if (seenKinds.has(question.kind)) return false;
        seenKinds.add(question.kind);
        return true;
      })
      .slice(0, 3);

    if (questions.length) byLabel.set(label, questions);
  });

  return confirmed
    .map((area, areaIndex) => {
      const questions = byLabel.get(normalizeAreaLabel(area));
      if (!questions) return null;
      return {
        area,
        questions: questions.map((question, questionIndex) => ({
          id: `enrich-${areaIndex}-q${questionIndex}`,
          ...question,
        })),
      };
    })
    .filter(Boolean);
}

// Turn one area's clicked (or typed) answers into a single plainspoken bullet.
// Mirrors the tone rules of formatExperienceElaboration so composed bullets read
// like the rest of the description.
export function buildEnrichedBulletPrompt({ position, area, answers }) {
  const roleContext = position?.trim() ? position.trim() : "this role";
  const answerLines = normalizeStoredList(answers, [])
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      question: String(entry.question ?? "").trim(),
      answer: String(entry.answer ?? "").trim(),
    }))
    .filter((entry) => entry.question && entry.answer)
    .map((entry) => `- Q: ${entry.question}\n  A: ${entry.answer}`)
    .join("\n");

  return `<task>
Write ONE new resume bullet describing work the person confirmed doing, using only their answers below.
</task>

<role_title>
${roleContext}
</role_title>

<responsibility_area>
${String(area ?? "").trim()}
</responsibility_area>

<confirmed_answers>
${answerLines}
</confirmed_answers>

<instructions>
- Write a single factual sentence describing what the person did in this area, weaving the confirmed answers together naturally.
- Start with a past-tense action verb matched to their ownership answer when one is given: owning it suggests verbs like "Led", "Ran", "Owned"; supporting suggests "Supported" or "Contributed to".
- Keep every concrete fact from the answers: numbers, ranges, tools, names, outcomes. State ranges honestly (e.g. "25+" becomes "more than 25"). Invent nothing.
- If an outcome answer says nothing concrete came of it, or there is no outcome answer, do NOT claim or imply a result.
- Use plainspoken language: no buzzwords, no corporate jargon, no embellishment beyond what the answers say.
- Fix grammar, spelling, capitalization, and punctuation. Return a single line with no line break and no leading bullet character or dash.
</instructions>

Return ONLY the sentence as plain text. No quotes, no labels, no explanation, no markdown.`;
}

export function cleanEnrichedBullet(text) {
  return cleanFormattedDetail(text);
}

// Additive counterpart of replaceSentence: append an accepted bullet as a new
// line, matching the existing bullet-marker style and skipping duplicates. The
// duplicate check runs on individual details — including the separate sentences
// of a paragraph-style description — ignoring markers, whitespace, case, and
// trailing punctuation.
export function appendDetailToDescription(description, bullet) {
  const text = String(description ?? "");
  const nextDetail = cleanEnrichedBullet(bullet);
  if (!nextDetail) return { description: text, appended: false };

  const nextNorm = normalizeDetailForComparison(nextDetail);
  const alreadyThere = splitDescriptionIntoDetails(text).some(
    (detail) => normalizeDetailForComparison(detail) === nextNorm
  );
  if (alreadyThere) return { description: text, appended: false };

  const nonEmpty = text.split("\n").filter((line) => line.trim());
  const bulleted = nonEmpty.length > 0 && nonEmpty.every((line) => /^\s*[-•*]\s/.test(line));
  const marker = bulleted ? nonEmpty[0].match(/^(\s*[-•*]\s*)/)?.[1] ?? "- " : "";

  const trimmedText = text.replace(/\s+$/, "");
  const nextLine = `${marker}${nextDetail}`;

  return {
    description: trimmedText ? `${trimmedText}\n${nextLine}` : nextLine,
    appended: true,
  };
}

export const SPARSE_MIN_DETAILS = 3;
export const SPARSE_MIN_AVG_WORDS = 8;

// Heuristic nudge for entries that would benefit from enrichment: fewer than
// three details, or details that average under eight words. Details are counted
// sentence-aware, so a rich paragraph isn't mistaken for one thin line.
// Deliberately does not penalize missing numbers — that would flag too many
// fine descriptions.
export function isSparseDescription(description) {
  const details = splitDescriptionIntoDetails(description);

  if (details.length < SPARSE_MIN_DETAILS) return true;

  const totalWords = details.reduce((sum, detail) => sum + detail.split(/\s+/).length, 0);
  return totalWords / details.length < SPARSE_MIN_AVG_WORDS;
}
