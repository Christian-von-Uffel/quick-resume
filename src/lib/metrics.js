// Product metrics: what people actually do with the smart features.
//
// Writes the six metric tables plus `questions` and `suggestions` from the
// browser, under the signed-in user's session, so row-level security scopes
// every insert to their own rows. That's the same trust model as the rest of
// their data — faking your own analytics buys you nothing, and a download is
// invisible to the server anyway. What a model call COST is the unspoofable
// half, and only the API routes write that (see src/lib/server/llmCalls.js).
//
// Two rules this module lives by:
//   1. Metrics never break a feature. Every write is fire-and-forget and every
//      failure is swallowed. Callers get an id back synchronously and never
//      await anything.
//   2. Ids are minted here so a caller can thread a question id into UI state
//      before the row exists in Postgres.

import { PROMPT_VERSIONS } from "./prompts";

let client = null;
let userId = null;
let promptIdsPromise = null;

// Writes are chained rather than fired concurrently: questions and suggestions
// carry foreign keys into rows written moments earlier, so an insert that
// overtook its own parent would be rejected outright. A few dozen rows per
// session — a single FIFO queue costs nothing.
let chain = Promise.resolve();

export function configureMetrics({ supabase = null, user = null } = {}) {
  client = supabase;
  userId = user;
  promptIdsPromise = null;
}

const isReady = () => Boolean(client && userId);

// crypto.randomUUID needs a secure context; metrics must never be the reason a
// feature throws, so fall back to a v4-shaped id.
function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function enqueue(task) {
  chain = chain.then(task).catch((error) => {
    // Deliberately terminal: a failed metrics write must not stall the queue
    // behind it or surface to the user.
    if (process.env.NODE_ENV !== "production") {
      console.warn("[metrics]", error?.message ?? error);
    }
  });
  return chain;
}

// supabase-js reports failures in the result rather than throwing.
async function write(label, query) {
  const { error } = await query;
  if (error) throw new Error(`${label}: ${error.message ?? "request failed"}`);
}

async function fetchPromptIds() {
  const { data, error } = await client.from("prompts").select("id, key, version");
  if (error || !Array.isArray(data)) return null;
  return new Map(data.map((row) => [`${row.key}@${row.version}`, row.id]));
}

function getPromptIds() {
  if (!promptIdsPromise) {
    promptIdsPromise = fetchPromptIds();
    // A failed fetch must not poison the cache, or prompt_id stays null for the
    // rest of the session.
    promptIdsPromise.then((map) => {
      if (!map) promptIdsPromise = null;
    });
  }
  return promptIdsPromise;
}

// Resolves a key to the prompts.id of the version this build ships. Null (an
// unknown key, or a failed fetch) leaves prompt_id empty rather than dropping
// the row: a question without prompt attribution still counts as presented.
async function promptIdFor(key) {
  if (!key) return null;
  const version = PROMPT_VERSIONS[key];
  if (!version) return null;
  const map = await getPromptIds();
  return map?.get(`${key}@${version}`) ?? null;
}

function insert(table, row) {
  const id = row.id ?? newId();
  if (!isReady()) return id;
  enqueue(() => write(`${table} insert`, client.from(table).insert({ ...row, id, user_id: userId })));
  return id;
}

function update(table, id, patch) {
  if (!isReady() || !id) return;
  enqueue(() =>
    write(`${table} update`, client.from(table).update(patch).eq("id", id).eq("user_id", userId))
  );
}

/* ── the six metrics ──────────────────────────────────────────
   The three that ask questions open a row first, so their questions have a
   parent to point at, and update it at the end.

   Imports and generations instead mint an id up front with newMetricId() and
   record once at the end, when the facts are known. Their model calls carry
   that id as llm_calls.run_id, which works precisely because run_id is a bare
   uuid and not a foreign key: the cost rows may land before the row they
   name. */

// For threading a run id into model calls before the row it names exists.
export function newMetricId() {
  return newId();
}

export function recordResumeImport({
  id = null,
  fileType = "",
  usedOcr = false,
  rolesFound = 0,
  rolesAdded = 0,
  succeeded = true,
} = {}) {
  return insert("resume_imports", {
    id,
    file_type: fileType,
    used_ocr: usedOcr,
    roles_found: rolesFound,
    roles_added: rolesAdded,
    succeeded,
  });
}

