import {
  normalizeStoredList,
  splitDescriptionIntoDetails,
  normalizeDetailForComparison,
} from "./resumeModel";
import { cleanFormattedDetail } from "./reviewExperience";

// The "Expand experience" flow for a single sparse position. Instead of guessing
// what job POSTINGS for the title demand (which produced abstract "responsibility
// area" wordslop), this asks the person a few dead-simple, grounded questions about
// what they actually do, then branches off their own answers like a friendly
// colleague — so it surfaces the real day-to-day, the problems they solve, who they
// solve them for, and what's hardest to replace about them:
//   Call 1   buildOpeningQuestionsPrompt  -> 2-3 simple "what do you spend your time on?" questions
//   Call 2+  buildFollowupQuestionsPrompt  -> next questions that branch off the transcript, or "enough"
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

// Ask the model for the FIRST 2-3 dead-simple questions: a role-specific "what do
// you spend most of your time on?" plus two universal, verbatim-pinned questions
// (company size and IC-vs-manager) that ground every entry. High-value problems
// and who they collaborate with are opened here and dug into by the follow-ups.
export function buildOpeningQuestionsPrompt({ position, company, description, tenure }) {
  const roleContext = position?.trim() ? position.trim() : "this role";
  const companyContext = company?.trim() ?? "";
  const tenureBlock = tenure?.trim()
    ? `

<tenure>
About ${tenure.trim()} in the role.
</tenure>`
    : "";

  return `<task>
Ask short, direct questions to find out what someone actually does in their job as "${roleContext}"${companyContext ? ` at ${companyContext}` : ""}. We want to understand more about what they do in their role. Ask the FIRST 2 or 3 questions. You only ask questions with tappable answer options.
</task>

<role_title>
${roleContext}
</role_title>${tenureBlock}

<current_description>
${description?.trim() ? description.trim() : "(they haven't written anything yet)"}
</current_description>

<what_to_find_out>
Across the whole conversation we want to learn, in plain terms:
1. What work they spend the most time doing.
2. What high-value problems they work on — the hard or important stuff, not the busywork.
3. Which people or teams they work with, and who they do the work for.
4. How many people work at the company.
5. Whether they do the work themselves or manage other people.
Items 4 and 5 are your opening questions below. Items 1-3 you open here and dig into later.
</what_to_find_out>

<question_rules>
Write every question so a literal-minded 12-year-old could answer it without guessing what you mean.
- One question asks about ONE thing. Never join two things with "and" or "or".
- Short, common words. No jargon, no abbreviations, no buzzwords.
- Say it straight. No "Let's", "Tell me about", "Walk me through", greetings, or compliments.
- Ask about things a person DID — actions you could have watched. Not feelings, opinions, or their "role" in the abstract.
- Each question can be read only one way. If a word is fuzzy ("impact", "ownership", "involvement"), cut it and name the concrete thing.
- No idioms, metaphors, or sarcasm. No double negatives.
- Every question is answerable by tapping: pick one, tap all that apply, or Yes/No.
</question_rules>

<questions_to_ask>
- Question 1 — a "multi_select": "What do you spend most of your time on?" Give 4 to 6 concrete options that are plain things a person would actually say for THIS role. Match the altitude of these:
  * software engineer: "Writing code", "Talking to users", "Reviewing others' work", "Planning what to build", "Managing the team"
  * nurse: "Direct patient care", "Giving medications", "Charting", "Coordinating with doctors", "Training newer nurses"
  * line cook: "Working the line", "Prepping", "Plating and expediting", "Building the menu", "Ordering and inventory"
- Question 2 — a "single_select", asked exactly like this: "How many people work at the company?" Options, in this order: "Just me", "2–10", "11–50", "51–200", "201–1,000", "1,000+".
- Question 3 — a "single_select", asked exactly like this: "Do you manage other people, or do the work yourself?" Options, in this order: "I do the work myself", "I manage a team", "I do both".
- Keep Questions 2 and 3 word-for-word as written above, with those exact options.

<rules>
- Ground Question 1's options in what someone with this title, tenure, and description plausibly does. Cover the real breadth of the week, INCLUDING the hands-on work, not only meetings and management. Only include leading, managing, hiring, budget, or strategy options when the title or tenure supports them.
- Every option is a candidate the person taps to confirm — NEVER a stated fact. No invented tool names, employer names, clients, numbers, or results. Number ranges only for how-many / how-often questions, smallest first.
- A "Something else…" free-text escape and a "Skip" are added to every question automatically, so do NOT add a catch-all, "Other", or "N/A" option.
- Ask nothing the current description already states.

FORBIDDEN — never produce any of these:
- Job-posting or "responsibility area" wording as a question or option. Banned examples: "Stakeholder management", "Cross-functional collaboration", "Strategic planning", "Process optimization", "Product metrics instrumentation", "Engineering standards definition", "Operational excellence", "Partnership negotiation". If it reads like a job-posting line or a LinkedIn skill tag, rewrite it as something a person would SAY.
- Buzzwords anywhere: spearheaded, leveraged, drove, orchestrated, synergy, results-driven.
- Chatty or padded question wording ("Let's…", "Tell me about…", "Walk me through…"). Keep questions bare and direct.
- Compound questions, or any question that needs a number, dollar figure, or exact date typed in to answer.
</rules>

Return only valid JSON matching the schema below. Do not wrap it in markdown fences or add comments.

<schema>
{
  "questions": [
    {
      "kind": "multi_select",
      "question": "What do you spend most of your time on?",
      "options": ["A real thing people say", "Another real thing", "Another", "Another"]
    },
    {
      "kind": "single_select",
      "question": "How many people work at the company?",
      "options": ["Just me", "2–10", "11–50", "51–200", "201–1,000", "1,000+"]
    },
    {
      "kind": "single_select",
      "question": "Do you manage other people, or do the work yourself?",
      "options": ["I do the work myself", "I manage a team", "I do both"]
    }
  ]
}
</schema>`;
}

