import {
  normalizeStoredList,
  splitDescriptionIntoDetails,
  normalizeDetailForComparison,
} from "./resumeModel";
import { cleanFormattedDetail } from "./reviewExperience";

// The conversational "Interview me" flow for one position. One plain question
// per turn, each tied back to something the person said, aimed at the problems
// their work solved for a business. The person wraps up whenever they like, and
// the answers become suggestions framed the way a hiring manager buys them:
// a business problem, how this person solved it, what they made, and the result.
//   buildInterviewQuestionPrompt    -> { heard, context, question, examples }
//   buildInterviewSuggestionsPrompt -> { suggestions: [{ problem, bullet }], left_out }
// Each response is checked against its format; a miss gets one repair call
// carrying the list of problems (buildInterviewRepairPrompt).

// Shown by the UI before the first question; the model never writes it.
export const INTERVIEW_INTRO =
  "We'll ask you some quick questions to understand more about what you do. Afterward, we'll suggest additions to your work experience that you can keep or skip. You can tap Wrap up at any time.";

// Sample answers per question: enough to show the kind of answer wanted, few
// enough to read at a glance.
export const MIN_EXAMPLES = 2;
export const MAX_EXAMPLES = 4;

const collapse = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

function knownBlock({ position, company, description, tenure }) {
  const lines = [`Title: ${collapse(position) || "(no title)"}`];
  if (collapse(company)) lines.push(`Company: ${collapse(company)}`);
  if (collapse(tenure)) lines.push(`Time in the role: about ${collapse(tenure)}`);
  const written = String(description ?? "").trim();
  lines.push("", "Current description:", written || "(nothing written yet)");
  return lines.join("\n");
}

// Transcript entries are { context, question, answer, skipped }. Skipped turns
// stay in so the model moves on instead of asking the same thing again.
export function formatInterviewTranscript(transcript) {
  const turns = normalizeStoredList(transcript, [])
    .filter((entry) => entry && typeof entry === "object" && collapse(entry.question))
    .map((entry) => {
      const answer = entry.skipped ? "(skipped)" : collapse(entry.answer) || "(no answer)";
      return `Q: ${collapse(entry.question)}\nA: ${answer}`;
    });
  return turns.join("\n\n");
}

export function buildInterviewQuestionPrompt({ position, company, description, tenure, transcript }) {
  const title = collapse(position) || "this role";
  const companyClause = collapse(company) ? ` at ${collapse(company)}` : "";
  const conversation = formatInterviewTranscript(transcript);

  return `<task>
You are interviewing someone about their job as "${title}"${companyClause}. The goal is to find details for their work experience that show a hiring manager which problems this person can solve for a business. Write the next single question.
</task>

<known_already>
${knownBlock({ position, company, description, tenure })}
</known_already>

<conversation_so_far>
${conversation || "(this is the first question)"}
</conversation_so_far>

<what_to_ask_about>
Work down this list and ask about the first thing still unknown:
1. Who the work was mainly for, asked about the thing they made, like "Who was the online order form mainly for?" Then what those people did before it existed, like "Before the order form, how did customers place orders?"
2. Who relied on the work, and what would break or pile up if they stopped doing it, asked like "Who counts on those posts?" or "What would pile up if you stopped?"
3. How they solved it: the method, tools, channels, and skills they used.
4. What they made: deliverables like reports, dashboards, videos, posters, apps, or new processes.
5. What usually goes wrong with a task they already mentioned, and how they handle it. This takes two turns. First ask what goes wrong, with "context" pointing to the task and "examples" listing mistakes common to it, like "Typos", "Wrong event dates", or "Blurry images" for social media posts. When they name a mistake, ask what they do to catch or prevent it, with "examples" listing likely checks.
6. The result, in their own numbers. When they give a number, ask how they got there.
Follow their last answer one layer deeper when it opened something new, then move to the next unknown. When two answers seem to overlap or conflict, ask a short question to clear it up. The title, company, and time in the role above are already known.
</what_to_ask_about>

<how_to_write_it>
The person may be tired. Each question asks for one small fact they can answer in a few words; you put the pieces together at the end. Write the way people talk to a friend, in plain everyday words.
- "heard": one plain sentence restating their last answer, naming what it shows when that is clear (time saved, a skill, a problem solved). For the first question, or right after a skipped one, use "".
- "context": one or two short sentences showing why you are asking, filled in like "Your work description says you <what it says>. It doesn't say <the piece still missing>." or "Earlier you said <their words from an earlier answer>." When the question follows straight from "heard", use "", since "heard" already shows why.
- "question": one short question that makes sense read on its own, ending with a question mark. It names the thing it asks about in their words, like "Who was the online order form mainly for?" rather than "Who was it for?"
- "examples": ${MIN_EXAMPLES} to ${MAX_EXAMPLES} short sample answers they could tap, each a few words.
</how_to_write_it>

Return only a JSON object in this shape:

{
  "heard": "So you went from baking everything yourself to training two new bakers.",
  "context": "You said the shop sells out of bread most Saturdays.",
  "question": "About how many loaves of bread do you bake on a Saturday?",
  "examples": ["Under 100", "100 to 300", "More than 300"]
}`;
}

