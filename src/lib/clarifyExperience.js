import { normalizeStoredList } from "./resumeModel";
import { cleanFormattedDetail } from "./reviewExperience";

// Ask the model to flag the work-history sentences that are hardest to read and,
// for each, pose a plain "what do you mean by this?" question with a few concrete
// interpretations the person can pick from. The position title is passed only as
// context for what the work likely involved — never as license to invent facts.
export function buildClarityReviewPrompt({ position, description }) {
  const roleContext = position?.trim() ? position.trim() : "this role";

  return `<task>
You are reviewing the bullet points from a resume work-history entry for the role "${roleContext}".
1. Find the sentences that are hardest for a reader to understand — vague, jargon-heavy, ambiguous, or unclear about what the person actually did or achieved.
2. For each confusing sentence, write a simple, conversational question asking what the person meant.
3. Offer up to three concrete interpretations of what the sentence could mean, so the person can just pick the one that matches.
4. Where the sentence and role plausibly imply specific job skills, software, methods, or collaboration with other stakeholders, list them as optional add-ons the person can confirm.
</task>

<role_title>
${roleContext}
</role_title>

<description>
${description}
</description>

<instructions>
- Only flag sentences that are genuinely hard to understand. If every sentence is already clear, return an empty array.
- Copy each flagged "sentence" VERBATIM from the description, character for character, so it can be found and replaced. Never paraphrase, trim, or merge sentences here.
- Use the role title only as context for what the work probably involved. Do not assume or invent facts that are not in the sentence.
- Write "question" in plain, conversational language that quotes the confusing part, e.g. What do you mean by "drove cross-functional synergy"?
- For "options", give two or three short, distinct plain-language readings of the sentence — each phrased so the person would recognize it as "yes, that is what I meant." Provide at most three. Never invent specific numbers, tools, or names that are not implied by the sentence.
- For "skillOptions", list up to six short candidates the person can confirm as part of this work: functional job skills (e.g. "Usability testing"), software or tools common for this kind of work in this role (e.g. "Figma"), or stakeholder collaboration when the sentence implies working with others (e.g. "Collaborated with engineering"). These are candidates to confirm, NOT facts — it is fine to suggest tools typical for the role even when the sentence does not name them, because the person chooses which apply. Do not repeat something the sentence already states outright. If nothing plausible is implied, return an empty array.
- Limit to the 5 most confusing sentences.
- Return only valid JSON matching the schema below. Do not wrap it in markdown fences or add comments.
</instructions>

<schema>
{
  "confusingSentences": [
    {
      "sentence": "Exact sentence copied verbatim from the description.",
      "reason": "Short note on why this is hard to understand.",
      "question": "What do you mean by \\"...\\"?",
      "options": [
        "A plain-language reading of what the sentence might mean.",
        "A different plain-language reading.",
        "A third plain-language reading."
      ],
      "skillOptions": [
        "A job skill, tool, or method plausibly used here.",
        "Collaborated with <a stakeholder the sentence implies>."
      ]
    }
  ]
}
</schema>`;
}

function normalizeConfusingSentence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const sentence = typeof value.sentence === "string" ? value.sentence.trim() : "";
  if (!sentence) return null;

  const options = normalizeStoredList(value.options, [])
    .map((option) => (typeof option === "string" ? option.trim() : ""))
    .filter(Boolean)
    .slice(0, 3);

  const seenSkills = new Set();
  const skillOptions = normalizeStoredList(value.skillOptions, [])
    .map((skill) => (typeof skill === "string" ? skill.trim() : ""))
    .filter(Boolean)
    .filter((skill) => {
      const key = skill.toLowerCase();
      if (seenSkills.has(key)) return false;
      seenSkills.add(key);
      return true;
    })
    .slice(0, 6);

  const question =
    typeof value.question === "string" && value.question.trim()
      ? value.question.trim()
      : `What do you mean by "${sentence}"?`;

  return {
    sentence,
    reason: typeof value.reason === "string" ? value.reason.trim() : "",
    question,
    options,
    skillOptions,
  };
}