export function startClarityReview({ id = null, position = "", company = "" } = {}) {
  return insert("clarity_reviews", { id, position, company });
}

export function startExperienceExpansion({ id = null, position = "", company = "" } = {}) {
  return insert("experience_expansions", { id, position, company });
}

export function recordExpansionRounds(id, roundsCompleted) {
  update("experience_expansions", id, { rounds_completed: roundsCompleted });
}

export function startJobGapAnalysis({ id = null, gapsFound = 0 } = {}) {
  return insert("job_gap_analyses", { id, gaps_found: gapsFound });
}

export function recordGapDetailsSaved(id, detailsSaved) {
  update("job_gap_analyses", id, { details_saved: detailsSaved });
}

export function recordResumeGeneration({
  id = null,
  resumeId = null,
  jobTitle = "",
  company = "",
  succeeded = true,
} = {}) {
  return insert("resume_generations", {
    id,
    resume_id: resumeId,
    job_title: jobTitle,
    company,
    succeeded,
  });
}

export function recordResumeDownload({ resumeId = null } = {}) {
  return insert("resume_downloads", { resume_id: resumeId });
}

/* ── questions ────────────────────────────────────────────────
   `parent` is exactly one of { clarityReviewId, jobGapAnalysisId,
   experienceExpansionId } — the database enforces that. Record these AFTER
   validation, so the count is what the person actually saw. */

function parentColumns({ clarityReviewId, jobGapAnalysisId, experienceExpansionId } = {}) {
  return {
    clarity_review_id: clarityReviewId ?? null,
    job_gap_analysis_id: jobGapAnalysisId ?? null,
    experience_expansion_id: experienceExpansionId ?? null,
  };
}

// Returns the new ids, in the order given, so callers can thread them into UI
// state straight away.
export function recordQuestionsPresented(parent, questions = []) {
  const ids = questions.map(() => newId());
  if (!isReady() || questions.length === 0) return ids;

  const columns = parentColumns(parent);
  enqueue(async () => {
    const rows = await Promise.all(
      questions.map(async (item, index) => ({
        id: ids[index],
        user_id: userId,
        prompt_id: await promptIdFor(item.promptKey),
        ...columns,
        question: item.question ?? "",
        options: item.options ?? [],
        round: item.round ?? 1,
      }))
    );
    await write("questions insert", client.from("questions").insert(rows));
  });
  return ids;
}

// Answering and skipping are mutually exclusive in the database, and a person
// can change their mind: the gap flow leaves "No" live after "Yes" is clicked.
// Each write therefore clears its opposite, so the last action wins. Without
// that, the second write violates the check constraint and is swallowed,
// leaving the row stuck on the person's first answer.

export function recordQuestionAnswered(id, { selectedOptions = [], answerText = "" } = {}) {
  update("questions", id, {
    selected_options: selectedOptions,
    answer_text: answerText,
    answered_at: new Date().toISOString(),
    skipped_at: null,
  });
}

export function recordQuestionSkipped(id) {
  update("questions", id, { skipped_at: new Date().toISOString(), answered_at: null });
}

/* ── suggestions ──────────────────────────────────────────────
   Only the two flows with a real accept/reject moment: clarity rewrites and
   expansion bullets. `parent` is one of { clarityReviewId,
   experienceExpansionId }. */

export function recordSuggestionPresented(parent, { suggestion = "", promptKey = "", questionId = null } = {}) {
  const id = newId();
  if (!isReady()) return id;

  const { clarityReviewId, experienceExpansionId } = parent ?? {};
  enqueue(async () =>
    write(
      "suggestions insert",
      client.from("suggestions").insert({
        id,
        user_id: userId,
        prompt_id: await promptIdFor(promptKey),
        clarity_review_id: clarityReviewId ?? null,
        experience_expansion_id: experienceExpansionId ?? null,
        question_id: questionId,
        suggestion,
      })
    )
  );
  return id;
}

export function recordSuggestionAccepted(id) {
  update("suggestions", id, { accepted_at: new Date().toISOString() });
}

export function recordSuggestionRejected(id) {
  update("suggestions", id, { rejected_at: new Date().toISOString() });
}