// Words that name something, so a question can be matched to the work it's
// about. Question words and filler don't count; plurals match singulars.
const FILLER_WORDS = new Set(
  (
    "a an the and or but of to in on at for by with from into about over under as is are was were be been " +
    "do does did doesn have has had it its this that these those there their they them you your yours i me my we our " +
    "what which who whom whose when where why how much many most more some any each every one ever just also " +
    "out get got can not all than then own way usually mainly mostly really roughly around before after " +
    "said say says mention mentioned talk work description"
  ).split(" ")
);

function namingWords(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((word) => word.length > 2 && !FILLER_WORDS.has(word))
      .map((word) => (word.length > 3 ? word.replace(/s$/, "") : word)) ?? []
  );
}

// Format check for one question turn. Returns the cleaned turn plus every way
// it misses the format; an empty problems list means it can be shown as is.
// `known` is everything already written about the job (title, company,
// description), which the question can name as well as the context.
export function checkInterviewQuestion(value, { transcript = [], known = "" } = {}) {
  const problems = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { turn: null, problems: ["Return a single JSON object with heard, context, question, and examples."] };
  }

  const question = collapse(value.question);
  const context = collapse(value.context);
  const heard = collapse(value.heard);

  const seen = new Set();
  const examples = normalizeStoredList(value.examples, [])
    .map(collapse)
    .filter(Boolean)
    .filter((example) => {
      const key = example.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_EXAMPLES);

  if (!question) {
    problems.push('"question" is empty. Write one short question.');
  } else {
    const marks = (question.match(/\?/g) ?? []).length;
    if (marks !== 1 || !question.endsWith("?")) {
      problems.push(`"question" should be exactly one question ending with a question mark: "${question}"`);
    }
    const asked = normalizeStoredList(transcript, []).map((entry) => collapse(entry?.question).toLowerCase());
    if (asked.includes(question.toLowerCase())) {
      problems.push(`"question" was already asked earlier. Ask about something still unknown.`);
    }
    // A question that names nothing from their work ("Who had the biggest
    // headache you set out to fix?") only makes sense after reading the context.
    const answers = normalizeStoredList(transcript, []).map((entry) => entry?.answer);
    const about = namingWords([heard, context, known, ...answers].join("\n"));
    if (![...namingWords(question)].some((word) => about.has(word))) {
      problems.push(
        `"question" has to make sense read on its own. Name the task or thing it asks about, in their words: "${question}"`
      );
    }
  }
  if (!context && !heard) {
    problems.push('"context" and "heard" are both empty. Point to what they said, or what the description says, that this question follows from.');
  }
  if (examples.length < MIN_EXAMPLES) {
    problems.push(`"examples" needs ${MIN_EXAMPLES} to ${MAX_EXAMPLES} short sample answers.`);
  }

  const turn = question ? { heard, context, question, examples } : null;
  return { turn, problems };
}

