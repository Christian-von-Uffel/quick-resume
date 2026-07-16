// Optional review flow for the work-history problems that actually hurt an
// imported resume: the same job entered twice, a promotion whose old title never
// got an end date, and a single role whose dates can't be real (end before
// start, or a start in the future). Detection describes each one with
// ready-to-apply resolutions; nothing here forces a decision — the UI surfaces a
// passive prompt and the person opts in.
//
// Deliberately NOT flagged: two DIFFERENT employers overlapping in time. Holding
// concurrent jobs is normal, and the timeline already shows the overlap at a
// glance — a warning there is noise, not help. Only same-employer collisions and
// impossible single-role dates get surfaced.
//
// Identity matching is typo-tolerant: titles and companies that differ only by
// a small Levenshtein distance ("Product Manger" / "Product Manager") count as
// the same, so a re-imported resume with a spelling drift still lines up.
//
// Everything here is pure. Acknowledgments are content-signature keys (company +
// title + dates), not item ids, because cloud saves regenerate work-history ids;
// a key stays valid until the flagged role's identity or dates change, at which
// point it is deliberately re-flagged.

import {
  getRoleInterval,
  normalizeCompanyName,
  monthIndex,
  monthIndexToParts,
  nowMonthIndex,
  formatMonthSpan,
} from "./workHistoryTimeline";
import {
  normalizeWorkHistoryItem,
  normalizeWorkMonth,
  normalizeWorkYear,
  sortWorkHistory,
  splitDescriptionIntoDetails,
  normalizeDetailForComparison,
} from "./resumeModel";

export const CONFLICT_KINDS = {
  DUPLICATE: "duplicate",
  SAME_EMPLOYER_OVERLAP: "same-employer-overlap",
  IMPOSSIBLE_DATES: "impossible-dates",
};

// Ways a single role's stored dates can't describe real employment.
export const DATE_ISSUES = {
  REVERSED: "reversed", // end precedes start — usually start/end swapped on import
  FUTURE_START: "future-start", // begins after today — usually a year typo
};

// Overlaps shorter than this are treated as a normal transition month (someone
// who switched jobs mid-month often enters the same month as one role's end and
// the next role's start), not a conflict. Duplicates flag at any overlap.
export const MIN_OVERLAP_FLAG_MONTHS = 2;

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/* ── Typo detection (Levenshtein) ──────────────────────────────────────── */

// Edit distance with adjacent transpositions counted as one edit (optimal
// string alignment), since swapped letters are the most common typing slip:
// "Enigneer" is one edit from "Engineer", not two.
export function levenshteinDistance(a, b) {
  const s = String(a ?? "");
  const t = String(b ?? "");
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  let beforePrev = null;
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let best = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        best = Math.min(best, beforePrev[j - 2] + 1);
      }
      row.push(best);
    }
    beforePrev = prev;
    prev = row;
  }
  return prev[t.length];
}

// One-word typo check. Words shorter than 5 characters must match exactly —
// at that length a single edit reaches a different word ("Acme"/"Acne") more
// often than a typo of the same one.
function isWordTypo(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  return levenshteinDistance(a, b) <= 1;
}

// Whether two normalized strings are the same up to a typo. A single edit is
// allowed on the whole string, or one edit per word for multi-word strings —
// so "Produt Manger" still matches "Product Manager", while a real one-word
// difference ("Senior" vs "Junior", distance 2) never does.
export function isTypoMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (
    Math.min(a.length, b.length) >= 5 &&
    Math.abs(a.length - b.length) <= 1 &&
    levenshteinDistance(a, b) <= 1
  ) {
    return true;
  }
  const wordsA = a.split(" ");
  const wordsB = b.split(" ");
  if (wordsA.length < 2 || wordsA.length !== wordsB.length) return false;
  return wordsA.every((word, i) => isWordTypo(word, wordsB[i]));
}

// Title matching mirrors normalizeCompanyName's conservatism: case, punctuation
// and whitespace variants (plus Sr/Jr abbreviations) collapse, nothing fuzzier.
// "Sr. Engineer" == "senior engineer"; "Engineer" != "Senior Engineer".
export function normalizeTitleForMatch(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\bsr\b/g, "senior")
    .replace(/\bjr\b/g, "junior")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSameTitle(titleA, titleB) {
  return isTypoMatch(normalizeTitleForMatch(titleA), normalizeTitleForMatch(titleB));
}

