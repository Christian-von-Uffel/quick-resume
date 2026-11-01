import {
  normalizeStoredList,
  splitDescriptionIntoDetails,
  normalizeDetailForComparison,
} from "./resumeModel";
import { cleanFormattedDetail } from "./reviewExperience";
import { renderPromptTemplate } from "./promptTemplate";

// The "Expand experience" flow for a single sparse position. Instead of guessing
// what job POSTINGS for the title demand (which produced abstract "responsibility
// area" wordslop), this chats with the person the way a curious friend would —
// easy, everyday questions they can answer from memory, each picking up on what
// they just said — so it surfaces the real day-to-day, the problems they solve,
// who they solve them for, and what people come to them for:
//   Call 1   buildOpeningQuestionsPrompt  -> 2-3 easy "what takes up your week?" questions
//   Call 2+  buildFollowupQuestionsPrompt  -> next questions that pick up on the transcript, or "enough"
//   Call N   buildComposePrompt            -> 1-3 plainspoken bullets telling the story
// Every option is a candidate the person taps to confirm, never an asserted fact.

// Round 1 is the opening batch; rounds 2..MAX_QA_ROUNDS are adaptive follow-ups.
// The interview also stops early on the model's "enough" signal or the person's
// "Write it up now", so a typical session is 2-3 rounds.
export const MAX_QA_ROUNDS = 4;
export const MAX_QUESTIONS_PER_ROUND = 3;
export const MAX_OPTIONS_PER_QUESTION = 6;
export const MAX_COMPOSED_BULLETS = 3;

// How each question is answered. "yes_no" is a two-chip gate whose options are
// always forced to Yes/No; "multi_select" is the only tap-all-that-apply kind.
export const EXPAND_QUESTION_KINDS = ["single_select", "multi_select", "yes_no"];

const EXPAND_QUESTION_KIND_SET = new Set(EXPAND_QUESTION_KINDS);

// Render the accumulated Q&A as "Q: …\nA: …" blocks for the follow-up and compose
// prompts. Entries missing either side are dropped; an empty transcript yields the
// caller-supplied placeholder.
function formatTranscript(transcript, emptyLabel) {
  const lines = normalizeStoredList(transcript, [])
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      question: String(entry.question ?? "").trim(),
      answer: String(entry.answer ?? "").trim(),
    }))
    .filter((entry) => entry.question && entry.answer)
    .map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`)
    .join("\n\n");
  return lines || emptyLabel;
}

// Shipped opening-questions prompt as a lab-loadable template. `$companyClause`
// is either ` at Acme` or empty; `$tenureBlock` is the optional <tenure> block
// (including leading newlines) or empty — same shape buildOpeningQuestionsPrompt
// always produced.
//
// The prompt is deliberately short: it sets the register (a curious friend
// asking easy questions) and hands over a filled-in example of the shape. The
// shape itself — kinds, option counts, round caps — is enforced by
// validateOpeningQuestions / validateFollowupQuestions, not by rules in the
// prompt.
export const EXPANSION_OPENING_PROMPT_TEMPLATE = `<task>
You're having a friendly, low-key chat with someone about their job as "$jobTitle"$companyClause, so we can help them put into words what they actually do. Ask the first 2 or 3 questions. Each question comes with tappable answers.
</task>

<role_title>
$jobTitle
</role_title>$tenureBlock

<current_description>
$experienceDetails
</current_description>

<how_to_ask>
Ask the way a curious friend would over coffee: one easy thing at a time, in everyday words, so they can answer from memory in a second without having to analyze anything. "What takes up most of your week?" is the right register.
Write the answers the way the person would say them out loud. For an engineer: "Writing code", "Reviewing other people's code", "Figuring out what to build". For a nurse: "Looking after patients", "Giving meds", "Charting". For a line cook: "Cooking on the line", "Prepping before service", "Working on the menu". Give 3 to 6 that fit this role and cover the hands-on work as well as the meetings.
The answers are offers for the person to tap, not facts about them, and they can always tap "Something else…" or "Skip", so the answers don't need to cover everything. Skip anything the current description already says.
</how_to_ask>

