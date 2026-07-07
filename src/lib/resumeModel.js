import {
  MONTH_NAME_TO_NUM,
  DEFAULT_PROFILE,
  DEFAULT_VISIBLE_CONTACT_FIELDS,
} from "./constants";

export function normalizeWorkMonth(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";

  const mapped = MONTH_NAME_TO_NUM[normalized.toLowerCase()];
  if (mapped) return mapped;

  if (/^\d{1,2}$/.test(normalized)) {
    const monthNum = parseInt(normalized, 10);
    if (monthNum >= 1 && monthNum <= 12) {
      return String(monthNum).padStart(2, "0");
    }
  }

  return "";
}

export function normalizeWorkYear(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (/^present$/i.test(normalized) || /^current$/i.test(normalized)) return "present";

  const yearMatch = normalized.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) return yearMatch[0];

  if (/^\d{1,4}$/.test(normalized)) return normalized;

  return "";
}

export function parseWorkDateParts(value) {
  const normalized = value.trim();
  if (!normalized) return { month: "", year: "" };
  if (/^present$/i.test(normalized) || /^current$/i.test(normalized)) {
    return { month: "", year: "present" };
  }

  let match = normalized.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (match) {
    return {
      month: String(parseInt(match[2], 10)).padStart(2, "0"),
      year: match[1],
    };
  }

  match = normalized.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (match) {
    return {
      month: String(parseInt(match[1], 10)).padStart(2, "0"),
      year: match[2],
    };
  }

  if (/^\d{4}$/.test(normalized)) {
    return { month: "", year: normalized };
  }

  const tokens = normalized.split(/[\s,/-]+/).filter(Boolean);
  const year = tokens.find((token) => /^(19|20)\d{2}$/.test(token)) ?? "";
  let month = "";

  for (const token of tokens) {
    const mapped = MONTH_NAME_TO_NUM[token.toLowerCase()];
    if (mapped) {
      month = mapped;
      break;
    }

    if (/^\d{1,2}$/.test(token)) {
      const monthNum = parseInt(token, 10);
      if (monthNum >= 1 && monthNum <= 12) {
        month = String(monthNum).padStart(2, "0");
        break;
      }
    }
  }

  return { month, year };
}

export function workHistorySortScore(month, year) {
  const normalizedYear = normalizeWorkYear(year);
  const normalizedMonth = normalizeWorkMonth(month);
  const yearNum = normalizedYear === "present" ? 9999 : parseInt(normalizedYear, 10) || 0;
  const monthNum = parseInt(normalizedMonth, 10) || 0;
  return yearNum * 100 + monthNum;
}

export function compareWorkHistoryByDate(a, b) {
  const endDiff =
    workHistorySortScore(b.endMonth, b.endYear) - workHistorySortScore(a.endMonth, a.endYear);
  if (endDiff !== 0) return endDiff;
  return workHistorySortScore(b.startMonth, b.startYear) - workHistorySortScore(a.startMonth, a.startYear);
}

export function sortWorkHistory(items) {
  return [...items].sort(compareWorkHistoryByDate);
}