export function isSameCompany(nameA, nameB) {
  return isTypoMatch(normalizeCompanyName(nameA), normalizeCompanyName(nameB));
}

/* ── Pair identity for acknowledgments ─────────────────────────────────── */

// Identity of one role for acknowledgment keys: employer + title + stored dates.
export function roleConflictSignature(item) {
  return [
    normalizeCompanyName(item.company),
    normalizeTitleForMatch(item.position),
    `${item.startYear ?? ""}-${item.startMonth ?? ""}`,
    `${item.endYear ?? ""}-${item.endMonth ?? ""}`,
  ].join("|");
}

// Order-independent key for a pair of roles.
export function conflictPairKey(itemA, itemB) {
  return [roleConflictSignature(itemA), roleConflictSignature(itemB)].sort().join("||");
}

// Every acknowledgment key the current work history could produce: one per pair
// (for keep-both on duplicates/overlaps) and one per single role (for a
// dismissed date warning). A single-role signature has no "||" so it never
// collides with a pair key. Used to prune acks that no longer match anything.
export function collectConflictKeys(workHistory) {
  const items = workHistory ?? [];
  const keys = new Set();
  for (let i = 0; i < items.length; i += 1) {
    keys.add(roleConflictSignature(items[i]));
    for (let j = i + 1; j < items.length; j += 1) {
      keys.add(conflictPairKey(items[i], items[j]));
    }
  }
  return keys;
}

/* ── Labels ────────────────────────────────────────────────────────────── */

function storedDateLabel(month, year) {
  const y = String(year ?? "").trim();
  if (/^present$/i.test(y) || /^current$/i.test(y)) return "Present";
  if (!y) return "";
  const m = parseInt(String(month ?? ""), 10);
  return Number.isFinite(m) && m >= 1 && m <= 12 ? `${MONTH_ABBR[m - 1]} ${y}` : y;
}

export function roleDisplayName(item) {
  return [item.position, item.company].filter(Boolean).join(" — ") || "Untitled role";
}

// Human labels for a role's stored dates and duration ("Mar 2020 – Present",
// "6 yrs 4 mos"). Uses the stored fields, not interval defaults, so a year-only
// entry reads "2020", never a fabricated "Jan 2020".
export function describeRoleDates(item, interval) {
  const start = storedDateLabel(item.startMonth, item.startYear);
  const end = interval?.ongoing ? "Present" : storedDateLabel(item.endMonth, item.endYear);
  const dates = start || end ? `${start || "?"} – ${end || "?"}` : "No dates yet";
  const duration = interval?.dated ? formatMonthSpan(interval.end - interval.start + 1) : "";
  return { dates, duration };
}

function roleSummary(item, interval) {
  const { dates, duration } = describeRoleDates(item, interval);
  return {
    id: item.id,
    name: roleDisplayName(item),
    position: item.position ?? "",
    company: item.company ?? "",
    dates,
    duration,
    bulletCount: splitDescriptionIntoDetails(item.description).length,
    start: interval.start,
    end: interval.end,
    dated: interval.dated,
    ongoing: interval.ongoing,
  };
}

function isOngoingEnd(endYear) {
  const value = String(endYear ?? "").trim().toLowerCase();
  return value === "" || value === "present" || value === "current";
}

/* ── Automatic merge on import ─────────────────────────────────────────── */

function sameStoredDates(a, b) {
  if (normalizeWorkMonth(a.startMonth) !== normalizeWorkMonth(b.startMonth)) return false;
  if (normalizeWorkYear(a.startYear) !== normalizeWorkYear(b.startYear)) return false;
  const aOngoing = isOngoingEnd(a.endYear);
  const bOngoing = isOngoingEnd(b.endYear);
  if (aOngoing || bOngoing) return aOngoing && bOngoing;
  return (
    normalizeWorkMonth(a.endMonth) === normalizeWorkMonth(b.endMonth) &&
    normalizeWorkYear(a.endYear) === normalizeWorkYear(b.endYear)
  );
}

function matchesOrBothBlank(a, b) {
  if (!a && !b) return true;
  return isTypoMatch(a, b);
}

// Same position for auto-merge purposes: typo-tolerant same title AND company
// (blank matches blank, so two freelance entries without a company still
// compare by title), with identical stored dates. Anything looser — different
// dates, one entry undated — is a *suspected* duplicate and goes to review
// instead of being merged behind the person's back.
function isAutoMergeMatch(a, b) {
  const titleA = normalizeTitleForMatch(a.position);
  const titleB = normalizeTitleForMatch(b.position);
  const companyA = normalizeCompanyName(a.company);
  const companyB = normalizeCompanyName(b.company);
  if (!(titleA || companyA) || !(titleB || companyB)) return false;
  return (
    matchesOrBothBlank(titleA, titleB) &&
    matchesOrBothBlank(companyA, companyB) &&
    sameStoredDates(a, b)
  );
}