<what_the_whole_chat_should_uncover>
What fills their week, which hard or important problems land on their desk, who they do it with and who it's for, roughly how big the company is, and whether they manage people or do the work themselves. The first three get opened here and picked up in later rounds.
</what_the_whole_chat_should_uncover>

<first_questions>
1. A "multi_select" asking what takes up most of their week, with answers that fit "$jobTitle".
2. "Roughly how many people work there?" as a "single_select" with the answers "Just me", "2–10", "11–50", "51–200", "201–1,000", "1,000+".
3. "Do you mostly do the work yourself, or run a team?" as a "single_select" with the answers "I do the work myself", "I run a team", "A bit of both".
</first_questions>

Return only valid JSON matching the schema below. Do not wrap it in markdown fences or add comments.

<schema>
{
  "questions": [
    {
      "kind": "multi_select",
      "question": "What takes up most of your week?",
      "options": ["Writing code", "Reviewing other people's code", "Talking to customers", "Figuring out what to build", "Helping the team get unstuck"]
    },
    {
      "kind": "single_select",
      "question": "Roughly how many people work there?",
      "options": ["Just me", "2–10", "11–50", "51–200", "201–1,000", "1,000+"]
    },
    {
      "kind": "single_select",
      "question": "Do you mostly do the work yourself, or run a team?",
      "options": ["I do the work myself", "I run a team", "A bit of both"]
    }
  ]
}
</schema>`;

// Ask the model for the FIRST 2-3 easy questions: a role-specific "what takes up
// most of your week?" plus two pinned questions (company size and whether they
// run a team) that ground every entry. Problems and collaborators are opened
// here and picked up by the follow-ups.
export function buildOpeningQuestionsPrompt({ position, company, description, tenure }) {
  const roleContext = position?.trim() ? position.trim() : "this role";
  const companyContext = company?.trim() ?? "";
  const tenureTrimmed = tenure?.trim() ?? "";
  return renderPromptTemplate(EXPANSION_OPENING_PROMPT_TEMPLATE, {
    jobTitle: roleContext,
    companyClause: companyContext ? ` at ${companyContext}` : "",
    tenureBlock: tenureTrimmed
      ? `\n\n<tenure>\nAbout ${tenureTrimmed} in the role.\n</tenure>`
      : "",
    experienceDetails: description?.trim() ? description.trim() : "(they haven't written anything yet)",
  });
}

// Given the transcript of what the person has answered so far, ask the next 1-3
// questions that pick up on their answers — or signal "enough" to stop. Bounded
// by round/maxRounds so the final round is told to prefer stopping.
export function buildFollowupQuestionsPrompt({
  position,
  company,
  description,
  tenure,
  transcript,
  round,
  maxRounds,
}) {
  const roleContext = position?.trim() ? position.trim() : "this role";
  const companyContext = company?.trim() ?? "";
  const tenureBlock = tenure?.trim()
    ? `

<tenure>
About ${tenure.trim()} in the role.
</tenure>`
    : "";

  const transcriptLines = formatTranscript(transcript, "(no answers yet)");

  const isFinalRound = round >= maxRounds;
  const roundsLeftSentence = isFinalRound
    ? 'This is the FINAL round. After this we write it up, so ask only what is still open; if everything is covered, set "enough" to true.'
    : "You can ask more in a later round, so pick up the most important open thread first.";

  return `<task>
You're partway through a friendly, low-key chat with someone about their job as "${roleContext}"${companyContext ? ` at ${companyContext}` : ""}. Below is what they've said so far. Ask the next 1 to 3 questions that pick up on their answers, or, once the chat has covered everything in <what_we_still_want>, set "enough" to true so we can write it up.
</task>

<role_title>
${roleContext}
</role_title>${tenureBlock}

<current_description>
${description?.trim() ? description.trim() : "(they haven't written anything yet)"}
</current_description>

<conversation_so_far>
${transcriptLines}
</conversation_so_far>

<where_we_are>
This is round ${round} of at most ${maxRounds}. ${roundsLeftSentence}
</where_we_are>