export function validateClarityReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return a valid clarity review.");
  }

  return normalizeStoredList(value.confusingSentences, [])
    .map(normalizeConfusingSentence)
    .filter(Boolean)
    // A sentence with no interpretation options gives the person nothing to pick,
    // so drop it rather than render a dead-end question.
    .filter((item) => item.options.length > 0)
    .map((item, index) => ({ id: `clarify-${index}`, ...item }));
}

// Rewrite one flagged sentence using the person's clarification — either an
// interpretation they picked or their own typed answer — plus any skills, tools,
// or collaborators they confirmed were part of the work. Mirrors the tone rules of
// the elaboration formatter so rewrites stay plainspoken and factual.
export function buildClaritySuggestionPrompt({ position, sentence, clarification, skills }) {
  const roleContext = position?.trim() ? position.trim() : "this role";

  const confirmedSkills = normalizeStoredList(skills, [])
    .map((skill) => (typeof skill === "string" ? skill.trim() : ""))
    .filter(Boolean);

  const skillsBlock = confirmedSkills.length
    ? `

<confirmed_skills_and_tools>
${confirmedSkills.map((skill) => `- ${skill}`).join("\n")}
</confirmed_skills_and_tools>`
    : "";

  const skillsInstruction = confirmedSkills.length
    ? `
- The person confirmed that everything under <confirmed_skills_and_tools> was part of this work, so treat those as facts. Weave each one into the rewrite naturally — name the tools, methods, or collaborators plainly where they fit rather than appending a mechanical list.`
    : "";

  return `<task>
Rewrite ONE resume bullet so it is clear and easy to understand, using the person's clarification of what they meant.
</task>

<role_title>
${roleContext}
</role_title>

<original_sentence>
${sentence}
</original_sentence>

<what_they_meant>
${clarification}
</what_they_meant>${skillsBlock}

<instructions>
- Rewrite the original sentence to say plainly what the clarification describes. Keep the person's own level of detail — do not add buzzwords, corporate jargon, or embellishment.
- Start with a past-tense action verb. Remove vague filler and unexplained jargon.
- Keep every concrete fact (names, places, numbers, tools, outcomes) that appears in the original or the clarification. Invent nothing new.${skillsInstruction}
- Fix grammar, spelling, capitalization, and punctuation. Return a single line with no line break and no leading bullet character or dash.
</instructions>

Return ONLY the rewritten sentence as plain text. No quotes, no labels, no explanation, no markdown.`;
}

export function cleanSuggestedSentence(text) {
  return cleanFormattedDetail(text);
}

// Swap a flagged sentence for its accepted rewrite inside a description of any
// shape — bullet lines or flowing paragraph sentences. Tries an exact substring
// first, then the same match tolerating whitespace differences (wrapped lines,
// double spaces), then falls back to matching a whole line while ignoring
// bullet markers and whitespace, preserving that line's prefix.
export function replaceSentence(description, original, replacement) {
  const text = String(description ?? "");
  const target = String(original ?? "").trim();
  const nextSentence = cleanSuggestedSentence(replacement);

  if (!target || !nextSentence) return { description: text, replaced: false };

  // Function replacements keep "$&"/"$$" in a rewrite literal instead of being
  // treated as replacement patterns (e.g. a sentence mentioning dollar amounts).
  if (text.includes(target)) {
    return { description: text.replace(target, () => nextSentence), replaced: true };
  }

  // Whitespace-tolerant exact match: the flagged sentence may sit inside a
  // paragraph whose spacing or line wrapping no longer matches character for
  // character.
  const flexibleTarget = new RegExp(
    target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")
  );
  if (flexibleTarget.test(text)) {
    return { description: text.replace(flexibleTarget, () => nextSentence), replaced: true };
  }

  const normalize = (line) =>
    line
      .replace(/^\s*[-•*]\s*/, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const targetNorm = normalize(target);
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    if (normalize(lines[i]) === targetNorm) {
      const prefix = lines[i].match(/^(\s*[-•*]\s*)/)?.[1] ?? "";
      lines[i] = `${prefix}${nextSentence}`;
      return { description: lines.join("\n"), replaced: true };
    }
  }

  return { description: text, replaced: false };
}