// Existing entry absorbs a duplicate: it keeps its id, spelling, and dates, has
// blank fields filled in, and gains any accomplishment details it didn't
// already have. Nothing from either copy is dropped.
function absorbDuplicate(existing, incoming) {
  const existingKeys = new Set(
    splitDescriptionIntoDetails(existing.description).map(normalizeDetailForComparison)
  );
  const extraDetails = splitDescriptionIntoDetails(incoming.description).filter(
    (detail) => !existingKeys.has(normalizeDetailForComparison(detail))
  );
  const description = [existing.description, ...extraDetails]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n");

  return normalizeWorkHistoryItem({
    ...existing,
    position: existing.position || incoming.position,
    company: existing.company || incoming.company,
    description,
  });
}

/* ── Within-entry bullet de-duplication (import cleanup) ───────────────── */

// The distinct numbers/percentages a bullet mentions, sorted. Two bullets that
// differ in their figures ("grew revenue 20%" vs "grew revenue 40%") describe
// different results and must NEVER be de-duplicated, however alike their words —
// so a mismatch here vetoes a merge before any similarity check runs.
function detailNumericSignature(norm) {
  return (norm.match(/\d+(?:[.,]\d+)?/g) || []).sort().join("|");
}

function detailTokenSet(norm) {
  return new Set(norm.split(" ").filter(Boolean));
}

function isTokenSubset(small, big) {
  for (const token of small) if (!big.has(token)) return false;
  return true;
}

// Precompute the comparison fields for one bullet line.
function detailInfo(rawLine) {
  const norm = normalizeDetailForComparison(rawLine);
  return { raw: rawLine, norm, tokens: detailTokenSet(norm), numsig: detailNumericSignature(norm) };
}

// Whether two bullets say the same thing up to rewording. Deliberately
// conservative — the goal is to drop obvious repeats, not to guess. In order:
// identical text; then (only if their numbers agree) a pure reordering, one
// bullet elaborating on the other (token containment, ≥3 shared words so the
// overlap isn't coincidental), or a typo (tiny edit distance at similar length).
function areSimilarDetails(a, b) {
  if (!a.norm || !b.norm) return false;
  if (a.norm === b.norm) return true;
  if (a.numsig !== b.numsig) return false;

  if ([...a.tokens].sort().join(" ") === [...b.tokens].sort().join(" ")) return true;

  const [small, big] = a.tokens.size <= b.tokens.size ? [a.tokens, b.tokens] : [b.tokens, a.tokens];
  if (small.size >= 3 && isTokenSubset(small, big)) return true;

  if (Math.abs(a.norm.length - b.norm.length) <= 4) {
    const budget = Math.max(1, Math.floor(Math.min(a.norm.length, b.norm.length) * 0.1));
    if (levenshteinDistance(a.norm, b.norm) <= budget) return true;
  }
  return false;
}

// The bullet worth keeping when two are duplicates: the one carrying more words
// (then more characters) — i.e. the fuller wording.
function isRicherDetail(candidate, current) {
  if (candidate.tokens.size !== current.tokens.size) return candidate.tokens.size > current.tokens.size;
  return candidate.raw.length > current.raw.length;
}

// Remove a single description's OWN duplicate bullets, keeping the richest
// wording of each and preserving line order and bullet markers. Meant for
// imported entries (see mergeImportedWorkHistory) — never for data the person is
// actively editing, where a momentary repeat is intentional. Blank / formatting
// lines pass through untouched.
export function dedupeEntryDetails(description) {
  const text = String(description ?? "");
  if (!text.includes("\n")) return text; // single line: nothing to de-dupe
  const lines = text.split("\n");
  const out = [];
  const kept = []; // { info, outIndex } for each bullet we've decided to keep
  let changed = false;

  for (const rawLine of lines) {
    const info = detailInfo(rawLine);
    if (!info.norm) {
      out.push(rawLine); // preserve blank lines / spacing
      continue;
    }
    const match = kept.find((entry) => areSimilarDetails(entry.info, info));
    if (!match) {
      kept.push({ info, outIndex: out.length });
      out.push(rawLine);
    } else if (isRicherDetail(info, match.info)) {
      out[match.outIndex] = rawLine; // upgrade to the fuller wording, in place
      match.info = info;
      changed = true;
    } else {
      changed = true; // drop the poorer repeat
    }
  }

  return changed ? out.join("\n") : text;
}

