// Product metrics: what people actually do with the smart features.
//
// Writes the six metric tables plus `questions` and `suggestions` from the
// browser, under the signed-in user's session, so row-level security scopes
// every insert to their own rows. That's the same trust model as the rest of
// their data — faking your own analytics buys you nothing, and a download is
// invisible to the server anyway. What a model call COST is the unspoofable
// half, and only the API routes write that (see src/lib/server/llmCalls.js).
//
// Prompt attribution uses public.prompts ids returned from /api/llm (or from
// ensure_prompt). There is no key/version catalog — the body is the identity.
//
// Two rules this module lives by:
//   1. Metrics never break a feature. Every write is fire-and-forget and every
//      failure is swallowed. Callers get an id back synchronously and never
//      await anything.
//   2. Ids are minted here so a caller can thread a question id into UI state
//      before the row exists in Postgres.

let client = null;
let userId = null;

// Writes are chained rather than fired concurrently: questions and suggestions
// carry foreign keys into rows written moments earlier, so an insert that
// overtook its own parent would be rejected outright. A few dozen rows per
// session — a single FIFO queue costs nothing.
let chain = Promise.resolve();

export function configureMetrics({ supabase = null, user = null } = {}) {
  client = supabase;
  userId = user;
}

const isReady = () => Boolean(client && userId);

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
    if (process.env.NODE_ENV !== "production") {
      console.warn("[metrics]", error?.message ?? error);
    }
  });
  return chain;
}

async function write(label, query) {
  const { error } = await query;
  if (error) throw new Error(`${label}: ${error.message ?? "request failed"}`);
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

export function startClarityReview({ id = null, position = "", company = "", promptId = null } = {}) {
  return insert("clarity_reviews", { id, position, company, prompt_id: promptId });
}

export function startExperienceExpansion({
  id = null,
  position = "",
  company = "",
  promptId = null,
} = {}) {
  return insert("experience_expansions", { id, position, company, prompt_id: promptId });
}

export function recordExpansionRounds(id, roundsCompleted) {
  update("experience_expansions", id, { rounds_completed: roundsCompleted });
}

export function startJobGapAnalysis({ id = null, gapsFound = 0, promptId = null } = {}) {
  return insert("job_gap_analyses", { id, gaps_found: gapsFound, prompt_id: promptId });
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
  promptId = null,
} = {}) {
  return insert("resume_generations", {
    id,
    resume_id: resumeId,
    job_title: jobTitle,
    company,
    succeeded,
    prompt_id: promptId,
  });
}

export function setRunPromptId(table, id, promptId) {
  if (!promptId) return;
  update(table, id, { prompt_id: promptId });
}

export function recordResumeDownload({ resumeId = null } = {}) {
  return insert("resume_downloads", { resume_id: resumeId });
}

function parentColumns({ clarityReviewId, jobGapAnalysisId, experienceExpansionId } = {}) {
  return {
    clarity_review_id: clarityReviewId ?? null,
    job_gap_analysis_id: jobGapAnalysisId ?? null,
    experience_expansion_id: experienceExpansionId ?? null,
  };
}

export function recordQuestionsPresented(parent, questions = []) {
  const ids = questions.map(() => newId());
  if (!isReady() || questions.length === 0) return ids;

  const columns = parentColumns(parent);
  enqueue(async () => {
    const rows = questions.map((item, index) => ({
      id: ids[index],
      user_id: userId,
      prompt_id: item.promptId ?? null,
      ...columns,
      question: item.question ?? "",
      options: item.options ?? [],
      round: item.round ?? 1,
    }));
    await write("questions insert", client.from("questions").insert(rows));
  });
  return ids;
}

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

export function recordSuggestionPresented(
  parent,
  { suggestion = "", promptId = null, questionId = null } = {}
) {
  const id = newId();
  if (!isReady()) return id;

  const { clarityReviewId, experienceExpansionId } = parent ?? {};
  enqueue(async () =>
    write(
      "suggestions insert",
      client.from("suggestions").insert({
        id,
        user_id: userId,
        prompt_id: promptId,
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
  update("suggestions", id, {
    accepted_at: new Date().toISOString(),
    rejected_at: null,
  });
}

export function recordSuggestionRejected(id) {
  update("suggestions", id, {
    rejected_at: new Date().toISOString(),
    accepted_at: null,
  });
}