export function makeResumeId() {
  return globalThis.crypto?.randomUUID?.() ?? `resume-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function makeWorkHistoryId() {
  return `work-${makeResumeId()}`;
}

export function formatResumeName(value) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  return normalized.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

export function formatResumeDate(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function titleResume(company, jobTitle, date = new Date()) {
  const formattedCompany = formatResumeName(company);
  const formattedTitle = formatResumeName(jobTitle);
  const parts = [formattedCompany, formattedTitle].filter(Boolean);
  if (!parts.length) return "New Resume";
  return `${parts.join(" - ")} - ${formatResumeDate(date)}`;
}

export function titleGeneratedResume(company, jobTitle, date = new Date()) {
  const formattedCompany = formatResumeName(company);
  const formattedTitle = formatResumeName(jobTitle);
  const parts = [formattedCompany, formattedTitle, formatResumeDate(date)].filter(Boolean);
  return parts.join(" - ");
}

// Ensures new resume names stay unique. Names already embed the creation date, so
// an exact match means same company/role created the same day — disambiguate those
// with a numbered suffix (e.g. "Acme - Engineer - 2026-7-2 (1)", " (2)", ...).
export function getUniqueResumeName(baseName, resumes, excludeId = null) {
  const existingNames = new Set(
    resumes
      .filter((resume) => resume.id !== excludeId)
      .map((resume) => resume.name)
  );
  if (!existingNames.has(baseName)) return baseName;
  let counter = 1;
  while (existingNames.has(`${baseName} (${counter})`)) {
    counter += 1;
  }
  return `${baseName} (${counter})`;
}

export function formatExportDate(value) {
  const parsed = value ? new Date(value) : new Date();
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// Best-effort recovery of company/title from a legacy resume name shaped like
// "Company - Position - YYYY-M-D" for resumes saved before those fields existed.
export function parseResumeNameParts(name) {
  const segments = String(name || "")
    .split(" - ")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length && /^\d{4}-\d{1,2}-\d{1,2}$/.test(segments[segments.length - 1])) {
    segments.pop();
  }
  return { company: segments[0] ?? "", jobTitle: segments[1] ?? "" };
}

export function buildResumeExportName({ fullName, markdown, company, jobTitle, updatedAt }) {
  const headingName = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const name = (fullName || "").trim() || headingName || "Resume";
  const parts = [
    name,
    formatResumeName(company ?? ""),
    formatResumeName(jobTitle ?? ""),
    formatExportDate(updatedAt),
  ].filter(Boolean);
  return parts.join(" - ");
}

export function getResumeName(md, fallback = "Untitled Resume") {
  const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const subtitle = md
    .split("\n")
    .find((line, index, lines) => index > lines.findIndex((item) => item.startsWith("# ")) && line.trim() && line.trim() !== "---")
    ?.trim();

  if (title && subtitle) return `${title} - ${subtitle}`;
  return title || fallback;
}

export function createResumeMarkdown(name) {
  return name ? `# ${name}` : "";
}

export function makeEducationId() {
  return `edu-${makeResumeId()}`;
}

export function createEducationItem(values = {}) {
  const endParts = parseWorkDateParts(values.endDate ?? "");

  return {
    id: values.id ?? makeEducationId(),
    school: values.school ?? "",
    degree: values.degree ?? "",
    year: normalizeWorkYear(values.year ?? values.endYear ?? endParts.year),
    description: values.description ?? "",
  };
}

export function createWorkHistoryItem(values = {}) {
  const startParts = parseWorkDateParts(values.startDate ?? "");
  const endParts = parseWorkDateParts(values.endDate ?? "");

  return {
    id: values.id ?? makeWorkHistoryId(),
    position: values.position ?? "",
    company: values.company ?? "",
    startMonth: normalizeWorkMonth(values.startMonth ?? startParts.month),
    startYear: normalizeWorkYear(values.startYear ?? startParts.year),
    endMonth: normalizeWorkMonth(values.endMonth ?? endParts.month),
    endYear: normalizeWorkYear(values.endYear ?? endParts.year),
    description: values.description ?? "",
  };
}

export function parseWorkHistory(md) {
  const lines = md.split("\n");
  const entries = [];
  let inExperience = false;

  lines.forEach((line, index) => {
    if (line.startsWith("## ")) {
      inExperience = line.slice(3).trim().toLowerCase() === "experience";
      return;
    }

    if (!inExperience || !line.startsWith("### ")) return;

    const [position = "", company = ""] = line.slice(4).split(/\s+[—-]\s+/, 2);
    const dateLine = lines[index + 1]?.trim() ?? "";
    const [startDate = "", endDate = ""] = dateLine.split(/\s+[—-]\s+/, 2);
    const descriptionLines = [];

    for (let nextIndex = index + 2; nextIndex < lines.length; nextIndex++) {
      const nextLine = lines[nextIndex];
      if (nextLine.startsWith("## ") || nextLine.startsWith("### ")) break;
      if (nextLine.startsWith("- ")) descriptionLines.push(nextLine.slice(2));
    }

    entries.push(createWorkHistoryItem({
      position: position.trim(),
      company: company.trim(),
      startDate: startDate.trim(),
      endDate: endDate.trim(),
      description: descriptionLines.join("\n"),
    }));
  });

  return entries;
}