// Merge an imported batch into the current work history. Imported entries that
// are the same title + company + dates as an existing entry (or as an earlier
// entry in the same batch — resumes love listing a role twice) fold into it
// automatically; everything else is appended. Each imported entry is first
// cleaned of its own repeated bullets (dedupeEntryDetails), since parsed resumes
// often restate the same accomplishment. Returns the merged list plus how many
// entries were folded, for the import status line.
export function mergeImportedWorkHistory(current, incoming) {
  const merged = [...(current ?? [])];
  let mergedCount = 0;

  for (const raw of incoming ?? []) {
    const normalized = normalizeWorkHistoryItem(raw);
    if (!normalized.position && !normalized.company && !normalized.description) continue;

    const item = normalized.description
      ? { ...normalized, description: dedupeEntryDetails(normalized.description) }
      : normalized;

    const matchIndex = merged.findIndex((existing) => isAutoMergeMatch(existing, item));
    if (matchIndex >= 0) {
      merged[matchIndex] = absorbDuplicate(merged[matchIndex], item);
      mergedCount += 1;
    } else {
      merged.push(item);
    }
  }

  return {
    merged: merged.length > 0 ? sortWorkHistory(merged) : merged,
    mergedCount,
  };
}

/* ── Merge plan for suspected duplicates ───────────────────────────────── */

function overlapMonthsOf(ivA, ivB) {
  if (!ivA.dated || !ivB.dated) return 0;
  return Math.max(0, Math.min(ivA.end, ivB.end) - Math.max(ivA.start, ivB.start) + 1);
}

function dateOptionId(prefix, month, year) {
  return `${prefix}-${normalizeWorkYear(year)}-${normalizeWorkMonth(month) || "??"}`;
}

// Which of two roles reads as more recent — later end wins (an ongoing role
// counts as "now"), then later start. null when the two are indistinguishable,
// so the caller falls back to another signal. Drives the default bullet wording:
// the more recent resume reflects the person's current phrasing.
function moreRecentSide(ivA, ivB, now) {
  if (ivA.dated && ivB.dated) {
    const endA = ivA.ongoing ? nowMonthIndex(now) : ivA.end;
    const endB = ivB.ongoing ? nowMonthIndex(now) : ivB.end;
    if (endA !== endB) return endA > endB ? "a" : "b";
    if (ivA.start !== ivB.start) return ivA.start > ivB.start ? "a" : "b";
    return null;
  }
  if (ivA.dated !== ivB.dated) return ivA.dated ? "a" : "b";
  return null;
}

// Word overlap (Jaccard) between two bullets' token sets.
function detailJaccard(tokensA, tokensB) {
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;
  return shared / (tokensA.size + tokensB.size - shared);
}

// Looser than areSimilarDetails, for the merge chooser ONLY: two bullets sharing
// at least half their words (and disagreeing on no figure) probably describe the
// same accomplishment even when reworded ("user research" vs "UX research"). The
// person confirms every proposed pair, so a wrong "same point?" prompt costs a
// glance, not lost data — hence the wider net than the silent import de-dup.
function areLikelySamePoint(a, b) {
  if (!a.norm || !b.norm) return false;
  if (a.numsig !== b.numsig) return false;
  if (areSimilarDetails(a, b)) return true;
  return detailJaccard(a.tokens, b.tokens) >= 0.5;
}

