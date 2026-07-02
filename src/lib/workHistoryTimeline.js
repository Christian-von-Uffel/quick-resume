// Employment-timeline math: turn stored work history into placeable intervals,
// find employment gaps, and deterministically pick which roles a resume MUST
// include so it reads as continuous, currently-employed history.
//
// This module is intentionally dependency-free (no imports) so it can be unit
// tested with plain Node and reused anywhere. Stored work-history items already
// carry normalized fields: startMonth/endMonth are "" or "01".."12", and
// startYear/endYear are "", a 4-digit year, or "present".

// A gap of this many fully-uncovered months or more is worth showing / covering.
// Shorter gaps (a normal month or two between jobs) are treated as continuous.
export const NOTABLE_GAP_MONTHS = 3;

// Time-decay half-life, in months, for how much a role's recency (or a gap's
// recency) matters. At one half-life ago the weight is 0.5, at two 0.25, etc.
// Five years: recent history dominates, but a strong older match still counts.
export const RECENCY_HALF_LIFE_MONTHS = 60;

// We only *force* the resume to cover gaps that are still recent enough to raise
// eyebrows. A gap that ended longer ago than this is left to relevance (the LLM)
// rather than hard-required — matching "older roles only if they're a fit".
export const GAP_COVERAGE_HORIZON_MONTHS = 120; // 10 years

// Convert a (year, month) pair into an absolute month index for interval math.
// month is 1-based ("01".."12"); a missing/invalid month falls back to
// `monthDefault` (Jan for starts, Dec for ends) so year-only entries stay generous.
export function monthIndex(year, month, monthDefault) {
  const y = parseInt(String(year ?? "").trim(), 10);
  if (!Number.isFinite(y)) return null;
  const raw = parseInt(String(month ?? "").trim(), 10);
  const m = Number.isFinite(raw) && raw >= 1 && raw <= 12 ? raw : monthDefault;
  return y * 12 + (m - 1);
}

export function nowMonthIndex(now = new Date()) {
  return now.getFullYear() * 12 + now.getMonth();
}