export function buildInterviewSuggestionsPrompt({ position, company, description, tenure, transcript }) {
  const title = collapse(position) || "this role";
  const companyClause = collapse(company) ? ` at ${collapse(company)}` : "";

  return `<task>
The person wrapped up the interview. Turn what they told you into suggested additions to their work experience as "${title}"${companyClause}. Each suggestion shows a hiring manager a problem this person can solve for their business, stated as work the person has already done.
</task>

<known_already>
${knownBlock({ position, company, description, tenure })}
</known_already>

<interview>
${formatInterviewTranscript(transcript) || "(no answers)"}
</interview>

<how_to_write_each_suggestion>
- "problem": 2 to 6 words naming the business problem solved or the skill an employer hires for, like "Cut manual data entry", "Designed sales dashboards", "Reached customers who miss social posts", or "Ran low-cost local marketing".
- "bullet": one or two sentences that start with a past-tense verb. Say what they did, how they did it (methods, tools, channels), what they made (deliverables), and the result in the numbers they gave.
- Frame each suggestion around what a business gets from it: time or money saved, a risk removed, customers reached, or a deliverable it needs someone to make.
- When they said what they do to catch or prevent a mistake, write the check they do and what it prevents, like "Verified event details with organizers before posting, preventing incorrect listings."
- When they said who relied on the work, name those people and what the work let them do.
- Name features specific to their company by the transferable skill behind them, like "set up push notifications" or "built a quality check for incoming data".
- Write every bullet from facts in the interview or the current description, using their numbers as they gave them, and describe status exactly as they did: work still in testing or not yet used stays that way. Each suggestion adds something the current description does not already say.
- "left_out": things they mentioned but could not back up, like unknown numbers or results they believe but have no proof of, each with a short reason. Use [] when nothing was left out.
</how_to_write_each_suggestion>

Return only a JSON object in this shape:

{
  "suggestions": [
    {
      "problem": "Cut food waste",
      "bullet": "Cut unsold bread from about 40 loaves a week to 10 by tracking Saturday sales in a spreadsheet and baking to the trend."
    }
  ],
  "left_out": ["That customers came back more often, since there are no numbers on repeat visits yet."]
}`;
}

// Numbers as values, so "5k", "5,000", and "5000" match each other.
function numbersIn(text) {
  const values = [];
  const pattern = /(\d[\d,]*(?:\.\d+)?)(\s*(?:k\b|thousand\b))?(\s*(?:%|percent\b))?/gi;
  for (const match of String(text ?? "").matchAll(pattern)) {
    const base = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    values.push({
      value: match[2] ? base * 1000 : base,
      percent: Boolean(match[3]),
    });
  }
  return values;
}