// Given the transcript of what the person has answered so far, ask the next 1-3
// questions that branch off their answers — or signal "enough" to stop. Bounded by
// round/maxRounds so the final round is told to prefer stopping.
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
    ? 'This is the FINAL round. After this we finish up, so ask only the checklist items still missing; if all are covered, set "enough" to true.'
    : "You can ask more in a later round, so cover the most important missing item first.";

  return `<task>
Ask the next short, direct questions to learn more about what this person does as "${roleContext}"${companyContext ? ` at ${companyContext}` : ""}. Below is what they have told you so far. Either ask 1 to 3 more questions that build on their answers, or — once everything in the checklist below is covered — set "enough" to true so we can write it up.
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

<question_rules>
Write every question so a literal-minded 12-year-old could answer it without guessing what you mean.
- One question asks about ONE thing. Never join two things with "and" or "or".
- Short, common words. No jargon, no abbreviations, no buzzwords.
- Say it straight. No "Let's", "Tell me about", "Walk me through", greetings, or compliments.
- Ask about things a person DID — actions you could have watched. Not feelings, opinions, or their "role" in the abstract.
- Each question can be read only one way. If a word is fuzzy ("impact", "ownership", "involvement"), cut it and name the concrete thing.
- No idioms, metaphors, or sarcasm. No double negatives.
- Every question is answerable by tapping: pick one, tap all that apply, or Yes/No.
- Build the options out of what they ALREADY said whenever you can.
</question_rules>

<must_cover_before_stopping>
The conversation must cover ALL THREE of these before you set "enough" to true. Read what they have already answered above, skip anything covered, and ask whatever is still missing THIS round:
1. Their main work, dug ONE concrete layer deeper than they have said so far. Example: they said "Writing code" -> ask "Which part of the app do you build?" with options like "Front-end", "Back-end", "Full-stack", "Infrastructure".
2. Which problems they work on — the hard or important ones, not the busywork. Ask it plainly, e.g. "Which problems do you work on?" as a "multi_select", with concrete options built from their answers.
3. Who they work with, and who they do the work for. Ask it plainly, e.g. "Who do you work with?" as a "multi_select", with options like "Customers", "Other engineers", "A co-founder", "Another team".
Only set "enough" to true once all three are covered. Do not stop early with any of them missing.
</must_cover_before_stopping>

<also_try>
If it fits naturally, ask ONE gentle question about what is hardest to replace about them — e.g. "What is the part others would find hard to cover for you?" — and ALWAYS include an easy out like "Honestly, someone else could cover it", so a modest person is never pushed to overclaim. Skip it if it would feel like a stretch.
</also_try>

<instructions>
- If all three checklist items are already covered, set "enough" to true and return "questions": [].
- Otherwise ask 1 to 3 NEW questions that cover what is still missing. Never re-ask or reword anything already answered above, and never ask what the current description already states.
- Kinds: "single_select", "multi_select", "yes_no". Give single/multi questions 2 to 6 short options (2 to 8 plain words each), mutually distinct. A "Something else…" free-text escape and a "Skip" are added automatically — do NOT add a catch-all, "Other", or "N/A" option.
- Every option is a candidate the person taps to confirm — NEVER a fact. Never invent numbers, tool names, employers, clients, or outcomes. Number ranges (smallest first) only for how-many / how-often questions.

FORBIDDEN — never produce any of these:
- Job-posting or "responsibility area" wording as a question or option ("Stakeholder management", "Cross-functional collaboration", "Process optimization", "Strategic planning", "Operational excellence"). If it reads like a job-posting line or a LinkedIn skill tag, rewrite it as something a person would SAY.
- Buzzwords: spearheaded, leveraged, drove, orchestrated, synergy, results-driven.
- Chatty or padded question wording ("Let's…", "Tell me about…", "Walk me through…"). Keep questions bare and direct.
- Compound questions, or any question that needs a number, dollar figure, or exact date typed in to answer.

Return only valid JSON matching the schema below. Do not wrap it in markdown fences or add comments.
</instructions>

<schema>
{
  "enough": false,
  "questions": [
    {
      "kind": "multi_select",
      "question": "Which problems do you work on?",
      "options": ["A real problem they handle", "Another", "Another", "Another"]
    },
    {
      "kind": "multi_select",
      "question": "Who do you work with?",
      "options": ["Customers", "Other engineers", "A co-founder", "Another team"]
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