export function createResume(company = "", jobTitle = "") {
  const name = titleResume(company, jobTitle);
  const roleForMarkdown = formatResumeName(jobTitle);
  return {
    id: makeResumeId(),
    name,
    company: company.trim(),
    jobTitle: jobTitle.trim(),
    content: createResumeMarkdown(roleForMarkdown),
    workHistory: [],
    updatedAt: new Date().toISOString(),
  };
}

export const DEFAULT_RESUME = createResume();
export const INITIAL_RESUMES = [DEFAULT_RESUME];
export const INITIAL_WORK_HISTORY = [];

export function normalizeStoredList(value, fallback) {
  return Array.isArray(value) ? value : fallback;
}

/* ── Description details ───────────────────────────────────── */
// People write work-history descriptions either as one detail per line (with or
// without bullet markers) or as flowing sentences in a paragraph. Everything
// that needs "the individual details" goes through these helpers so neither
// format is an artificial constraint the person has to know about.

const DETAIL_MARKER = /^\s*[-•*]\s*/;

// A sentence ends at ./!/? followed by whitespace and something that starts a
// new sentence. Decimals ("3.5 stars") never match because they have no
// whitespace after the period.
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=["'“”‘’(]?[A-Z0-9])/;

// Fragments ending in these are abbreviations or initials, not sentence ends —
// glue the next fragment back on (e.g. "e.g.", "Inc.", "U.S.", "Dr.").
const NON_TERMINAL_ENDING =
  /(?:\b(?:e\.g|i\.e|etc|vs|ca|no|dept|est|approx|inc|corp|ltd|co|dr|mr|ms|mrs|jr|sr|st)|\b[A-Za-z])\.$/i;

export function splitLineIntoSentences(line) {
  const text = String(line ?? "").trim();
  if (!text) return [];

  const merged = [];
  for (const part of text.split(SENTENCE_BOUNDARY)) {
    const fragment = part.trim();
    if (!fragment) continue;
    const previous = merged[merged.length - 1];
    if (previous && NON_TERMINAL_ENDING.test(previous)) {
      merged[merged.length - 1] = `${previous} ${fragment}`;
    } else {
      merged.push(fragment);
    }
  }
  return merged;
}

// The individual details of a description: bullet lines, plain lines, and the
// separate sentences inside any line that holds several.
export function splitDescriptionIntoDetails(description) {
  return String(description ?? "")
    .split("\n")
    .map((line) => line.replace(DETAIL_MARKER, "").trim())
    .filter(Boolean)
    .flatMap(splitLineIntoSentences);
}

// Canonical form for "is this the same detail?" checks: markers, whitespace
// runs, case, and trailing punctuation don't count as differences.
export function normalizeDetailForComparison(value) {
  return String(value ?? "")
    .replace(DETAIL_MARKER, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .toLowerCase();
}

export function normalizeProfile(value) {
  return {
    ...DEFAULT_PROFILE,
    ...(value && typeof value === "object" ? value : {}),
    visibleContactFields: normalizeStoredList(value?.visibleContactFields, DEFAULT_VISIBLE_CONTACT_FIELDS),
    education: sortEducation(
      normalizeStoredList(value?.education, []).map(normalizeEducationItem)
    ),
  };
}

export function normalizeWorkHistoryItem(value = {}) {
  return createWorkHistoryItem({
    ...value,
    id: value.id,
    position: value.position ?? "",
    company: value.company ?? "",
    startMonth: value.startMonth ?? "",
    startYear: value.startYear ?? "",
    endMonth: value.endMonth ?? "",
    endYear: value.endYear ?? "",
    description: Array.isArray(value.description)
      ? value.description.join("\n")
      : value.description ?? "",
  });
}

export function normalizeEducationItem(value = {}) {
  return createEducationItem({
    ...value,
    id: value.id,
    school: value.school ?? "",
    degree: value.degree ?? "",
    year: value.year ?? value.endYear ?? "",
    description: Array.isArray(value.description)
      ? value.description.join("\n")
      : value.description ?? "",
  });
}

export function compareEducationByDate(a, b) {
  return workHistorySortScore("", b.year) - workHistorySortScore("", a.year);
}

export function sortEducation(items) {
  return [...items].sort(compareEducationByDate);
}

export function normalizeResume(value, index = 0) {
  const fallback = DEFAULT_RESUME;
  const stored = value && typeof value === "object" ? value : {};
  const content = typeof value === "string"
    ? value
    : typeof stored.content === "string"
      ? stored.content
      : typeof stored.markdown === "string"
        ? stored.markdown
        : fallback.content;
  const name = typeof stored.name === "string" && stored.name.trim()
    ? stored.name.trim()
    : getResumeName(content, fallback.name);
  const workHistorySource = Array.isArray(stored.workHistory)
    ? stored.workHistory
    : parseWorkHistory(content);
  const legacyParts = parseResumeNameParts(name);
  const company = typeof stored.company === "string" && stored.company.trim()
    ? stored.company.trim()
    : legacyParts.company;
  const jobTitle = typeof stored.jobTitle === "string" && stored.jobTitle.trim()
    ? stored.jobTitle.trim()
    : legacyParts.jobTitle;

  return {
    id: typeof stored.id === "string" && stored.id.trim() ? stored.id : fallback.id,
    name,
    company,
    jobTitle,
    content,
    workHistory: workHistorySource.map(normalizeWorkHistoryItem),
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : "",
  };
}

export function normalizeResumeList(value) {
  const source = Array.isArray(value) && value.length > 0 ? value : INITIAL_RESUMES;
  const normalized = source.map(normalizeResume);

  return normalized.length > 0 ? normalized : INITIAL_RESUMES;
}

export function workHistoryKey(item) {
  return [
    item.company,
    item.position,
    item.startMonth,
    item.startYear,
    item.endMonth,
    item.endYear,
  ]
    .map((part) => String(part ?? "").trim().toLowerCase())
    .join("|");
}

export function mergeWorkHistory(current, incoming) {
  const merged = [...current];

  incoming.forEach((item) => {
    const normalized = normalizeWorkHistoryItem(item);
    const key = workHistoryKey(normalized);
    const existingIndex = merged.findIndex((existing) => workHistoryKey(existing) === key);

    if (existingIndex >= 0) {
      merged[existingIndex] = {
        ...merged[existingIndex],
        ...normalized,
        id: merged[existingIndex].id,
      };
    } else if (normalized.position || normalized.company || normalized.description) {
      merged.push(normalized);
    }
  });

  return merged.length > 0 ? sortWorkHistory(merged) : merged;
}

export function educationKey(item) {
  return [
    item.school,
    item.degree,
    item.year,
  ]
    .map((part) => String(part ?? "").trim().toLowerCase())
    .join("|");
}

export function mergeEducation(current, incoming) {
  const merged = [...(current ?? [])];

  (incoming ?? []).forEach((item) => {
    const normalized = normalizeEducationItem(item);
    const key = educationKey(normalized);
    const existingIndex = merged.findIndex((existing) => educationKey(existing) === key);

    if (existingIndex >= 0) {
      merged[existingIndex] = {
        ...merged[existingIndex],
        ...normalized,
        id: merged[existingIndex].id,
      };
    } else if (normalized.school || normalized.degree || normalized.description) {
      merged.push(normalized);
    }
  });

  return merged.length > 0 ? sortEducation(merged) : merged;
}

export function getVisibleContactLine(profile) {
  return (profile.visibleContactFields ?? DEFAULT_VISIBLE_CONTACT_FIELDS)
    .map((field) => profile[field])
    .filter(Boolean)
    .join(" · ");
}