// Reconcile the two copies' bullets into an ordered template plus a set of
// per-pair choices. Colliding bullets become a choice: `strict` pairs (the same
// wording up to a typo/reordering) default to a single wording — the more recent
// copy's, or the fuller one when the copies' dates tie — while looser guesses
// default to keeping BOTH, so a blind merge never drops a bullet that only
// looked like a duplicate. `extras` are bullets unique to the removed copy.
function buildBulletMergePlan(survivorDesc, removedDesc, preferred) {
  const survivor = String(survivorDesc ?? "")
    .split("\n")
    .map((raw) => ({ raw, info: detailInfo(raw) }));
  const consumed = new Array(survivor.length).fill(false);
  const choiceBySurvivor = new Map();
  const choices = [];
  const extras = [];

  const findMatch = (info, predicate) =>
    survivor.findIndex((s, i) => !consumed[i] && s.info.norm && predicate(s.info, info));

  for (const raw of String(removedDesc ?? "").split("\n")) {
    const info = detailInfo(raw);
    if (!info.norm) continue;

    const exact = findMatch(info, (s, x) => s.norm === x.norm);
    if (exact >= 0) {
      consumed[exact] = true; // identical bullet already present — nothing to choose
      continue;
    }

    const strictIndex = findMatch(info, areSimilarDetails);
    const matchIndex = strictIndex >= 0 ? strictIndex : findMatch(info, areLikelySamePoint);
    if (matchIndex >= 0) {
      consumed[matchIndex] = true;
      const strict = strictIndex >= 0;
      const survivorInfo = survivor[matchIndex].info;
      const defaultChoice = !strict
        ? "both"
        : preferred === "survivor"
          ? "survivor"
          : preferred === "removed"
            ? "removed"
            : isRicherDetail(info, survivorInfo) ? "removed" : "survivor";
      const choice = {
        id: `bullet-${choices.length}`,
        survivorWording: survivor[matchIndex].raw,
        removedWording: raw,
        strict,
        defaultChoice,
      };
      choices.push(choice);
      choiceBySurvivor.set(matchIndex, choice.id);
      continue;
    }

    extras.push(raw);
  }

  const template = survivor.map((s, i) =>
    choiceBySurvivor.has(i) ? { choiceId: choiceBySurvivor.get(i) } : s.raw
  );
  return { template, choices, extras };
}

// The date + bullet choices a person picks from when merging a duplicate pair.
// Date options: each distinct stored start/end across both entries (labeled,
// with a month index for the live duration preview). Bullet options: one per
// colliding bullet pair, defaulting to the more recent copy's wording.
function buildMergePlan(a, b, now) {
  const aDetails = splitDescriptionIntoDetails(a.item.description);
  const bDetails = splitDescriptionIntoDetails(b.item.description);
  const survivorFirst = bDetails.length > aDetails.length
    || (bDetails.length === aDetails.length && (b.item.description?.length ?? 0) > (a.item.description?.length ?? 0))
    ? [b, a]
    : [a, b];
  const [survivor, removed] = survivorFirst;

  // Default bullet wording follows the more recent copy (the person's latest
  // phrasing); when the two copies' dates tie, fall back to the fuller wording.
  const recent = moreRecentSide(survivor.interval, removed.interval, now);
  const recentSide = recent === "a" ? "survivor" : recent === "b" ? "removed" : null;
  const { template, choices, extras } = buildBulletMergePlan(
    survivor.item.description,
    removed.item.description,
    recentSide ?? "fuller"
  );

  const literalBullets = template.filter((part) => typeof part === "string" && part.trim()).length;
  const choiceBullets = choices.reduce((n, c) => n + (c.defaultChoice === "both" ? 2 : 1), 0);
  const bulletCount = literalBullets + choiceBullets + extras.length;

  const startOptions = [];
  const endOptions = [];
  for (const entry of [a, b]) {
    const { item } = entry;
    const startYear = normalizeWorkYear(item.startYear);
    const endYear = normalizeWorkYear(item.endYear);
    if (startYear && startYear !== "present") {
      const id = dateOptionId("start", item.startMonth, item.startYear);
      if (!startOptions.some((option) => option.id === id)) {
        startOptions.push({
          id,
          month: normalizeWorkMonth(item.startMonth),
          year: normalizeWorkYear(item.startYear),
          label: storedDateLabel(item.startMonth, item.startYear),
          index: monthIndex(item.startYear, item.startMonth, 1),
        });
      }
    }
    // A blank end only means "ongoing" when the entry has a start; a fully
    // undated copy contributes no date choices at all.
    if (entry.interval.dated && entry.interval.ongoing) {
      if (!endOptions.some((option) => option.ongoing)) {
        endOptions.push({ id: "end-present", ongoing: true, month: "", year: "present", label: "Present", index: null });
      }
    } else if (endYear && endYear !== "present") {
      const id = dateOptionId("end", item.endMonth, item.endYear);
      if (!endOptions.some((option) => option.id === id)) {
        endOptions.push({
          id,
          ongoing: false,
          month: normalizeWorkMonth(item.endMonth),
          year: normalizeWorkYear(item.endYear),
          label: storedDateLabel(item.endMonth, item.endYear),
          index: monthIndex(item.endYear, item.endMonth, 12),
        });
      }
    }
  }
  startOptions.sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
  endOptions.sort((x, y) => (x.ongoing ? Infinity : x.index) - (y.ongoing ? Infinity : y.index));

  // Default to the widest span — for the classic double-import one copy is
  // stale, and earliest-start to latest-end is the usual truth.
  const defaultStartId = startOptions[0]?.id ?? null;
  const defaultEndId = endOptions[endOptions.length - 1]?.id ?? null;

  return {
    survivorId: survivor.item.id,
    removeId: removed.item.id,
    descriptionTemplate: template,
    bulletChoices: choices,
    bulletExtras: extras,
    recentSide,
    bulletCount,
    addedBulletCount: extras.length,
    startOptions,
    endOptions,
    defaultStartId,
    defaultEndId,
  };
}