export function monthIndexToLabel(index) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const names = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${names[month - 1]} ${year}`;
}

// How much wider each year is than the year before it on the recency-weighted
// axis. 1.25 means "the most recent year gets 1.25x the width of the year prior,
// and so on back" — a gentle geometric decay, far less extreme than a log scale.
export const RECENCY_YEAR_RATIO = 1.25;

// Position a month index on the recency-weighted axis, 0% (most recent, left) to
// 100% (oldest, right). Visual width decays geometrically per year, so the ratio
// between any two adjacent years' widths is exactly `yearRatio`.
export function recencyPosition(index, domainStart, domainEnd, yearRatio = RECENCY_YEAR_RATIO) {
  const ageMax = Math.max(1, domainEnd - domainStart);
  const lambda = Math.log(yearRatio); // per-year decay rate
  const norm = 1 - Math.exp((-lambda * ageMax) / 12);
  if (norm <= 0) return ((domainEnd - index) / (ageMax + 1)) * 100;
  const age = Math.max(0, domainEnd - index);
  return ((1 - Math.exp((-lambda * age) / 12)) / norm) * 100;
}

// Split a month index back into padded { month, year } strings, for pre-filling
// a new position that lands inside a gap.
export function monthIndexToParts(index) {
  return {
    month: String((index % 12) + 1).padStart(2, "0"),
    year: String(Math.floor(index / 12)),
  };
}

// Human-readable duration for a span measured in inclusive months.
export function formatMonthSpan(months) {
  const total = Math.max(0, Math.round(months));
  const years = Math.floor(total / 12);
  const rem = total % 12;
  const parts = [];
  if (years) parts.push(`${years} yr${years === 1 ? "" : "s"}`);
  if (rem || !years) parts.push(`${rem} mo${rem === 1 ? "" : "s"}`);
  return parts.join(" ");
}

function isOngoingValue(endYear) {
  const value = String(endYear ?? "").trim().toLowerCase();
  return value === "" || value === "present" || value === "current";
}

// Turn a stored work-history item into a placeable interval. `dated` is false
// when we can't place it on the axis (no usable start year); such roles are
// still real experience, just invisible to gap math.
export function getRoleInterval(item, now = new Date()) {
  const nowIdx = nowMonthIndex(now);
  const start = monthIndex(item.startYear, item.startMonth, 1);
  const ongoing = isOngoingValue(item.endYear);
  const rawEnd = ongoing ? nowIdx : monthIndex(item.endYear, item.endMonth, 12);

  // Clamp an end that predates the start (bad data) and never let a dated role
  // run past "now" — a resume can't claim future employment.
  let end = rawEnd;
  if (start != null && end != null && end < start) end = start;
  if (end != null && end > nowIdx) end = nowIdx;

  return {
    id: item.id,
    position: item.position ?? "",
    company: item.company ?? "",
    start,
    end,
    ongoing,
    dated: start != null && end != null,
  };
}

// Merge a set of intervals (each {start,end}) into non-overlapping covered
// spans, sorted by start. Adjacent/back-to-back spans (<=1 month apart) merge.
export function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((iv) => iv.start != null && iv.end != null)
    .map((iv) => ({ start: iv.start, end: iv.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end + 1) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

// Uncovered spans between `domainStart` and `domainEnd` given covered intervals.
// Each gap reports `months` (fully uncovered months) and `toPresent` when it
// runs to the end of the domain (i.e. an open, still-current gap).
export function computeGaps(intervals, { domainStart, domainEnd, minGapMonths = NOTABLE_GAP_MONTHS } = {}) {
  const merged = mergeIntervals(intervals);
  const gaps = [];
  if (domainStart == null || domainEnd == null) return gaps;

  let cursor = domainStart;
  for (const span of merged) {
    if (span.start > cursor) {
      const gapStart = cursor;
      const gapEnd = span.start - 1;
      const months = gapEnd - gapStart + 1;
      if (months >= minGapMonths) {
        gaps.push({ start: gapStart, end: gapEnd, months, toPresent: false });
      }
    }
    cursor = Math.max(cursor, span.end + 1);
  }

  if (cursor <= domainEnd) {
    const months = domainEnd - cursor + 1;
    if (months >= minGapMonths) {
      gaps.push({ start: cursor, end: domainEnd, months, toPresent: true });
    }
  }

  return gaps;
}

// 0..1 weight that decays with how many months ago something happened.
export function recencyWeight(monthsAgo, halfLife = RECENCY_HALF_LIFE_MONTHS) {
  if (monthsAgo <= 0) return 1;
  return Math.pow(0.5, monthsAgo / halfLife);
}

// Build the full timeline view model for a work history list.
export function buildTimeline(workHistory, now = new Date()) {
  const nowIdx = nowMonthIndex(now);
  const intervals = (workHistory ?? []).map((item) => getRoleInterval(item, now));
  const dated = intervals.filter((iv) => iv.dated);
  const undated = intervals.filter((iv) => !iv.dated);

  if (dated.length === 0) {
    return {
      intervals, dated, undated, nowIdx,
      domainStart: null, domainEnd: null, gaps: [],
      coveredMonths: 0, spanMonths: 0,
    };
  }

  const careerStart = Math.min(...dated.map((iv) => iv.start));
  const latestEnd = Math.max(...dated.map((iv) => iv.end));
  const domainEnd = Math.max(latestEnd, nowIdx);

  const gaps = computeGaps(dated, { domainStart: careerStart, domainEnd: nowIdx });
  const merged = mergeIntervals(dated);
  const coveredMonths = merged.reduce((sum, span) => sum + (span.end - span.start + 1), 0);

  return {
    intervals, dated, undated, nowIdx,
    domainStart: careerStart,
    domainEnd,
    gaps,
    coveredMonths,
    spanMonths: domainEnd - careerStart + 1,
  };
}

// Assign each dated interval to a horizontal lane so overlapping roles stack
// instead of hiding one another (like a geologic-period chart). Returns the
// intervals with a `lane` index and the total lane count.
export function assignLanes(intervals) {
  const sorted = [...intervals]
    .filter((iv) => iv.dated)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const laneEnds = []; // last end index occupying each lane
  const placed = sorted.map((iv) => {
    let lane = laneEnds.findIndex((end) => iv.start > end + 1);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(iv.end);
    } else {
      laneEnds[lane] = iv.end;
    }
    return { ...iv, lane };
  });
  return { placed, laneCount: Math.max(1, laneEnds.length) };
}

// Two spans overlap when they share at least one month.
function spansOverlap(a, b) {
  return Math.max(a.start, b.start) <= Math.min(a.end, b.end);
}

// Normalize a company name for matching. Deliberately conservative: fix case and
// whitespace, drop parenthetical notes (e.g. "(Contract)"), strip punctuation, and
// remove only unambiguous legal suffixes. It does NOT split on separators or do any
// fuzzy/prefix matching, so distinct names like "Celsius" and "Celsius Network"
// stay distinct — only genuine typo/case variants of the same name collapse.
export function normalizeCompanyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Two roles are the same employer only when their normalized names match exactly.
// Blank names never match.
export function isSameEmployer(nameA, nameB) {
  const a = normalizeCompanyName(nameA);
  const b = normalizeCompanyName(nameB);
  return Boolean(a) && a === b;
}

function unionFind(size) {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  return { find, union: (a, b) => { parent[find(a)] = find(b); } };
}

// Lay dated roles into lanes. Roles at the same employer share ONE lane — a
// promotion path reads as a single row of segments, not an overlap stack — and
// only genuinely different, concurrent employers split into separate lanes.
// Non-overlapping employers fill the full height; overlapping ones split it.
// Within a stack, the most recent tenure is placed on top (lane 0).
export function assignLaneGroups(intervals) {
  const dated = [...intervals].filter((iv) => iv.dated);
  if (dated.length === 0) return { placed: [], maxGroupLanes: 1 };

  // 1. Group roles into employers (same company name, case/prefix-insensitive).
  //    Roles with a blank company each stand alone.
  const roleUF = unionFind(dated.length);
  for (let i = 0; i < dated.length; i += 1) {
    for (let j = i + 1; j < dated.length; j += 1) {
      if (isSameEmployer(dated[i].company, dated[j].company)) roleUF.union(i, j);
    }
  }
  const employers = new Map();
  dated.forEach((iv, i) => {
    const key = roleUF.find(i);
    if (!employers.has(key)) employers.set(key, { start: iv.start, end: iv.end, roleIndexes: [] });
    const emp = employers.get(key);
    emp.start = Math.min(emp.start, iv.start);
    emp.end = Math.max(emp.end, iv.end);
    emp.roleIndexes.push(i);
  });
  const empList = [...employers.values()];

  // 2. Cluster employers whose tenures overlap, so a standalone employer stays
  //    full-height and only concurrent employers share (and split) a stack.
  const empUF = unionFind(empList.length);
  for (let i = 0; i < empList.length; i += 1) {
    for (let j = i + 1; j < empList.length; j += 1) {
      if (spansOverlap(empList[i], empList[j])) empUF.union(i, j);
    }
  }
  const clusters = new Map();
  empList.forEach((emp, i) => {
    const key = empUF.find(i);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(emp);
  });

  // 3. Within each cluster, pack employers into lanes (greedy by start for a
  //    minimal lane count), then relabel lanes so the most recently-ending tenure
  //    sits on top (lane 0).
  let maxGroupLanes = 1;
  for (const members of clusters.values()) {
    const byStart = [...members].sort((a, b) => a.start - b.start || a.end - b.end);
    const laneEnds = [];
    for (const emp of byStart) {
      let lane = laneEnds.findIndex((end) => emp.start > end);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(emp.end);
      } else {
        laneEnds[lane] = emp.end;
      }
      emp.lane = lane;
    }
    const groupLanes = Math.max(1, laneEnds.length);
    maxGroupLanes = Math.max(maxGroupLanes, groupLanes);

    const laneMaxEnd = new Map();
    for (const emp of members) {
      laneMaxEnd.set(emp.lane, Math.max(laneMaxEnd.get(emp.lane) ?? -Infinity, emp.end));
    }
    const orderedLanes = [...laneMaxEnd.keys()].sort((a, b) => laneMaxEnd.get(b) - laneMaxEnd.get(a));
    const remap = new Map(orderedLanes.map((lane, index) => [lane, index]));
    for (const emp of members) {
      emp.lane = remap.get(emp.lane);
      emp.groupLanes = groupLanes;
    }
  }

  // 4. Each role inherits its employer's lane + group height.
  const laneByRole = new Map();
  for (const emp of empList) {
    for (const roleIndex of emp.roleIndexes) {
      laneByRole.set(roleIndex, { lane: emp.lane, groupLanes: emp.groupLanes });
    }
  }
  const placed = dated
    .map((iv, i) => ({ ...iv, ...laneByRole.get(i) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  return { placed, maxGroupLanes };
}

// Deterministically choose which roles a generated resume MUST include so it
// reads as continuous, currently-employed history. Returns required role ids
// plus a per-id reason. This is a hard rule, not an LLM judgement: at least one
// current role (or the most recent role if none is current) is always required,
// and older roles are pulled in only when they cover a still-recent gap.
export function selectRolesForContinuousCoverage(workHistory, options = {}) {
  const {
    now = new Date(),
    minGapMonths = NOTABLE_GAP_MONTHS,
    horizonMonths = GAP_COVERAGE_HORIZON_MONTHS,
  } = options;

  const nowIdx = nowMonthIndex(now);
  const intervals = (workHistory ?? []).map((item) => getRoleInterval(item, now));
  const dated = intervals.filter((iv) => iv.dated);

  const reasons = {};
  const requiredIds = [];
  const require = (id, reason) => {
    if (!id || reasons[id]) return;
    reasons[id] = reason;
    requiredIds.push(id);
  };

  if (dated.length === 0) {
    return { requiredIds, reasons, gaps: [], careerStart: null, nowIdx };
  }

  const careerStart = Math.min(...dated.map((iv) => iv.start));
  // Only enforce continuity across the recent past. Roles and gaps older than
  // the horizon are left to relevance (the LLM), so a 15-year-old job is never
  // force-included just because an even older gap sits beside it.
  const coverageStart = Math.max(careerStart, nowIdx - horizonMonths);

  // 1. Always anchor on a current role — or the single most recent role when the
  //    candidate isn't currently employed — so recent history is never dropped.
  const ongoing = dated.filter((iv) => iv.ongoing);
  const anchor = (ongoing.length ? ongoing : dated)
    .slice()
    .sort((a, b) => b.end - a.end || b.start - a.start)[0];
  if (anchor) require(anchor.id, ongoing.length ? "current" : "most-recent");

  const selectedIds = new Set(requiredIds);
  const selected = () => dated.filter((iv) => selectedIds.has(iv.id));

  const recentNotableGaps = () =>
    computeGaps(selected(), { domainStart: coverageStart, domainEnd: nowIdx, minGapMonths });

  // 2. Greedily pull in the excluded role that best fills a recent gap until no
  //    remaining role can meaningfully close one (genuine unemployment stays).
  //    Overlap is time-decayed: months spent covering a recent gap count for
  //    more than the same months against an older one, so recent continuity is
  //    prioritized. Bounded by the number of dated roles, so it always terminates.
  for (let guard = 0; guard < dated.length + 1; guard += 1) {
    const gaps = recentNotableGaps();
    if (gaps.length === 0) break;

    let best = null;
    let bestScore = 0;
    for (const iv of dated) {
      if (selectedIds.has(iv.id)) continue;
      let score = 0;
      for (const gap of gaps) {
        const covered = Math.max(0, Math.min(iv.end, gap.end) - Math.max(iv.start, gap.start) + 1);
        if (covered > 0) score += covered * recencyWeight(nowIdx - gap.end);
      }
      if (score <= 0) continue;
      // Prefer the biggest (recency-weighted) gap-filler; ties go to the more recent role.
      if (score > bestScore || (score === bestScore && best && iv.end > best.end)) {
        best = iv;
        bestScore = score;
      }
    }

    if (!best) break;
    require(best.id, "covers-gap");
    selectedIds.add(best.id);
  }

  return {
    requiredIds,
    reasons,
    gaps: computeGaps(dated, { domainStart: careerStart, domainEnd: nowIdx, minGapMonths }),
    careerStart,
    nowIdx,
  };
}

// A plain-language summary of employment continuity for prompts and UI.
export function summarizeCoverage(workHistory, now = new Date()) {
  const timeline = buildTimeline(workHistory, now);
  const selection = selectRolesForContinuousCoverage(workHistory, { now });
  const byId = new Map((workHistory ?? []).map((item) => [item.id, item]));

  const requiredRoles = selection.requiredIds
    .map((id) => ({ item: byId.get(id), reason: selection.reasons[id] }))
    .filter((entry) => entry.item);

  const currentlyEmployed = timeline.dated.some((iv) => iv.ongoing);
  const totalGapMonths = timeline.gaps.reduce((sum, gap) => sum + gap.months, 0);
  const largestGap = timeline.gaps.reduce(
    (max, gap) => (gap.months > (max?.months ?? 0) ? gap : max),
    null
  );

  return {
    timeline,
    selection,
    requiredRoles,
    currentlyEmployed,
    totalGapMonths,
    largestGap,
    undatedCount: timeline.undated.length,
  };
}
