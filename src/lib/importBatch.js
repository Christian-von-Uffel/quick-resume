// Importing several past resumes in one go. The model calls stay in App (they
// need llmSettings and the metrics context); this module owns the parts that
// decide what the batch does: the order files are read and merged in, which
// file's contact details win, how a usage limit stops the batch, and the
// summary shown at the end.
//
// Files are read one at a time, never in parallel. The burst ceiling in
// plans.limits (burst_per_minute, 5 calls at the time of writing) is counted
// across every call the account makes, and a Word file costs two (OCR, then
// extraction), so even two-at-a-time trips it. Sequential also keeps the merge
// deterministic: file N always merges against the history files 1..N-1 left,
// so a role that appears on three resumes folds into one entry instead of three.

import { mergeEducation, workHistorySortScore } from "./resumeModel";
import { mergeImportedWorkHistory } from "./positionReview";

// Comfortably past the 60-second burst window the usage_snapshot RPC counts.
export const BURST_RETRY_DELAY_MS = 61_000;
export const MAX_BURST_RETRIES = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isBurstLimitError(error) {
  return error?.name === "UsageLimitError" && error.reason === "burst";
}

// The quota and token ceilings don't reset within the batch, so hitting one
// ends it. Burst is the exception: it clears after a minute.
export function isUsageCapError(error) {
  return error?.name === "UsageLimitError" && error.reason !== "burst";
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : "Import failed.";
}

/**
 * How recent a resume is, by the latest end date among its roles. An ongoing
 * role ("present") scores highest. A resume with no dated roles scores 0, so
 * any dated resume outranks it.
 */
export function resumeRecency(workHistory) {
  let best = 0;
  for (const role of workHistory ?? []) {
    const end = workHistorySortScore(role?.endMonth, role?.endYear);
    const score = end > 0 ? end : workHistorySortScore(role?.startMonth, role?.startYear);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Which of an imported resume's profile fields (name, headline, contact) to
 * write. Within one batch, a field already set by a more recent resume is kept,
 * so uploading a 2016 resume after a 2024 one doesn't bring back an old phone
 * number. Ties go to the later file, matching single-file import, where the
 * file you just picked always wins.
 *
 * `claimed` maps field → recency of the file that last wrote it this batch.
 * Returns the fields to write and the updated map; nothing is mutated.
 */
export function pickProfileUpdates(importedProfile, recency, claimed = {}) {
  const fields = {};
  const nextClaimed = { ...claimed };

  for (const [key, value] of Object.entries(importedProfile ?? {})) {
    if (key === "education" || !value) continue;
    if (key in claimed && claimed[key] > recency) continue;
    fields[key] = value;
    nextClaimed[key] = recency;
  }

  return { fields, claimed: nextClaimed };
}

/** Profile after one file: chosen fields overwrite, education merges. */
export function applyProfileUpdates(profile, fields, education) {
  const next = { ...profile, ...fields };
  if (Array.isArray(education) && education.length > 0) {
    next.education = mergeEducation(profile?.education ?? [], education);
  }
  return next;
}

/**
 * Merge one file's roles into the work history. `matched` counts roles that
 * folded into an existing entry, whether it came from the saved profile or an
 * earlier file in the same batch.
 */
export function mergeBatchWorkHistory(current, importedHistory) {
  const before = current?.length ?? 0;
  const { merged, mergedCount } = mergeImportedWorkHistory(current, importedHistory);
  return {
    workHistory: merged,
    added: Math.max(0, merged.length - before),
    matched: mergedCount,
  };
}

/**
 * Read and merge `files` one after another.
 *
 *   extract(file, index)            → Promise of the file's extraction. Throws on failure.
 *   apply(extraction, file, index)  → { added, matched } once it is merged.
 *   onProgress({ index, total, file, phase, retryInMs? })
 *       phase is "reading" before each file and "waiting" during a burst pause.
 *
 * A failed file is recorded and the batch moves on. A burst limit pauses and
 * retries the same file. A quota or token cap stops the batch: what already
 * merged stays, the file that hit the cap fails, and every file after it is
 * marked skipped (never sent, so never metered).
 */
export async function runImportBatch(
  files,
  { extract, apply, onProgress = () => {}, wait = sleep, maxBurstRetries = MAX_BURST_RETRIES }
) {
  const list = Array.from(files ?? []);
  const total = list.length;
  const results = [];
  let stoppedBy = null;

  for (let index = 0; index < total; index += 1) {
    const file = list[index];
    const name = file?.name ?? `File ${index + 1}`;

    if (stoppedBy) {
      results.push({ index, name, status: "skipped", added: 0, matched: 0, error: "" });
      continue;
    }

    onProgress({ index, total, file, phase: "reading" });

    let attempt = 0;
    for (;;) {
      try {
        const extraction = await extract(file, index);
        const { added = 0, matched = 0 } = (await apply(extraction, file, index)) ?? {};
        results.push({ index, name, status: "imported", added, matched, error: "" });
        break;
      } catch (error) {
        if (isBurstLimitError(error) && attempt < maxBurstRetries) {
          attempt += 1;
          onProgress({ index, total, file, phase: "waiting", retryInMs: BURST_RETRY_DELAY_MS });
          await wait(BURST_RETRY_DELAY_MS);
          onProgress({ index, total, file, phase: "reading" });
          continue;
        }
        if (isUsageCapError(error)) {
          stoppedBy = { message: errorMessage(error), upgrade: Boolean(error.upgrade) };
          results.push({ index, name, status: "failed", added: 0, matched: 0, error: "Usage limit reached." });
        } else {
          results.push({ index, name, status: "failed", added: 0, matched: 0, error: errorMessage(error) });
        }
        break;
      }
    }
  }

  return summarizeBatch(results, stoppedBy);
}

export function summarizeBatch(results, stoppedBy = null) {
  const count = (status) => results.filter((result) => result.status === status).length;
  return {
    files: results,
    imported: count("imported"),
    failed: count("failed"),
    skipped: count("skipped"),
    added: results.reduce((sum, result) => sum + result.added, 0),
    matched: results.reduce((sum, result) => sum + result.matched, 0),
    stoppedBy,
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One-line headline for the end-of-batch summary. */
export function describeBatchSummary(summary) {
  const { files, imported, added, matched } = summary;
  if (imported === 0) {
    return files.length === 1 ? "That resume couldn't be imported." : "None of those resumes could be imported.";
  }

  const from = files.length === 1 ? "" : ` from ${plural(imported, "resume")}`;
  const parts = [`${plural(added, "new role")} added${from}`];
  if (matched > 0) parts.push(`${plural(matched, "duplicate")} merged into existing roles`);
  return `${parts.join(", ")}.`;
}

/** Progress line while a batch runs, e.g. "Reading 2 of 4: resume_2019.pdf…". */
export function describeBatchProgress({ index, total, file, phase }) {
  const name = file?.name ?? "";
  if (phase === "waiting") {
    return `Pausing a minute to stay under the rate limit, then reading ${name}…`;
  }
  return total > 1 ? `Reading ${index + 1} of ${total}: ${name}…` : `Reading ${name}…`;
}