// Resolve a merge plan's bullet template with the person's per-bullet picks
// (falling back to each pair's default) into the final description string. A
// "both" pick keeps the surviving copy's wording in place and appends the other
// after the shared bullets; unique extras always come last.
export function buildMergedDescription(plan, bulletPicks = {}) {
  const byId = new Map((plan?.bulletChoices ?? []).map((choice) => [choice.id, choice]));
  const lines = [];
  const deferred = []; // "keep both" removed-wordings, appended after the shared bullets
  for (const part of plan?.descriptionTemplate ?? []) {
    if (typeof part === "string") {
      lines.push(part);
      continue;
    }
    const choice = byId.get(part.choiceId);
    if (!choice) continue;
    const pick = bulletPicks[part.choiceId] ?? choice.defaultChoice;
    if (pick === "removed") {
      lines.push(choice.removedWording);
    } else if (pick === "both") {
      lines.push(choice.survivorWording);
      deferred.push(choice.removedWording);
    } else {
      lines.push(choice.survivorWording);
    }
  }
  return [...lines, ...deferred, ...(plan?.bulletExtras ?? [])]
    .map((line) => String(line ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

// Resolve a plan's selected options (falling back to the defaults) and label
// the resulting merged dates + duration — the live preview under the pickers.
export function mergedDatesPreview(plan, startId, endId, now = new Date()) {
  const start = plan.startOptions.find((option) => option.id === startId)
    ?? plan.startOptions.find((option) => option.id === plan.defaultStartId)
    ?? null;
  const end = plan.endOptions.find((option) => option.id === endId)
    ?? plan.endOptions.find((option) => option.id === plan.defaultEndId)
    ?? null;
  if (!start && !end) return { dates: "No dates yet", duration: "" };

  const startLabel = start?.label || "?";
  const endLabel = end?.label || "?";
  const endIndex = end ? (end.ongoing ? nowMonthIndex(now) : end.index) : null;
  const duration =
    start?.index != null && endIndex != null && endIndex >= start.index
      ? formatMonthSpan(endIndex - start.index + 1)
      : "";
  return { dates: `${startLabel} – ${endLabel}`, duration };
}

// Apply a duplicate merge with the person's date and per-bullet picks. The
// survivor keeps its id (so open panels and highlights stay valid), gains the
// reconciled description, and takes the chosen dates.
export function applyDuplicateMerge(workHistory, conflict, { startId, endId, bulletPicks } = {}) {
  const items = workHistory ?? [];
  const plan = conflict?.merge;
  if (!plan) return items;

  const start = plan.startOptions.find((option) => option.id === startId)
    ?? plan.startOptions.find((option) => option.id === plan.defaultStartId);
  const end = plan.endOptions.find((option) => option.id === endId)
    ?? plan.endOptions.find((option) => option.id === plan.defaultEndId);

  const changes = { description: buildMergedDescription(plan, bulletPicks ?? {}) };
  if (start) {
    changes.startMonth = start.month;
    changes.startYear = start.year;
  }
  if (end) {
    changes.endMonth = end.ongoing ? "" : end.month;
    changes.endYear = end.ongoing ? "present" : end.year;
  }

  return sortWorkHistory(
    items
      .filter((item) => item.id !== plan.removeId)
      .map((item) =>
        item.id === plan.survivorId ? normalizeWorkHistoryItem({ ...item, ...changes }) : item
      )
  );
}

/* ── Boundary fixes for overlapping pairs ──────────────────────────────── */

// Boundary fixes that make an overlapping pair sequential while preserving the
// pair's outer dates. `a` starts first (ties: ends first); options are only
// offered when the resulting range stays valid.
function buildBoundaryFixes(a, b, now) {
  const fixes = [];

  const fixOf = (id, entry, changes) => {
    const next = normalizeWorkHistoryItem({ ...entry.item, ...changes });
    const after = describeRoleDates(next, getRoleInterval(next, now));
    return {
      id,
      itemId: entry.item.id,
      changes,
      before: describeRoleDates(entry.item, entry.interval),
      after,
    };
  };

  if (b.interval.start > a.interval.start) {
    const parts = monthIndexToParts(b.interval.start - 1);
    fixes.push({
      ...fixOf("trim-earlier-end", a, { endMonth: parts.month, endYear: parts.year }),
      label: `End “${a.item.position || roleDisplayName(a.item)}” when “${b.item.position || roleDisplayName(b.item)}” begins`,
    });
  }

  if (b.interval.end > a.interval.end) {
    const parts = monthIndexToParts(a.interval.end + 1);
    fixes.push({
      ...fixOf("trim-later-start", b, { startMonth: parts.month, startYear: parts.year }),
      label: `Start “${b.item.position || roleDisplayName(b.item)}” after “${a.item.position || roleDisplayName(a.item)}” ends`,
    });
  }

  return fixes;
}

// Apply one boundary fix and return the new list, normalized and date-sorted.
export function applyBoundaryFix(workHistory, fix) {
  const items = workHistory ?? [];
  if (!fix?.itemId) return items;
  return sortWorkHistory(
    items.map((item) =>
      item.id === fix.itemId ? normalizeWorkHistoryItem({ ...item, ...fix.changes }) : item
    )
  );
}

/* ── Detection ─────────────────────────────────────────────────────────── */

const KEEP_BOTH_LABELS = {
  [CONFLICT_KINDS.DUPLICATE]: "Keep both — these are separate positions",
  [CONFLICT_KINDS.SAME_EMPLOYER_OVERLAP]: "Keep both — I held these roles at the same time",
  [CONFLICT_KINDS.IMPOSSIBLE_DATES]: "These dates are correct",
};

/* ── Date sanity for a single role ─────────────────────────────────────── */

// Boundary-fix-shaped swap of a role's start and end dates — the one-click fix
// for a reversed range. Shares the fix shape (itemId + changes + before/after)
// so applyBoundaryFix applies it with no special case.
function buildSwapFix(entry, now) {
  const { item } = entry;
  const changes = {
    startMonth: normalizeWorkMonth(item.endMonth),
    startYear: normalizeWorkYear(item.endYear),
    endMonth: normalizeWorkMonth(item.startMonth),
    endYear: normalizeWorkYear(item.startYear),
  };
  const swapped = normalizeWorkHistoryItem({ ...item, ...changes });
  return {
    id: "swap-dates",
    itemId: item.id,
    changes,
    before: describeRoleDates(item, entry.interval),
    after: describeRoleDates(swapped, getRoleInterval(swapped, now)),
    label: "Swap the start and end dates",
  };
}

// Flag a single role whose stored dates can't be real. Reversed ranges (a dated
// end before the start) get a swap fix; a start in the future gets no auto-fix
// (we can't guess the right year) and leans on "Edit dates". Returns null for
// sane or under-dated roles. Both cases are otherwise hidden by getRoleInterval,
// which silently clamps them — so this is the only place the person sees them.
function detectDateIssue(entry, now, nowIdx) {
  const { item } = entry;
  const rawStart = monthIndex(item.startYear, item.startMonth, 1);
  if (rawStart == null) return null; // no usable start → nothing to judge

  const ongoing = isOngoingEnd(item.endYear);
  const rawEnd = ongoing ? null : monthIndex(item.endYear, item.endMonth, 12);

  let issue = null;
  if (rawEnd != null && rawEnd < rawStart) issue = DATE_ISSUES.REVERSED;
  else if (rawStart > nowIdx) issue = DATE_ISSUES.FUTURE_START;
  if (!issue) return null;

  return {
    id: roleConflictSignature(item),
    kind: CONFLICT_KINDS.IMPOSSIBLE_DATES,
    dateIssue: issue,
    overlapMonths: 0,
    overlapLabel: "",
    company: item.company || "",
    fuzzy: { title: false, company: false },
    a: roleSummary(item, entry.interval),
    b: null,
    merge: null,
    fixes: issue === DATE_ISSUES.REVERSED ? [buildSwapFix(entry, now)] : [],
    keepBothLabel: KEEP_BOTH_LABELS[CONFLICT_KINDS.IMPOSSIBLE_DATES],
  };
}

// Scan the work history and return the problems worth a person's look:
//   duplicate             same employer + same title (typo-tolerant), dates
//                         overlap or one/both entries lack dates — the classic
//                         double-import
//   same-employer-overlap different titles at one company sharing ≥2 months —
//                         usually a promotion whose boundary dates weren't cut
//   impossible-dates      a single role whose dates can't be real: a dated end
//                         before its start, or a start in the future — the kind
//                         of thing an import or a year typo introduces
// Two DIFFERENT employers overlapping is intentionally NOT flagged — concurrent
// jobs are normal and the timeline already shows them. Keys in `ackKeys` were
// confirmed/dismissed and are skipped. Duplicates carry a `merge` plan (date
// choices + combined description); overlaps and reversed dates carry `fixes`.
export function detectPositionConflicts(workHistory, { now = new Date(), ackKeys = [] } = {}) {
  const acks = new Set(ackKeys);
  const nowIdx = nowMonthIndex(now);
  const entries = (workHistory ?? []).map((item) => ({
    item,
    interval: getRoleInterval(item, now),
  }));

  const conflicts = [];

  // Single-role date problems first, so a role's own broken dates surface even
  // when it forms no pair with anything else.
  for (const entry of entries) {
    const issue = detectDateIssue(entry, now, nowIdx);
    if (issue && !acks.has(issue.id)) conflicts.push(issue);
  }

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      let a = entries[i];
      let b = entries[j];

      const sameEmployer = isSameCompany(a.item.company, b.item.company);
      const bothDated = a.interval.dated && b.interval.dated;

      // Order the pair chronologically when possible: `a` starts first
      // (ties: ends first). Undated entries sort after dated ones.
      if (
        (bothDated &&
          (b.interval.start < a.interval.start ||
            (b.interval.start === a.interval.start && b.interval.end < a.interval.end))) ||
        (!a.interval.dated && b.interval.dated)
      ) {
        [a, b] = [b, a];
      }

      const overlapMonths = overlapMonthsOf(a.interval, b.interval);

      let kind = null;
      if (sameEmployer && isSameTitle(a.item.position, b.item.position)) {
        // Same title twice at one employer: overlapping dates are a duplicate,
        // and so is a copy that never got dates. Non-overlapping dated ranges
        // are a legitimate rehire and stay unflagged.
        if (!bothDated || overlapMonths >= 1) kind = CONFLICT_KINDS.DUPLICATE;
      } else if (sameEmployer && bothDated && overlapMonths >= MIN_OVERLAP_FLAG_MONTHS) {
        // Different titles at ONE company sharing time — usually a promotion
        // whose old boundary wasn't cut. Different employers overlapping is left
        // alone (see the module header): concurrent jobs are normal.
        kind = CONFLICT_KINDS.SAME_EMPLOYER_OVERLAP;
      }
      if (!kind) continue;

      const pairKey = conflictPairKey(a.item, b.item);
      if (acks.has(pairKey)) continue;

      conflicts.push({
        id: pairKey,
        kind,
        overlapMonths,
        overlapLabel: overlapMonths > 0 ? formatMonthSpan(overlapMonths) : "",
        company: a.item.company || b.item.company || "",
        // True when the pair matched only through typo tolerance — the UI
        // mentions the spelling difference so the suggestion isn't spooky.
        fuzzy: {
          title:
            kind === CONFLICT_KINDS.DUPLICATE &&
            normalizeTitleForMatch(a.item.position) !== normalizeTitleForMatch(b.item.position),
          company:
            sameEmployer &&
            normalizeCompanyName(a.item.company) !== normalizeCompanyName(b.item.company),
        },
        a: roleSummary(a.item, a.interval),
        b: roleSummary(b.item, b.interval),
        merge: kind === CONFLICT_KINDS.DUPLICATE ? buildMergePlan(a, b, now) : null,
        fixes: kind === CONFLICT_KINDS.DUPLICATE ? [] : buildBoundaryFixes(a, b, now),
        keepBothLabel: KEEP_BOTH_LABELS[kind],
      });
    }
  }

  // Most recent conflicts first — same instinct as the rest of the app.
  // (c.b is null for single-role date issues, so filter it out first.)
  const endOf = (c) => {
    const ends = [c.a, c.b].filter((role) => role?.dated).map((role) => role.end);
    return ends.length ? Math.max(...ends) : -Infinity;
  };
  return conflicts.sort((x, y) => endOf(y) - endOf(x));
}