// Format check for the wrap-up. Every number in a bullet has to be one the
// person gave (percentages are allowed as arithmetic on their numbers), so a
// suggestion never asserts a figure they didn't state.
export function checkInterviewSuggestions(
  value,
  { position = "", company = "", description = "", tenure = "", transcript = [] } = {}
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      suggestions: [],
      leftOut: [],
      problems: ["Return a single JSON object with suggestions and left_out."],
    };
  }

  const sourceText = [
    position,
    company,
    description,
    tenure,
    ...normalizeStoredList(transcript, []).flatMap((entry) => [entry?.question, entry?.answer]),
  ].join("\n");
  const known = new Set(numbersIn(sourceText).map((entry) => entry.value));

  const existing = new Set(splitDescriptionIntoDetails(description).map(normalizeDetailForComparison));
  const seen = new Set();
  const problems = [];

  const suggestions = normalizeStoredList(value.suggestions, [])
    .map((entry) => ({
      problem: collapse(entry?.problem),
      bullet: cleanFormattedDetail(typeof entry?.bullet === "string" ? entry.bullet : ""),
    }))
    .filter((entry) => {
      if (!entry.bullet) return false;
      const key = normalizeDetailForComparison(entry.bullet);
      if (seen.has(key) || existing.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (!suggestions.length) {
    problems.push('"suggestions" is empty. Write at least one suggestion from the interview.');
  }

  const checked = suggestions.map((entry) => {
    if (!entry.problem) {
      problems.push(`Add a "problem" label for: "${entry.bullet}"`);
    }
    if (/^(i|my|we|our)\b/i.test(entry.bullet)) {
      problems.push(`Start this bullet with a past-tense verb: "${entry.bullet}"`);
    }
    const unstated = numbersIn(entry.bullet)
      .filter((number) => !number.percent && !known.has(number.value))
      .map((number) => number.value);
    if (unstated.length) {
      problems.push(
        `This bullet uses ${unstated.join(", ")}, which the person never said. Use only their numbers: "${entry.bullet}"`
      );
    }
    return { ...entry, grounded: unstated.length === 0 };
  });

  const leftOut = normalizeStoredList(value.left_out, []).map(collapse).filter(Boolean);
  return { suggestions: checked, leftOut, problems };
}

// One-shot repair: the original prompt, the response that missed, and exactly
// what to fix. Carrying the original prompt lets the model re-check facts, not
// just reshape JSON.
export function buildInterviewRepairPrompt(originalPrompt, response, problems) {
  return `${originalPrompt}

<your_previous_answer>
${JSON.stringify(response ?? null, null, 2)}
</your_previous_answer>

<fix_these>
${problems.map((problem) => `- ${problem}`).join("\n")}
</fix_these>

Return the corrected JSON object only.`;
}

// Run a JSON call, check it, and when it misses the format, send one repair
// carrying the problems. Keeps whichever answer has fewer problems, so a repair
// that makes things worse (or fails outright) never replaces a usable answer.
// `callJson(prompt, { repairOf })` is the caller's bound callLlmForJson;
// repairOf is the original prompt when the call is a repair.
async function callWithOneRepair(callJson, prompt, check) {
  const first = await callJson(prompt, { repairOf: null });
  const firstResult = check(first);
  if (!firstResult.problems.length) return firstResult;

  try {
    const second = await callJson(buildInterviewRepairPrompt(prompt, first, firstResult.problems), {
      repairOf: prompt,
    });
    const secondResult = check(second);
    return secondResult.problems.length <= firstResult.problems.length ? secondResult : firstResult;
  } catch {
    return firstResult;
  }
}

export async function askInterviewQuestion(callJson, args) {
  const prompt = buildInterviewQuestionPrompt(args);
  const known = [args.position, args.company, args.description].join("\n");
  const { turn } = await callWithOneRepair(callJson, prompt, (value) =>
    checkInterviewQuestion(value, { transcript: args.transcript, known })
  );
  if (!turn) throw new Error("Couldn't come up with the next question. Try again.");
  return turn;
}

// Suggestions that still carry a number the person never gave are dropped
// rather than shown: the promise is that nothing gets invented.
export async function suggestFromInterview(callJson, args) {
  const prompt = buildInterviewSuggestionsPrompt(args);
  const { suggestions, leftOut } = await callWithOneRepair(callJson, prompt, (value) =>
    checkInterviewSuggestions(value, args)
  );
  const grounded = suggestions
    .filter((entry) => entry.grounded)
    .map(({ problem, bullet }) => ({ problem, bullet }));
  if (!grounded.length) {
    throw new Error("Couldn't write suggestions from those answers. Answer a bit more, then try again.");
  }
  return { suggestions: grounded, leftOut };
}