<how_to_ask>
Ask the way a curious friend would: one easy thing at a time, in everyday words, so they can answer from memory in a second. Pick up on something they just said, the way a real conversation does: "You said you mostly write code. Which part of the app is that?" Build the answers out of what they already told you where you can, written the way they would say them: "The checkout flow", "The stuff customers see", "The servers behind it".
Give a pick-one or pick-many question 3 to 6 answers; use "yes_no" for a quick yes or no. The answers are offers for the person to tap, not facts about them, and they can always tap "Something else…" or "Skip", so the answers don't need to cover everything.
</how_to_ask>

<what_we_still_want>
By the end of the chat we want to know, in their own words:
1. What they mostly do, one step more specific than they've said so far ("Writing code" becomes which part of the app).
2. Which problems land on their desk, the hard or important ones. Something like "What are the tricky problems you end up dealing with?" as a "multi_select", with answers drawn from what they've said.
3. Who they work with and who the work is for. Something like "Who do you spend the most time working with?" as a "multi_select".
If it fits naturally, one easy extra: what people come to them for, like "What do people tend to come to you for?", with a comfortable out such as "Nothing in particular, we all pitch in" so a modest person has an easy answer.
Read the conversation above, skip what's already covered, and ask what's still open this round. Set "enough" to true once 1, 2 and 3 are all covered.
</what_we_still_want>

Return only valid JSON matching the schema below. Do not wrap it in markdown fences or add comments.

<schema>
{
  "enough": false,
  "questions": [
    {
      "kind": "multi_select",
      "question": "What are the tricky problems you end up dealing with?",
      "options": ["Keeping the site fast when traffic spikes", "Bugs customers report", "Figuring out what to build next", "Getting new teammates up to speed"]
    },
    {
      "kind": "multi_select",
      "question": "Who do you spend the most time working with?",
      "options": ["Customers", "Other engineers", "The founders", "The support team"]
    }
  ]
}
</schema>`;
}

// Turn the whole transcript into 1-3 plainspoken bullets telling the
// day-to-day / problems-solved / what's-hard-to-replace story. Returns JSON so it
// can emit more than one bullet; the UI lets the person accept each individually.
export function buildComposePrompt({ position, company, description, tenure, transcript }) {
  const roleContext = position?.trim() ? position.trim() : "this role";
  const companyContext = company?.trim() ?? "";
  const tenureBlock = tenure?.trim()
    ? `

<tenure>
About ${tenure.trim()} in the role.
</tenure>`
    : "";

  const transcriptLines = formatTranscript(transcript, "(no answers were given)");

  return `<task>
Using ONLY the conversation below, write 1 to 3 short bullets that tell the true, plain story of what this person does as "${roleContext}"${companyContext ? ` at ${companyContext}` : ""}: what they spend their days on, the problems they solve and who for, and what's hardest to replace about them. Write the way a clear-headed person describes their own job — no buzzwords, no inflation.
</task>

<role_title>
${roleContext}
</role_title>${tenureBlock}

<already_written>
${description?.trim() ? description.trim() : "(nothing written yet)"}
</already_written>

<conversation>
${transcriptLines}
</conversation>

<instructions>
- Write 1 to 3 bullets. Fewer, fuller bullets beat many thin ones — only split when the work genuinely covers distinct areas. If the conversation is thin, write ONE honest bullet and stop.
- Lead with what they spend the MOST time on — that's the heart of the story — then fold in the problems they solve and who relies on it. If the conversation surfaced an "only I can do this here" angle, give it its own bullet in plain terms; if they were modest about it, don't manufacture one.
- Each bullet is a single line, starts with a past-tense action verb, and drops the leading "I" (the standard way work is written up). No line break, no leading dash or bullet character, no numbering.
- Use ONLY facts the person confirmed. Keep every concrete detail they gave (which side of the stack, which teams, which unit, ranges, tools). State ranges honestly ("15+" becomes "more than 15"). Invent NOTHING — no numbers, tools, employers, clients, or outcomes they did not confirm. If they never confirmed a result, do not imply one.
- Do more than restate the title: show what they actually do, who relies on it, and what makes them good at it, so a reader understands why THIS person specifically is valuable.
- Do NOT duplicate anything already in <already_written>; only add what is new.
- Plain language only. Banned words: spearheaded, leveraged, drove, orchestrated, synergy, cross-functional, stakeholder, ecosystem, robust, seamless, world-class, passionate, results-driven. If tempted to use one, write the plain thing instead.

Return only valid JSON matching the schema below. Do not wrap it in markdown fences or add comments.
</instructions>

<schema>
{
  "bullets": [
    "Built the product full-stack as the founding engineer, owning the database schema, APIs, and the deploy and monitoring pipeline the rest of the team relied on.",
    "Ran customer demos and wrote the product specs, turning what customers needed straight into shipped features."
  ]
}
</schema>`;
}

// Normalize one raw question into the shape the UI renders. yes_no options are
// forced to Yes/No; single/multi need at least two tappable options or they're
// dropped (nothing to pick). The id is provisional — normalizeQuestionList
// re-indexes it after dedupe/cap so ids stay contiguous.
function normalizeQuestion(value, round, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const question =
    typeof value.question === "string" ? value.question.replace(/\s+/g, " ").trim() : "";
  if (!question) return null;

  const helper =
    typeof value.helper === "string" ? value.helper.replace(/\s+/g, " ").trim() : "";

  const kindRaw = typeof value.kind === "string" ? value.kind.trim().toLowerCase() : "";
  const kind = EXPAND_QUESTION_KIND_SET.has(kindRaw) ? kindRaw : "single_select";

  let options;
  if (kind === "yes_no") {
    options = ["Yes", "No"];
  } else {
    const seen = new Set();
    options = normalizeStoredList(value.options, [])
      .map((option) => (typeof option === "string" ? option.replace(/\s+/g, " ").trim() : ""))
      .filter(Boolean)
      .filter((option) => {
        const key = option.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_OPTIONS_PER_QUESTION);
    if (options.length < 2) return null;
  }

  return {
    id: `q-${round}-${index}`,
    kind,
    question,
    helper,
    options,
    multiSelect: kind === "multi_select",
  };
}

// Normalize a round's questions: drop the unusable ones, dedupe by question text,
// cap the round, and give the survivors contiguous ids.
function normalizeQuestionList(rawQuestions, round) {
  const seenQuestions = new Set();
  return normalizeStoredList(rawQuestions, [])
    .map((entry, index) => normalizeQuestion(entry, round, index))
    .filter(Boolean)
    .filter((question) => {
      const key = question.question.toLowerCase();
      if (seenQuestions.has(key)) return false;
      seenQuestions.add(key);
      return true;
    })
    .slice(0, MAX_QUESTIONS_PER_ROUND)
    .map((question, index) => ({ ...question, id: `q-${round}-${index}` }));
}

export function validateOpeningQuestions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid opening questions.");
  }
  return normalizeQuestionList(value.questions, 1);
}

// A follow-up round either carries more questions or signals we have enough. An
// empty or fully-dropped batch is treated as "enough" regardless of the flag, so a
// lazy or malformed response can never trap the person on a blank round.
export function validateFollowupQuestions(value, { round } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid follow-up questions.");
  }
  const roundNumber = Number.isFinite(round) ? round : 2;
  const questions = normalizeQuestionList(value.questions, roundNumber);
  if (!questions.length) return { enough: true, questions: [] };
  return { enough: value.enough === true, questions };
}

// Clean, dedupe, and cap the composed bullets. Reuses the same cleaner and
// comparison the description append uses, so a bullet the person accepts matches
// what appendDetailToDescription then dedupes against.
export function validateComposedBullets(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid bullets.");
  }
  const seen = new Set();
  return normalizeStoredList(value.bullets, [])
    .map(cleanEnrichedBullet)
    .filter(Boolean)
    .filter((bullet) => {
      const key = normalizeDetailForComparison(bullet);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_COMPOSED_BULLETS);
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
