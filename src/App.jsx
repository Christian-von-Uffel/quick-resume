import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { prepareWithSegments, layout, layoutWithLines } from "@chenglou/pretext";

/* ── Page constants ────────────────────────────────────────── */
const PAGE_W = 620;
const PAGE_H = Math.round(PAGE_W * (297 / 210));
const DEFAULT_PAD = 40;
const FONT = "InterVariable, sans-serif";
const LH_MIN = 1.15;
const LH_MAX = 1.8;
const LH_DEFAULT = 1.5;
const FS_MAX_DEFAULT = 14;
const STORAGE_KEY = "quick-resume:v1";
const PROFILE_EXPORT_VERSION = 1;
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

const LLM_PROVIDERS = [
  ["gemini", "Google"],
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
];

const OPENAI_MODEL_OPTIONS = [
  ["gpt-5.5", "gpt-5.5"],
  ["gpt-5.4", "gpt-5.4"],
  ["gpt-5.4-mini", "gpt-5.4-mini"],
  ["gpt-5.4-nano", "gpt-5.4-nano"],
];

const FALLBACK_MODEL_OPTIONS = {
  gemini: [
    ["gemini-3.5-flash", "gemini-3.5-flash"],
    ["gemini-3.1-pro-preview", "gemini-3.1-pro-preview"],
    ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
  ],
  openai: OPENAI_MODEL_OPTIONS,
  anthropic: [
    ["claude-fable-5", "claude-fable-5"],
    ["claude-opus-4-8", "claude-opus-4-8"],
    ["claude-sonnet-4-6", "claude-sonnet-4-6"],
    ["claude-haiku-4-5", "claude-haiku-4-5"],
  ],
};

const CONTACT_FIELDS = [
  ["location", "Location"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["linkedin", "LinkedIn"],
  ["github", "GitHub"],
  ["website", "Website"],
];

const DEFAULT_VISIBLE_CONTACT_FIELDS = ["location", "email", "linkedin", "github", "website"];

const DEFAULT_PROFILE = {
  name: "",
  headline: "",
  location: "",
  email: "",
  phone: "",
  linkedin: "",
  github: "",
  website: "",
  visibleContactFields: DEFAULT_VISIBLE_CONTACT_FIELDS,
  education: [],
};

const DEFAULT_LLM_SETTINGS = {
  provider: "gemini",
  model: DEFAULT_GEMINI_MODEL,
  geminiApiKey: "",
  openaiApiKey: "",
  anthropicApiKey: "",
  firecrawlApiKey: "",
  rememberApiKey: true,
};


const MONTH_OPTIONS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_SELECT_OPTIONS = MONTH_OPTIONS.map((label, index) => [
  String(index + 1).padStart(2, "0"),
  label,
]);

const EMPTY_POSITION_DRAFT = {
  position: "",
  company: "",
  startMonth: "",
  startYear: "",
  endMonth: "",
  endYear: "",
};

const MONTH_NAME_TO_NUM = MONTH_OPTIONS.reduce((acc, month, index) => {
  const num = String(index + 1).padStart(2, "0");
  acc[month.toLowerCase()] = num;
  acc[month.slice(0, 3).toLowerCase()] = num;
  return acc;
}, {});

for (let month = 1; month <= 12; month += 1) {
  MONTH_NAME_TO_NUM[String(month)] = String(month).padStart(2, "0");
  MONTH_NAME_TO_NUM[String(month).padStart(2, "0")] = String(month).padStart(2, "0");
}

function normalizeWorkMonth(value) {
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

function normalizeWorkYear(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (/^present$/i.test(normalized) || /^current$/i.test(normalized)) return "present";

  const yearMatch = normalized.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) return yearMatch[0];

  if (/^\d{1,4}$/.test(normalized)) return normalized;

  return "";
}

function parseWorkDateParts(value) {
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

function workHistorySortScore(month, year) {
  const normalizedYear = normalizeWorkYear(year);
  const normalizedMonth = normalizeWorkMonth(month);
  const yearNum = normalizedYear === "present" ? 9999 : parseInt(normalizedYear, 10) || 0;
  const monthNum = parseInt(normalizedMonth, 10) || 0;
  return yearNum * 100 + monthNum;
}

function compareWorkHistoryByDate(a, b) {
  const endDiff =
    workHistorySortScore(b.endMonth, b.endYear) - workHistorySortScore(a.endMonth, a.endYear);
  if (endDiff !== 0) return endDiff;
  return workHistorySortScore(b.startMonth, b.startYear) - workHistorySortScore(a.startMonth, a.startYear);
}

function sortWorkHistory(items) {
  return [...items].sort(compareWorkHistoryByDate);
}

function makeResumeId() {
  return globalThis.crypto?.randomUUID?.() ?? `resume-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeWorkHistoryId() {
  return `work-${makeResumeId()}`;
}

function formatResumeName(value) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  return normalized.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function formatResumeDate(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function titleResume(company, jobTitle, date = new Date()) {
  const formattedCompany = formatResumeName(company);
  const formattedTitle = formatResumeName(jobTitle);
  const parts = [formattedCompany, formattedTitle].filter(Boolean);
  if (!parts.length) return "New Resume";
  return `${parts.join(" - ")} - ${formatResumeDate(date)}`;
}

function titleGeneratedResume(company, jobTitle, date = new Date()) {
  const formattedCompany = formatResumeName(company);
  const formattedTitle = formatResumeName(jobTitle);
  const parts = [formattedCompany, formattedTitle, formatResumeDate(date)].filter(Boolean);
  return parts.join(" - ");
}

function formatExportDate(value) {
  const parsed = value ? new Date(value) : new Date();
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// Best-effort recovery of company/title from a legacy resume name shaped like
// "Company - Position - YYYY-M-D" for resumes saved before those fields existed.
function parseResumeNameParts(name) {
  const segments = String(name || "")
    .split(" - ")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length && /^\d{4}-\d{1,2}-\d{1,2}$/.test(segments[segments.length - 1])) {
    segments.pop();
  }
  return { company: segments[0] ?? "", jobTitle: segments[1] ?? "" };
}

function buildResumeExportName({ fullName, markdown, company, jobTitle, updatedAt }) {
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

function getResumeName(md, fallback = "Untitled Resume") {
  const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const subtitle = md
    .split("\n")
    .find((line, index, lines) => index > lines.findIndex((item) => item.startsWith("# ")) && line.trim() && line.trim() !== "---")
    ?.trim();

  if (title && subtitle) return `${title} - ${subtitle}`;
  return title || fallback;
}

function createResumeMarkdown(name) {
  return name ? `# ${name}` : "";
}

function makeEducationId() {
  return `edu-${makeResumeId()}`;
}

function createEducationItem(values = {}) {
  const endParts = parseWorkDateParts(values.endDate ?? "");

  return {
    id: values.id ?? makeEducationId(),
    school: values.school ?? "",
    degree: values.degree ?? "",
    year: normalizeWorkYear(values.year ?? values.endYear ?? endParts.year),
    description: values.description ?? "",
  };
}

function createWorkHistoryItem(values = {}) {
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

function parseWorkHistory(md) {
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

function createResume(company = "", jobTitle = "") {
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

const DEFAULT_RESUME = createResume();
const INITIAL_RESUMES = [DEFAULT_RESUME];
const INITIAL_WORK_HISTORY = [];

function normalizeStoredList(value, fallback) {
  return Array.isArray(value) ? value : fallback;
}

function loadStoredAppState() {
  if (typeof window === "undefined") return {};

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveStoredAppState(state) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Local storage is a convenience layer; the editor should keep working without it.
  }
}

function buildProfileExportPayload({ profile, workHistory, resumes, selectedResumeId, llmSettings }) {
  return {
    version: PROFILE_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    profile,
    workHistory: workHistory.map(normalizeWorkHistoryItem),
    resumes: resumes.map(({ id, name, company, jobTitle, content, updatedAt }) => ({
      id,
      name,
      company,
      jobTitle,
      content,
      updatedAt,
    })),
    selectedResumeId,
    llmSettings: {
      provider: llmSettings.provider,
      model: llmSettings.model,
    },
  };
}

function parseProfileExportFile(raw) {
  let parsed = raw;

  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("The file is not valid JSON.");
    }
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("The file is not a valid One Resume export.");
  }

  const resumes = normalizeResumeList(parsed.resumes);
  const workHistory = sortWorkHistory(
    normalizeStoredList(parsed.workHistory, []).map(normalizeWorkHistoryItem)
  );
  const profile = normalizeProfile(parsed.profile);
  const selectedResume =
    resumes.find((resume) => resume.id === parsed.selectedResumeId) ?? resumes[0];
  const importedLlm = normalizeLlmSettings(parsed.llmSettings);

  return {
    profile,
    workHistory,
    resumes,
    selectedResumeId: selectedResume.id,
    markdown: selectedResume.content,
    llmSettings: importedLlm,
  };
}

function downloadJsonFile(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function normalizeProfile(value) {
  return {
    ...DEFAULT_PROFILE,
    ...(value && typeof value === "object" ? value : {}),
    visibleContactFields: normalizeStoredList(value?.visibleContactFields, DEFAULT_VISIBLE_CONTACT_FIELDS),
    education: sortEducation(
      normalizeStoredList(value?.education, []).map(normalizeEducationItem)
    ),
  };
}

function normalizeModelId(id) {
  return String(id ?? "").trim().replace(/^models\//, "");
}

function createModelOption(id) {
  const modelId = normalizeModelId(id);
  return [modelId, modelId];
}

function getDefaultModelForProvider(provider, modelOptionsByProvider = FALLBACK_MODEL_OPTIONS) {
  const options = modelOptionsByProvider[provider] ?? FALLBACK_MODEL_OPTIONS[provider] ?? [];
  if (options[0]?.[0]) return options[0][0];
  if (provider === "openai") return DEFAULT_OPENAI_MODEL;
  if (provider === "anthropic") return DEFAULT_ANTHROPIC_MODEL;
  return DEFAULT_GEMINI_MODEL;
}

function stripModelSnapshotSuffix(id) {
  return id.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function dedupeModelOptions(options) {
  const seen = new Set();

  return options.filter(([id]) => {
    const base = stripModelSnapshotSuffix(id);
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  });
}

function isGeminiTextModel(model) {
  const methods = model.supportedGenerationMethods ?? [];
  if (!methods.includes("generateContent")) return false;

  const id = (model.name ?? "").replace(/^models\//, "");
  if (!/^gemini/i.test(id)) return false;
  if (/embedding|embed|aqa|imagen|veo|tts|live|robotics|computer-use/i.test(id)) return false;
  if (methods.includes("embedContent") && !methods.includes("generateContent")) return false;
  if (typeof model.outputTokenLimit === "number" && model.outputTokenLimit <= 0) return false;

  return true;
}

function isAnthropicTextModel(model) {
  return model.type === "model" && /^claude[-_]/i.test(model.id ?? "");
}

async function fetchAllGeminiModels(apiKey) {
  const models = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      key: apiKey.trim(),
      pageSize: "1000",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?${params}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message ?? "Could not load Gemini models.");
    }

    models.push(...(data.models ?? []));
    pageToken = data.nextPageToken ?? null;
  } while (pageToken);

  return models;
}

async function fetchAllAnthropicModels(apiKey) {
  const models = [];
  let afterId = null;

  while (true) {
    const params = new URLSearchParams({ limit: "1000" });
    if (afterId) params.set("after_id", afterId);

    const response = await fetch(`https://api.anthropic.com/v1/models?${params}`, {
      headers: {
        "x-api-key": apiKey.trim(),
        "anthropic-version": "2023-06-01",
        // Anthropic blocks browser origins by default; this header opts into CORS.
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message ?? "Could not load Anthropic models.");
    }

    models.push(...(data.data ?? []));
    if (!data.has_more || !data.last_id) break;
    afterId = data.last_id;
  }

  return models;
}

async function fetchGeminiModelOptions(apiKey) {
  const models = await fetchAllGeminiModels(apiKey);

  return dedupeModelOptions(
    models
      .filter(isGeminiTextModel)
      .map((model) => createModelOption((model.name ?? "").replace(/^models\//, "")))
      .sort((a, b) => a[0].localeCompare(b[0]))
  );
}

async function fetchOpenAIModelOptions(_apiKey) {
  return OPENAI_MODEL_OPTIONS;
}

async function fetchAnthropicModelOptions(apiKey) {
  const models = await fetchAllAnthropicModels(apiKey);

  return dedupeModelOptions(
    models
      .filter(isAnthropicTextModel)
      .map((model) => createModelOption(model.id))
  );
}

async function fetchProviderModelOptions(provider, apiKey) {
  const key = sanitizeApiKey(apiKey);
  if (provider === "openai") return fetchOpenAIModelOptions(key);
  if (provider === "anthropic") return fetchAnthropicModelOptions(key);
  return fetchGeminiModelOptions(key);
}

// API keys are sent as HTTP header values, which must be Latin-1. Pasted keys
// sometimes carry invisible or non-ASCII characters (smart quotes, zero-width
// spaces, non-breaking spaces) that survive .trim() and make fetch throw
// "String contains non ISO-8859-1 code point" before the request is sent.
// Provider keys are always printable ASCII, so strip anything else.
function sanitizeApiKey(key) {
  return (key ?? "").replace(/[^\x20-\x7E]/g, "").trim();
}

function getApiKeyForProvider(settings) {
  if (settings.provider === "openai") return settings.openaiApiKey ?? "";
  if (settings.provider === "anthropic") return settings.anthropicApiKey ?? "";
  return settings.geminiApiKey ?? "";
}

function getProviderLabel(provider) {
  return LLM_PROVIDERS.find(([value]) => value === provider)?.[1] ?? "selected provider";
}

function applyApiKeyDrafts(settings, drafts) {
  return {
    ...settings,
    geminiApiKey: drafts.gemini,
    openaiApiKey: drafts.openai,
    anthropicApiKey: drafts.anthropic,
    firecrawlApiKey: drafts.firecrawl,
    rememberApiKey: true,
  };
}

function normalizeLlmProvider(value) {
  if (value === "openai" || value === "anthropic") return value;
  return "gemini";
}

function normalizeLlmSettings(value) {
  const raw = value && typeof value === "object" ? value : {};
  const provider = normalizeLlmProvider(raw.provider);
  const fallbackModel = getDefaultModelForProvider(provider);
  const modelOptions = (FALLBACK_MODEL_OPTIONS[provider] ?? []).map(([model]) => model);
  const model = modelOptions.includes(raw.model) ? raw.model : fallbackModel;

  let geminiApiKey = raw.geminiApiKey ?? "";
  let openaiApiKey = raw.openaiApiKey ?? "";
  let anthropicApiKey = raw.anthropicApiKey ?? "";
  let firecrawlApiKey = raw.firecrawlApiKey ?? "";

  if (raw.apiKey && !geminiApiKey && !openaiApiKey && !anthropicApiKey) {
    if (provider === "openai") openaiApiKey = raw.apiKey;
    else if (provider === "anthropic") anthropicApiKey = raw.apiKey;
    else geminiApiKey = raw.apiKey;
  }

  return {
    ...DEFAULT_LLM_SETTINGS,
    ...raw,
    provider,
    model,
    geminiApiKey,
    openaiApiKey,
    anthropicApiKey,
    firecrawlApiKey,
    rememberApiKey: true,
  };
}

function normalizeWorkHistoryItem(value = {}) {
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

function normalizeEducationItem(value = {}) {
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

function compareEducationByDate(a, b) {
  return workHistorySortScore("", b.year) - workHistorySortScore("", a.year);
}

function sortEducation(items) {
  return [...items].sort(compareEducationByDate);
}

function normalizeResume(value, index = 0) {
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

function normalizeResumeList(value) {
  const source = Array.isArray(value) && value.length > 0 ? value : INITIAL_RESUMES;
  const normalized = source.map(normalizeResume);

  return normalized.length > 0 ? normalized : INITIAL_RESUMES;
}

function workHistoryKey(item) {
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

function mergeWorkHistory(current, incoming) {
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

function educationKey(item) {
  return [
    item.school,
    item.degree,
    item.year,
  ]
    .map((part) => String(part ?? "").trim().toLowerCase())
    .join("|");
}

function mergeEducation(current, incoming) {
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

function getVisibleContactLine(profile) {
  return (profile.visibleContactFields ?? DEFAULT_VISIBLE_CONTACT_FIELDS)
    .map((field) => profile[field])
    .filter(Boolean)
    .join(" · ");
}

function coerceImportedProfile(profile) {
  if (!profile || typeof profile !== "object") return {};

  const acc = CONTACT_FIELDS.concat([["name"], ["headline"]]).reduce((res, [field]) => {
    if (typeof profile[field] === "string") res[field] = profile[field].trim();
    return res;
  }, {});

  if (Array.isArray(profile.education)) {
    acc.education = sortEducation(profile.education.map(normalizeEducationItem));
  } else {
    acc.education = [];
  }

  return acc;
}

function validateExtractedJobTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid title JSON.");
  }

  const { company, position } = value;
  if (typeof company !== "string" || typeof position !== "string") {
    throw new Error("The title JSON must include company and position strings.");
  }

  return {
    company: company.trim(),
    position: position.trim(),
  };
}

function validateSelectedResumeEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid fit selection JSON.");
  }

  return {
    fitSummary: typeof value.fitSummary === "string" ? value.fitSummary.trim() : "",
    selectedWorkHistory: Array.isArray(value.selectedWorkHistory) ? value.selectedWorkHistory : [],
    selectedSkills: Array.isArray(value.selectedSkills) ? value.selectedSkills : [],
    excludedItems: Array.isArray(value.excludedItems) ? value.excludedItems : [],
  };
}

function normalizeMissingExperienceDetail(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const skill = typeof value.skill === "string" ? value.skill.trim() : "";
  if (!skill) return null;

  const plainspokenDetail =
    typeof value.plainspokenDetail === "string" && value.plainspokenDetail.trim()
      ? value.plainspokenDetail.trim()
      : `Experience with ${skill}.`;
  const question =
    typeof value.question === "string" && value.question.trim()
      ? formatExperienceQuestion(value.question)
      : `Do you have experience with ${skill}?`;

  if (!isSpecificExperienceQuestion(question)) return null;

  const answerPlaceholder =
    typeof value.answerPlaceholder === "string" && value.answerPlaceholder.trim()
      ? value.answerPlaceholder.trim()
      : `Yes, I ${skill.charAt(0).toLowerCase()}${skill.slice(1)}...`;

  return {
    skill,
    whyItMatters: typeof value.whyItMatters === "string" ? value.whyItMatters.trim() : "",
    question,
    plainspokenDetail,
    answerPlaceholder,
  };
}

function isSpecificExperienceQuestion(value) {
  const question = String(value ?? "").trim().toLowerCase();
  if (!question) return false;

  const broadPatterns = [
    /\band\b/,
    /[/&]/,
    /\ball\b/,
    /\bany\b/,
    /\bvarious\b/,
    /\bmultiple\b/,
    /\boverall\b/,
    /\bgeneral\b/,
    /\bfunctions?\b/,
    /\bduties\b/,
    /\btasks\b/,
    /\bresponsibilities\b/,
    /\bfront[-\s]?end\b/,
    /\bincluding\b/,
    /\bsuch as\b/,
    /\blike\b/,
    /\betc\b/,
  ];

  return !broadPatterns.some((pattern) => pattern.test(question));
}

function formatExperienceQuestion(value) {
  const question = String(value ?? "").trim();
  if (!question) return "";
  if (/^do you have experience\b/i.test(question)) return question;

  const normalized = question
    .replace(/^have you\s+/i, "")
    .replace(/^are you experienced (?:with|in)\s+/i, "")
    .replace(/^can you\s+/i, "")
    .replace(/^do you know how to\s+/i, "")
    .replace(/[?.!]*$/, "")
    .trim();

  return `Do you have experience ${normalized}?`;
}

function validateMissingExperienceDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid missing experience JSON.");
  }

  return normalizeStoredList(value.missingExperienceDetails, [])
    .map(normalizeMissingExperienceDetail)
    .filter(Boolean);
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("The model did not return JSON.");
  }

  return JSON.parse(candidate.slice(start, end + 1));
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(new Error("Could not read the uploaded file."));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read the uploaded file."));
    reader.readAsText(file);
  });
}

// Optional sampling params that some models reject: OpenAI's reasoning models
// don't accept `temperature`, and Anthropic removed `temperature`/`top_p`/`top_k`
// on its newer models (Opus 4.8, Fable 5, ...) — sending them there returns a 400.
const DROPPABLE_MODEL_PARAMS = ["temperature", "top_p", "top_k"];

// Find a parameter the API rejected so we can drop it and retry. Handles both
// OpenAI's quoted phrasing ("Unsupported parameter: 'temperature' ...") and
// Anthropic's less structured 400, which names the field without a fixed format.
function getUnsupportedParam(message, body) {
  const quoted = /unsupported parameter|not supported with this model/i.test(message)
    ? message.match(/'([^']+)'/)?.[1] ?? null
    : null;
  if (quoted && Object.prototype.hasOwnProperty.call(body, quoted)) return quoted;

  return (
    DROPPABLE_MODEL_PARAMS.find(
      (param) =>
        Object.prototype.hasOwnProperty.call(body, param) &&
        new RegExp(`\\b${param}\\b`, "i").test(message)
    ) ?? null
  );
}

// Rather than maintain a per-model allowlist, POST the request and, if the API
// rejects a parameter as unsupported, drop that parameter and retry. This keeps
// a single code path working across providers and future models.
async function postModelJson(url, headers, body, fallbackMessage) {
  let attempt = { ...body };

  // Guard against infinite loops; there are only a handful of optional params.
  for (let i = 0; i < 4; i += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(attempt),
    });

    const data = await response.json();
    if (response.ok) return data;

    const message = data.error?.message ?? "";
    const unsupportedParam = getUnsupportedParam(message, attempt);

    if (unsupportedParam) {
      const { [unsupportedParam]: _removed, ...rest } = attempt;
      attempt = rest;
      continue;
    }

    throw new Error(message || fallbackMessage);
  }

  throw new Error(fallbackMessage);
}

async function callGemini({ apiKey, model, prompt, file }) {
  const parts = [{ text: prompt }];
  if (file) {
    parts.push({
      inlineData: {
        mimeType: file.mimeType,
        data: file.base64,
      },
    });
  }

  const data = await postModelJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {},
    {
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.2 },
    },
    "Gemini request failed."
  );

  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n").trim() ?? "";
}

async function callOpenAI({ apiKey, model, prompt, file }) {
  const content = [{ type: "input_text", text: prompt }];

  if (file) {
    const dataUrl = `data:${file.mimeType};base64,${file.base64}`;
    content.push(
      file.mimeType === "application/pdf"
        ? { type: "input_file", filename: file.name, file_data: dataUrl }
        : { type: "input_image", image_url: dataUrl }
    );
  }

  const data = await postModelJson(
    "https://api.openai.com/v1/responses",
    { Authorization: `Bearer ${apiKey}` },
    {
      model,
      input: [{ role: "user", content }],
      temperature: 0.2,
    },
    "OpenAI request failed."
  );

  if (data.output_text) return data.output_text.trim();

  return data.output
    ?.flatMap((item) => item.content ?? [])
    ?.map((item) => item.text ?? "")
    ?.join("\n")
    ?.trim() ?? "";
}

async function callAnthropic({ apiKey, model, prompt, file }) {
  const content = [{ type: "text", text: prompt }];

  if (file) {
    content.push({
      type: file.mimeType === "application/pdf" ? "document" : "image",
      source: {
        type: "base64",
        media_type: file.mimeType,
        data: file.base64,
      },
    });
  }

  const data = await postModelJson(
    "https://api.anthropic.com/v1/messages",
    {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Anthropic blocks browser origins by default; this header opts into CORS.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    {
      model,
      // Well under every offered model's output cap (haiku/sonnet 64K, opus/fable
      // 128K) while staying small enough to avoid non-streaming HTTP timeouts.
      max_tokens: 16000,
      // Rejected with a 400 on newer models (Opus 4.8, Fable 5); postModelJson
      // drops it and retries when that happens, so it's kept for the models
      // (Sonnet 4.6, Haiku 4.5) that still accept it.
      temperature: 0.2,
      messages: [{ role: "user", content }],
    },
    "Anthropic request failed."
  );

  return data.content?.map((block) => block.text ?? "").join("\n").trim() ?? "";
}

async function callLlm(settings, prompt, file) {
  const apiKey = sanitizeApiKey(getApiKeyForProvider(settings));
  if (!apiKey) {
    throw new Error(`Add a ${getProviderLabel(settings.provider)} API key before calling the model.`);
  }

  const request = {
    apiKey,
    model: settings.model.trim() || getDefaultModelForProvider(settings.provider),
    prompt,
    file,
  };

  if (settings.provider === "openai") return callOpenAI(request);
  if (settings.provider === "anthropic") return callAnthropic(request);
  return callGemini(request);
}

// Call the model and parse its response as JSON. Models occasionally wrap the
// object in prose or emit a stray token that breaks a strict parse; when that
// happens, hand the model its own output back once and ask for clean JSON before
// giving up. The file (if any) isn't resent on retry — only the text needs fixing.
async function callLlmForJson(settings, prompt, file) {
  const text = await callLlm(settings, prompt, file);
  try {
    return extractJson(text);
  } catch {
    const repairPrompt = `The following response was supposed to be a single valid JSON object but could not be parsed. Return only the corrected JSON object, with no markdown fences, comments, or surrounding text.

<invalid_response>
${text}
</invalid_response>`;
    const repaired = await callLlm(settings, repairPrompt, null);
    return extractJson(repaired);
  }
}

function importResume() {
  return `<task>
Extract resume data from the uploaded file.
</task>

<instructions>
Return only valid JSON. Do not wrap it in markdown.
Use empty strings for unknown profile fields.
Use one workHistory item per role. Put accomplishment bullets in description separated by newline characters.
Normalize all dates into numeric fields:
- startMonth/endMonth: two-digit month strings from "01" to "12", or "" when only a year is known
- startYear/endYear: four-digit year strings like "2020", or "" when unknown
- endYear: use "present" for current roles
Accept any visible resume date format (January, Jan, 01, 03/2020, 2020-01, etc.) and convert it into this schema.
</instructions>

<schema>
{
  "profile": {
    "name": "",
    "headline": "",
    "location": "",
    "email": "",
    "phone": "",
    "linkedin": "",
    "github": "",
    "website": ""
  },
  "workHistory": [
    {
      "position": "",
      "company": "",
      "startMonth": "03",
      "startYear": "2020",
      "endMonth": "",
      "endYear": "present",
      "description": ""
    }
  ]
}
</schema>`;
}

function selectBestFittingExperience({ profile, workHistory, instructions }) {
  return `<task>
Select the resume evidence that best shows the candidate is a straightforward fit for the target role.
</task>

<profile>
${JSON.stringify(profile, null, 2)}
</profile>

<complete_work_history>
${JSON.stringify(workHistory, null, 2)}
</complete_work_history>

<job_description>
${instructions || "No job description provided. Select the most broadly relevant, concrete, and recent experience."}
</job_description>

<selection_policy>
Prefer direct evidence of fit over general impressiveness.
Select roles, bullets, skills, tools, and outcomes that clearly match the target job's responsibilities and requirements.
Exclude experience that is impressive but does not help a hiring manager quickly see role fit.
Do not invent facts, employers, dates, tools, metrics, schools, or responsibilities.
Do not copy phrases from the job description unless they already appear in the work history.
Keep the selection plain, credible, and specific.
</selection_policy>

<instructions>
Return only valid JSON. Do not wrap it in markdown.
Copy selected role metadata exactly from the provided work history.
Rewrite selected bullets only when needed for clarity, while preserving the facts from the source material.
Use excludedItems to explain what you intentionally left out and why.
</instructions>

<schema>
{
  "fitSummary": "One plain-language sentence explaining the candidate's fit.",
  "selectedWorkHistory": [
    {
      "position": "",
      "company": "",
      "startMonth": "",
      "startYear": "",
      "endMonth": "",
      "endYear": "",
      "fitReason": "",
      "selectedBullets": [
        "Specific source-grounded bullet that supports the target role."
      ]
    }
  ],
  "selectedSkills": [
    "Relevant skill or tool present in the profile or work history."
  ],
  "excludedItems": [
    {
      "position": "",
      "company": "",
      "reason": "Why this was less aligned with the target role."
    }
  ]
}
</schema>`;
}

function generateResume({ profile, selectedEvidence, instructions, jobTitle }) {
  return `<task>
Generate polished resume markdown for the current resume builder from curated fit evidence.
</task>

<format>
# ${profile.name || "Your Name"}
[Professional title — see title instructions]
${getVisibleContactLine(profile)}

---

[Professional summary — see summary instructions]

## EXPERIENCE

### Role — Company
Start — End
- Achievement bullet

## EDUCATION

### Degree or Certification — School
Year · Details

## SKILLS

Skill one · Skill two · Skill three
</format>

<profile>
${JSON.stringify(profile, null, 2)}
</profile>

<selected_resume_evidence>
${JSON.stringify(selectedEvidence, null, 2)}
</selected_resume_evidence>

<job_description>
${instructions || "Create a concise, results-focused one-page resume from the selected evidence."}
</job_description>

<instructions>
Return only markdown. Use the exact heading style shown in the format.
Use only the selected resume evidence and profile. Do not include excluded work history.
Write to show straightforward fit for the target role, not generic impressiveness.
Prefer measurable, plain-language bullets. Do not invent employers, dates, schools, tools, metrics, or responsibilities not present in the provided data.
Work history dates are stored as numeric months ("01"-"12") and years ("2020", or "present"). Format them for the resume as readable ranges like "March 2020 — Present".

Professional title (the line directly under the name):
- Mirror the target role in the job description so a recruiter or ATS instantly sees a match. When the candidate's background genuinely supports it, use the exact role title from the job description.
- Keep it a concise title, not a sentence. An optional short qualifier is fine (e.g. "Senior Product Manager — B2B SaaS & Growth").
- Ground it in the candidate's real experience; never claim a level or specialty the selected evidence does not support.${profile.headline ? `\n- The candidate's saved headline is "${profile.headline}". Use it as a starting point and adapt it toward the target role.` : ""}
- If no job description is provided, use ${profile.headline || jobTitle ? `"${profile.headline || jobTitle}"` : "a concise professional title drawn from the strongest, most recent experience"}.

Professional summary (the line under the divider):
- Write 2-3 sentences positioned as a pitch for this specific role, not a generic bio.
- Lead with the candidate's fit for the target title, then weave in the requirements, skills, and keywords from the job description that the candidate genuinely meets — matching the job's own wording where truthful, so it passes both recruiter scanning and ATS keyword matching.
- Anchor it with one or two of the strongest, most relevant achievements from the selected evidence, with real metrics where available.
- Only mirror job-description language the candidate can actually back up with the selected evidence and profile. Do not invent qualifications, years of experience, tools, or outcomes.
</instructions>`;
}

function extractJobDescription({ title, metaDescription, rawText }) {
  return `<task>
Extract and print out just the core job description from the provided raw page text.
</task>

${title ? `<page_title>${title}</page_title>\n` : ""}${metaDescription ? `<meta_description>${metaDescription}</meta_description>\n` : ""}
<raw_content>
${rawText}
</raw_content>

<instructions>
Please extract the core job description, including:
- Role overview
- Responsibilities and tasks
- Requirements, qualifications, and skills
- Benefits and company details (if relevant)

Remove any unrelated page elements like navigation bars, sidebars, header/footer links, social sharing widgets, cookie notices, or other boilerplate content.

Your response must be a valid JSON object wrapped in <json_output> and </json_output> XML tags.
The JSON object must contain exactly one key: "jobDescription".

Format the response exactly like this:
<json_output>
{
  "jobDescription": "Extracted and clean job description markdown here..."
}
</json_output>

Remember to output ONLY the XML-wrapped JSON. No explanations, no introductory text, no conversational text.
</instructions>`;
}

function extractCleanedJobDescription(text) {
  const match = text.match(/<json_output>([\s\S]*?)<\/json_output>/i);
  const jsonString = match ? match[1].trim() : text;

  try {
    let cleanedJsonString = jsonString;
    if (cleanedJsonString.startsWith("```")) {
      cleanedJsonString = cleanedJsonString.replace(/^```(?:json)?\s*\n/, "").replace(/\n```$/, "");
    }
    const data = JSON.parse(cleanedJsonString);
    if (data && typeof data === "object" && typeof data.jobDescription === "string") {
      return data.jobDescription.trim();
    }
  } catch (error) {
    console.warn("Failed to parse extracted JSON, falling back to regex block or raw text", error);
  }

  // Fallback if JSON parsing failed: if XML tags existed, return their content directly, or return the whole text stripped of tags
  const textWithoutTags = text.replace(/<\/?[a-zA-Z0-9_]+>/g, "").trim();
  return textWithoutTags;
}

function collapseBlankLines(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/(?:[ \t]*\n){2,}[ \t]*/g, "\n");
}

function buildJobTargetPrompt(jobDescription) {
  return `<task>
Extract the company and position from this job description for a saved resume title.
</task>

<job_description>
${jobDescription}
</job_description>

<instructions>
Return only valid JSON. Do not wrap it in markdown.
Use empty strings when the company or position cannot be confidently determined from the job description.
Do not infer missing values from general context.
</instructions>

<schema>
{
  "company": "",
  "position": ""
}
</schema>`;
}

function findMissingExperience({ workHistory, jobDescription }) {
  return `<task>
1. Analyze the job description below to compile a list of necessary skills, experiences, and responsibilities.
2. Cross-reference this list against the candidate's work history to identify gaps (things requested in the job description but not clearly demonstrated or mentioned in the work history).
3. Generate simple, direct, conversational questions to ask the candidate about those gaps so they can fill in their work history.
</task>

<work_history>
${JSON.stringify(workHistory, null, 2)}
</work_history>

<job_description>
${jobDescription}
</job_description>

<instructions>
- Identify concrete skills, tools, technologies, methodologies, or hands-on responsibilities in the job description that are missing from the candidate's work history.
- For each gap, generate a simple, direct, conversational question.
- Every question MUST start with the exact phrase "Do you have experience" (e.g. "Do you have experience conducting customer discovery interviews?").
- Write questions in natural, active, plainspoken language—exactly how a recruiter or hiring manager would ask a candidate during an interview. Avoid robotic, academic, corporate, or policy-heavy jargon.
- Each question must be extremely simple and focus on exactly ONE discrete topic or skill that can be answered with a clear "yes" or "no". Never ask multi-part questions.
- Keep "plainspokenDetail" simple, factual, and reusable as a bullet point in a work history description (e.g., "Conducted customer discovery interviews to identify user needs.").
- Write "answerPlaceholder" as a short, first-person example answer that starts with "Yes, I" and hints at the kind of specifics we want (what they did and, when natural, what came of it). Keep it realistic and plainspoken, not fancy. For "Do you have experience designing product literature?" a good placeholder is "Yes, I designed product brochures and one-pagers our sales team handed out at trade shows."

CRITICAL VALIDATION RULES - Violating these will cause the question to be rejected:
1. Do NOT use the word "and" or "or" anywhere in the question (split combined requirements into separate questions).
2. Do NOT use the symbols "/" or "&" anywhere in the question.
3. Do NOT use any of the following banned broad or category words anywhere in the question:
   - "all", "any", "various", "multiple", "overall", "general"
   - "function", "functions", "duties", "tasks", "responsibilities"
   - "frontend", "front-end"
   - "including", "such as", "like", "etc"
Instead of asking broad questions, ask about a single, specific activity (e.g., instead of "Do you have experience with agile tasks?", ask "Do you have experience working in an agile team?").

Limit to the 10 most useful missing details. Generate at least 5 details if possible.
Return only valid JSON matching the schema below. Do not wrap it in markdown block code or add comments.
</instructions>

<schema>
{
  "missingExperienceDetails": [
    {
      "skill": "Specific skill or detail from the job description (e.g., Customer discovery interviews)",
      "whyItMatters": "Short reason this appears important in the job description.",
      "question": "Do you have experience...",
      "plainspokenDetail": "Reusable work history detail (e.g., Conducted customer discovery interviews to identify user needs.)",
      "answerPlaceholder": "Yes, I ... (a short first-person example answer that fits the question)"
    }
  ]
}
</schema>`;
}

function formatExperienceElaboration({ question, answer }) {
  return `<task>
Rewrite the person's spoken answer into ONE clean, factual sentence describing what they did.
</task>

<question>
${question}
</question>

<answer>
${answer}
</answer>

<instructions>
- Keep the person's own wording and level of detail. Do NOT add buzzwords, corporate jargon, or embellishment, and do NOT make it sound fancier than what they actually said.
- Remove conversational lead-ins and any direct answer to the question ("Yes, I", "Yeah", "Well", "So", "Basically", "I did"). Start with a past-tense action verb.
- Keep every concrete fact the person gave: names, places, numbers, tools, dates, and outcomes. Invent nothing.
- When the answer includes a result, follow a simple "did X, which resulted in Y" shape. Otherwise just state plainly what they did.
- Fix only grammar, spelling, capitalization, and punctuation. Capitalize proper nouns correctly (e.g., "PAX East", "PS4").
- Return it as a single line with no line breaks and no leading bullet character or dash.
- If the answer has no usable detail, just return the answer cleaned up as best you can.
</instructions>

Return ONLY the rewritten sentence as plain text. No quotes, no labels, no explanation, no markdown.`;
}

function cleanFormattedDetail(text) {
  if (typeof text !== "string") return "";
  let cleaned = text.trim();

  const fenced = cleaned.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (fenced) cleaned = fenced[1].trim();

  cleaned = cleaned.replace(/\s*\n+\s*/g, " ").trim();
  cleaned = cleaned.replace(/^[-•*]\s*/, "");
  cleaned = cleaned.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();

  return cleaned;
}

/* ── Parse markdown into blocks ────────────────────────────── */
function parseMarkdown(md) {
  const blocks = [];
  const lines = md.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "---") {
      blocks.push({ type: "hr", mb: 16 });
      i++;
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith("# ")) {
      blocks.push({ text: line.slice(2), fontScale: 1.5, bold: true, mb: 4, color: "#111" });
      i++;
      continue;
    }

    if (line.startsWith("## ")) {
      blocks.push({ text: line.slice(3), fontScale: 0.85, bold: true, mt: 18, mb: 3, color: "#999" });
      i++;
      continue;
    }

    if (line.startsWith("### ")) {
      const prev = blocks[blocks.length - 1];
      const afterSection = prev && prev.fontScale === 0.85 && prev.bold;
      blocks.push({ text: line.slice(4), fontScale: 1, bold: true, mt: afterSection ? 0 : 10, mb: 2, color: "#111" });
      i++;
      continue;
    }

    if (line.startsWith("- ")) {
      blocks.push({ text: "\u2022 " + line.slice(2), fontScale: 1, bold: false, mb: 3, color: "#555" });
      i++;
      continue;
    }

    const prevBlock = blocks[blocks.length - 1];
    const isAfterTitle = prevBlock && prevBlock.bold && prevBlock.fontScale === 1 && prevBlock.mb === 2;

    if (isAfterTitle) {
      blocks.push({ text: line, fontScale: 0.8, bold: false, mb: 6, color: "#999" });
    } else if (prevBlock && prevBlock.fontScale === 1.5) {
      blocks.push({ text: line, fontScale: 1, bold: false, mb: 6, color: "#555" });
    } else if (prevBlock && !prevBlock.bold && prevBlock.color === "#555" && prevBlock.mb === 6 && prevBlock.fontScale === 1) {
      blocks.push({ text: line, fontScale: 0.8, bold: false, mb: 16, color: "#999" });
    } else {
      blocks.push({ text: line, fontScale: 1, bold: false, mb: 6, color: "#333" });
    }
    i++;
  }

  return blocks;
}

/* ── Build font string (same for prepare + DOM) ──────────── */
function fontString(baseFontSize, block) {
  const fs = baseFontSize * block.fontScale;
  return `${block.bold ? "bold " : ""}${fs}px ${FONT}`;
}

/* ── Measure blocks (pure math, no DOM) ────────────────────── */
function measureBlocks(blocks, baseFontSize, contentW, lhMult = LH_DEFAULT, sectionSpacing = 18, itemSpacing = 10, separatorSpacing = 16) {
  let h = 0;
  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx];
    if (block.mt) {
      const isSection = block.fontScale === 0.85 && block.bold;
      const isItem = block.mt > 0 && !isSection;
      h += isSection ? sectionSpacing : isItem ? itemSpacing : block.mt;
    }
    if (block.type === "hr") {
      h += separatorSpacing + 1 + separatorSpacing;
      continue;
    }
    const fs = baseFontSize * block.fontScale;
    const lh = fs * lhMult;
    const font = fontString(baseFontSize, block);
    h += layout(prepareWithSegments(block.text, font), contentW, lh).height;
    // Skip mb if the next block has mt or is an hr (spacing is handled by them)
    const next = blocks[idx + 1];
    if (next && (next.mt || next.type === "hr")) continue;
    h += block.mb;
  }
  return h;
}

/* ── Layout blocks into positioned lines ─────────────────── */
function layoutBlocks(blocks, baseFontSize, contentW, pad, lhMult = LH_DEFAULT, sectionSpacing = 18, itemSpacing = 10, separatorSpacing = 16) {
  const positioned = [];
  let y = pad;

  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx];
    if (block.mt) {
      const isSection = block.fontScale === 0.85 && block.bold;
      const isItem = block.mt > 0 && !isSection;
      y += isSection ? sectionSpacing : isItem ? itemSpacing : block.mt;
    }
    if (block.type === "hr") {
      y += separatorSpacing;
      positioned.push({ type: "hr", y });
      y += 1 + separatorSpacing;
      continue;
    }

    const fs = baseFontSize * block.fontScale;
    const lh = fs * lhMult;
    const font = fontString(baseFontSize, block);
    const prepared = prepareWithSegments(block.text, font);
    const result = layoutWithLines(prepared, contentW, lh);

    for (const line of result.lines) {
      positioned.push({
        type: "text",
        text: line.text,
        x: pad,
        y,
        font,
        fontSize: fs,
        fontWeight: block.bold ? "bold" : "normal",
        lineHeight: lh,
        color: block.color,
      });
      y += lh;
    }

    // Skip mb if the next block has mt or is an hr (spacing is handled by them)
    const next = blocks[idx + 1];
    if (next && (next.mt || next.type === "hr")) continue;
    y += block.mb;
  }

  return positioned;
}

/* ── Binary search for optimal font size + line height ────── */
function findOptimalFit(blocks, contentW, maxH, minFs = 6, maxFs = 24, sectionSpacing = 18, itemSpacing = 10, separatorSpacing = 16) {
  // Pass 1: max font size at tightest line spacing
  let lo = minFs;
  let hi = maxFs;
  while (hi - lo > 0.01) {
    const mid = (lo + hi) / 2;
    if (measureBlocks(blocks, mid, contentW, LH_MIN, sectionSpacing, itemSpacing, separatorSpacing) <= maxH) lo = mid;
    else hi = mid;
  }
  const fontSize = Math.floor(lo * 100) / 100;

  // Pass 2: expand line-height to fill remaining space
  let lhLo = LH_MIN;
  let lhHi = LH_MAX;
  while (lhHi - lhLo > 0.001) {
    const mid = (lhLo + lhHi) / 2;
    if (measureBlocks(blocks, fontSize, contentW, mid, sectionSpacing, itemSpacing, separatorSpacing) <= maxH) lhLo = mid;
    else lhHi = mid;
  }
  const lineHeightMult = Math.floor(lhLo * 1000) / 1000;

  return { fontSize, lineHeightMult };
}

/* ── Component ─────────────────────────────────────────────── */
export default function App() {
  const [storedAppState] = useState(loadStoredAppState);
  const [initialResumes] = useState(() => normalizeResumeList(storedAppState.resumes));
  const initialSelectedResume = initialResumes.find((resume) => resume.id === storedAppState.selectedResumeId) ?? initialResumes[0];
  const [resumes, setResumes] = useState(initialResumes);
  const [selectedResumeId, setSelectedResumeId] = useState(initialSelectedResume.id);
  const [markdown, setMarkdown] = useState(initialSelectedResume.content);
  const [profile, setProfile] = useState(() => normalizeProfile(storedAppState.profile));
  const [workHistory, setWorkHistory] = useState(() =>
    sortWorkHistory(
      normalizeStoredList(storedAppState.workHistory, INITIAL_WORK_HISTORY).map(normalizeWorkHistoryItem)
    )
  );
  const [llmSettings, setLlmSettings] = useState(() => normalizeLlmSettings(storedAppState.llmSettings));
  const [apiKeyDrafts, setApiKeyDrafts] = useState(() => {
    const settings = normalizeLlmSettings(storedAppState.llmSettings);
    return {
      gemini: settings.geminiApiKey,
      openai: settings.openaiApiKey,
      anthropic: settings.anthropicApiKey,
      firecrawl: settings.firecrawlApiKey ?? "",
    };
  });
  const [modelOptionsByProvider, setModelOptionsByProvider] = useState(FALLBACK_MODEL_OPTIONS);
  const [modelOptionsStatus, setModelOptionsStatus] = useState({
    gemini: "idle",
    openai: "idle",
    anthropic: "idle",
  });
  const [apiKeySaveToast, setApiKeySaveToast] = useState("");
  const [workHistorySaveToast, setWorkHistorySaveToast] = useState("");
  const [workHistorySearch, setWorkHistorySearch] = useState("");
  const [profileDataToast, setProfileDataToast] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [generateStatus, setGenerateStatus] = useState("");
  const [generationSourceType, setGenerationSourceType] = useState("text"); // "text" or "url"
  const [scrapeUrl, setScrapeUrl] = useState("");
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState("");
  const [scrapeSuccess, setScrapeSuccess] = useState("");
  const [generationInstructions, setGenerationInstructions] = useState("");
  const [missingExperienceStatus, setMissingExperienceStatus] = useState("");
  const [missingExperienceDetails, setMissingExperienceDetails] = useState([]);
  const [confirmedMissingExperienceSkills, setConfirmedMissingExperienceSkills] = useState([]);
  const [dismissedMissingExperienceSkills, setDismissedMissingExperienceSkills] = useState([]);
  const [missingExperiencePositionFilters, setMissingExperiencePositionFilters] = useState({});
  const [missingExperienceSelectedPositions, setMissingExperienceSelectedPositions] = useState({});
  // Raw answers keyed by skill, then by work-history id: { [skill]: { [workId]: text } }
  const [missingExperienceElaborations, setMissingExperienceElaborations] = useState({});
  const [isSavingMissingExperience, setIsSavingMissingExperience] = useState(false);
  const [missingExperienceSaveToast, setMissingExperienceSaveToast] = useState("");
  // Which detail's skill triggered the "add a missing position" modal (null = closed)
  const [addPositionForSkill, setAddPositionForSkill] = useState(null);
  const [newPositionDraft, setNewPositionDraft] = useState(EMPTY_POSITION_DRAFT);
  const [isImporting, setIsImporting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isFindingMissingExperience, setIsFindingMissingExperience] = useState(false);
  const [fontSize, setFontSize] = useState(11);
  const [padding, setPadding] = useState(DEFAULT_PAD);
  const [ready, setReady] = useState(false);
  const [lineHeightMult, setLineHeightMult] = useState(LH_DEFAULT);
  const [maxFontSize, setMaxFontSize] = useState(FS_MAX_DEFAULT);
  const [sectionSpacing, setSectionSpacing] = useState(18);
  const [itemSpacing, setItemSpacing] = useState(10);
  const [separatorSpacing, setSeparatorSpacing] = useState(16);
  const [autoFit, setAutoFit] = useState(true);
  const [pageScale, setPageScale] = useState(1);
  const [activeMainTab, setActiveMainTab] = useState("workHistory");
  const [activeResumeTab, setActiveResumeTab] = useState("preview");
  const [isResumeMenuOpen, setIsResumeMenuOpen] = useState(false);
  const [isFitSidebarOpen, setIsFitSidebarOpen] = useState(false);
  const [isCreateResumeOpen, setIsCreateResumeOpen] = useState(false);
  const [resumeCompanyDraft, setResumeCompanyDraft] = useState("");
  const [resumeJobTitleDraft, setResumeJobTitleDraft] = useState("");
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    return window.localStorage.getItem("theme") === "dark" ? "dark" : "light";
  });
  const pageRef = useRef(null);
  const previewRef = useRef(null);
  const resumeMenuRef = useRef(null);
  const apiKeySaveToastTimeoutRef = useRef(null);
  const workHistorySaveToastTimeoutRef = useRef(null);
  const workHistorySaveToastDebounceRef = useRef(null);
  const profileDataToastTimeoutRef = useRef(null);
  const missingExperienceSaveToastTimeoutRef = useRef(null);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem("theme", theme);
  }, [theme]);

  const sortedWorkHistory = useMemo(() => sortWorkHistory(workHistory), [workHistory]);
  const visibleWorkHistory = useMemo(() => {
    const normalized = workHistorySearch.trim().toLowerCase();
    if (!normalized) return sortedWorkHistory;
    return sortedWorkHistory.filter((item) => {
      const searchableText = [item.position, item.company].filter(Boolean).join(" ").toLowerCase();
      return searchableText.includes(normalized);
    });
  }, [sortedWorkHistory, workHistorySearch]);
  const sortedEducation = useMemo(
    () => sortEducation(profile.education ?? []),
    [profile.education]
  );
  const activeModelOptions = useMemo(
    () => modelOptionsByProvider[llmSettings.provider] ?? FALLBACK_MODEL_OPTIONS[llmSettings.provider] ?? [],
    [llmSettings.provider, modelOptionsByProvider]
  );
  const activeModelOptionsStatus = modelOptionsStatus[llmSettings.provider] ?? "idle";

  const contentW = PAGE_W - padding * 2;
  const maxH = PAGE_H - padding * 2;

  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  const selectedResume = useMemo(
    () => resumes.find((resume) => resume.id === selectedResumeId) ?? resumes[0],
    [resumes, selectedResumeId]
  );
  const visibleMissingExperienceDetails = useMemo(
    () =>
      missingExperienceDetails.filter(
        (detail) => !dismissedMissingExperienceSkills.includes(detail.skill)
      ),
    [dismissedMissingExperienceSkills, missingExperienceDetails]
  );
  const totalSelectedMissingExperiencePositions = useMemo(
    () =>
      visibleMissingExperienceDetails.reduce(
        (total, detail) =>
          confirmedMissingExperienceSkills.includes(detail.skill)
            ? total + (missingExperienceSelectedPositions[detail.skill]?.length ?? 0)
            : total,
        0
      ),
    [
      visibleMissingExperienceDetails,
      confirmedMissingExperienceSkills,
      missingExperienceSelectedPositions,
    ]
  );
  const workHistoryByPositionCompany = useMemo(
    () =>
      [...workHistory].sort((a, b) => {
        const positionCompare = (a.position || "").localeCompare(b.position || "", undefined, {
          sensitivity: "base",
        });
        if (positionCompare !== 0) return positionCompare;

        return (a.company || "").localeCompare(b.company || "", undefined, {
          sensitivity: "base",
        });
      }),
    [workHistory]
  );

  useEffect(() => {
    document.fonts.ready.then(() => setReady(true));
    if (document.fonts.status === "loaded") setReady(true);
  }, []);

  useEffect(() => {
    const fallback = resumes[0] ?? createResume();

    if (selectedResume?.id === selectedResumeId) return;

    if (!resumes.length) {
      setResumes([fallback]);
    }
    setSelectedResumeId(fallback.id);
    setMarkdown(fallback.content);
  }, [resumes, selectedResume, selectedResumeId]);

  useEffect(() => {
    saveStoredAppState({
      resumes,
      selectedResumeId,
      profile,
      workHistory,
      llmSettings,
    });
  }, [resumes, selectedResumeId, profile, workHistory, llmSettings]);

  useEffect(() => {
    let cancelled = false;

    async function loadProviderModels(provider, apiKey) {
      if (!apiKey.trim()) {
        if (cancelled) return;
        setModelOptionsByProvider((current) => ({
          ...current,
          [provider]: FALLBACK_MODEL_OPTIONS[provider] ?? [],
        }));
        setModelOptionsStatus((current) => ({ ...current, [provider]: "idle" }));
        return;
      }

      setModelOptionsStatus((current) => ({ ...current, [provider]: "loading" }));

      try {
        const options = await fetchProviderModelOptions(provider, apiKey);
        if (cancelled) return;

        if (!options.length) {
          setModelOptionsStatus((current) => ({ ...current, [provider]: "error" }));
          return;
        }

        setModelOptionsByProvider((current) => ({ ...current, [provider]: options }));
        setModelOptionsStatus((current) => ({ ...current, [provider]: "ready" }));
      } catch {
        if (!cancelled) {
          setModelOptionsStatus((current) => ({ ...current, [provider]: "error" }));
        }
      }
    }

    loadProviderModels("gemini", llmSettings.geminiApiKey);
    loadProviderModels("openai", llmSettings.openaiApiKey);
    loadProviderModels("anthropic", llmSettings.anthropicApiKey);

    return () => {
      cancelled = true;
    };
  }, [llmSettings.geminiApiKey, llmSettings.openaiApiKey, llmSettings.anthropicApiKey]);

  useEffect(() => {
    if (!activeModelOptions.length) return;

    const validIds = activeModelOptions.map(([id]) => id);
    if (validIds.includes(llmSettings.model)) return;

    setLlmSettings((current) => ({
      ...current,
      model: getDefaultModelForProvider(current.provider, modelOptionsByProvider),
    }));
  }, [activeModelOptions, llmSettings.model, llmSettings.provider, modelOptionsByProvider]);

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const sx = width / PAGE_W;
      const sy = height / PAGE_H;
      setPageScale(Math.min(sx, sy, 1));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!isResumeMenuOpen) return;

    const handleClickOutside = (event) => {
      if (!resumeMenuRef.current?.contains(event.target)) {
        setIsResumeMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isResumeMenuOpen]);

  useEffect(() => () => {
    if (apiKeySaveToastTimeoutRef.current) {
      clearTimeout(apiKeySaveToastTimeoutRef.current);
    }
    if (workHistorySaveToastTimeoutRef.current) {
      clearTimeout(workHistorySaveToastTimeoutRef.current);
    }
    if (workHistorySaveToastDebounceRef.current) {
      clearTimeout(workHistorySaveToastDebounceRef.current);
    }
    if (profileDataToastTimeoutRef.current) {
      clearTimeout(profileDataToastTimeoutRef.current);
    }
    if (missingExperienceSaveToastTimeoutRef.current) {
      clearTimeout(missingExperienceSaveToastTimeoutRef.current);
    }
  }, []);

  const { measuredHeight, measureTime } = useMemo(() => {
    if (!ready) return { measuredHeight: 0, measureTime: 0 };
    const t0 = performance.now();
    const h = measureBlocks(blocks, fontSize, contentW, lineHeightMult, sectionSpacing, itemSpacing, separatorSpacing);
    return {
      measuredHeight: Math.round(h),
      measureTime: +(performance.now() - t0).toFixed(2),
    };
  }, [blocks, fontSize, contentW, lineHeightMult, sectionSpacing, itemSpacing, separatorSpacing, ready]);

  const positioned = useMemo(() => {
    if (!ready) return [];
    return layoutBlocks(blocks, fontSize, contentW, padding, lineHeightMult, sectionSpacing, itemSpacing, separatorSpacing);
  }, [blocks, fontSize, contentW, padding, lineHeightMult, sectionSpacing, itemSpacing, separatorSpacing, ready]);

  useEffect(() => {
    if (!ready || !autoFit) return;
    const { fontSize: optFs, lineHeightMult: optLh } = findOptimalFit(blocks, contentW, maxH, 6, 24, sectionSpacing, itemSpacing, separatorSpacing);
    const capped = Math.min(optFs, maxFontSize);
    setFontSize(capped);
    setLineHeightMult(optLh);
  }, [blocks, padding, autoFit, ready, contentW, maxH, maxFontSize, sectionSpacing, itemSpacing, separatorSpacing]);

  const handleSlider = (e) => {
    setAutoFit(false);
    setFontSize(parseFloat(e.target.value));
  };

  const handleLineHeightSlider = (e) => {
    setAutoFit(false);
    setLineHeightMult(parseFloat(e.target.value));
  };

  const handleMarkdownChange = (e) => {
    const nextMarkdown = e.target.value;
    updateSelectedResumeMarkdown(nextMarkdown);
  };

  const handleGenerationInstructionsChange = (value) => {
    setGenerationInstructions(value);
    setMissingExperienceDetails([]);
    setConfirmedMissingExperienceSkills([]);
    setDismissedMissingExperienceSkills([]);
    setMissingExperiencePositionFilters({});
    setMissingExperienceSelectedPositions({});
    setMissingExperienceElaborations({});
    setMissingExperienceSaveToast("");
    setMissingExperienceStatus("");
  };

  const updateSelectedResumeMarkdown = (nextMarkdown, nextName) => {
    setMarkdown(nextMarkdown);
    setResumes((current) =>
      current.map((resume) =>
        resume.id === selectedResumeId
          ? {
              ...resume,
              content: nextMarkdown,
              updatedAt: new Date().toISOString(),
              ...(nextName ? { name: nextName } : {}),
            }
          : resume
      )
    );
  };

  const updateProfileField = (field, value) => {
    setProfile((current) => ({ ...current, [field]: value }));
  };

  const toggleVisibleContactField = (field) => {
    setProfile((current) => {
      const visibleFields = current.visibleContactFields ?? DEFAULT_VISIBLE_CONTACT_FIELDS;
      return {
        ...current,
        visibleContactFields: visibleFields.includes(field)
          ? visibleFields.filter((item) => item !== field)
          : [...visibleFields, field],
      };
    });
  };

  const updateLlmSetting = (field, value) => {
    setLlmSettings((current) => {
      if (field === "provider") {
        return {
          ...current,
          provider: value,
          model: getDefaultModelForProvider(value, modelOptionsByProvider),
        };
      }

      return { ...current, [field]: value };
    });
  };

  const showProfileDataToast = (message) => {
    setProfileDataToast(message);

    if (profileDataToastTimeoutRef.current) {
      clearTimeout(profileDataToastTimeoutRef.current);
    }

    profileDataToastTimeoutRef.current = setTimeout(() => {
      setProfileDataToast("");
      profileDataToastTimeoutRef.current = null;
    }, 3000);
  };

  const handleExportProfileData = () => {
    const payload = buildProfileExportPayload({
      profile,
      workHistory,
      resumes,
      selectedResumeId,
      llmSettings,
    });
    const date = new Date().toISOString().slice(0, 10);
    downloadJsonFile(payload, `quick-resume-export-${date}.json`);
    showProfileDataToast("Profile data exported.");
  };

  const handleImportProfileData = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await readFileAsText(file);
      const imported = parseProfileExportFile(text);

      setProfile(imported.profile);
      setWorkHistory(imported.workHistory);
      setResumes(imported.resumes);
      setSelectedResumeId(imported.selectedResumeId);
      setMarkdown(imported.markdown);
      setLlmSettings((current) => ({
        ...imported.llmSettings,
        geminiApiKey: current.geminiApiKey,
        openaiApiKey: current.openaiApiKey,
        anthropicApiKey: current.anthropicApiKey,
        firecrawlApiKey: current.firecrawlApiKey,
        rememberApiKey: true,
      }));
      showProfileDataToast("Profile data imported.");
    } catch (error) {
      showProfileDataToast(error instanceof Error ? error.message : "Import failed.");
    } finally {
      event.target.value = "";
    }
  };

  const handleSaveApiKeys = () => {
    setLlmSettings((current) => applyApiKeyDrafts(current, apiKeyDrafts));

    setApiKeySaveToast("API keys saved to this device.");

    if (apiKeySaveToastTimeoutRef.current) {
      clearTimeout(apiKeySaveToastTimeoutRef.current);
    }

    apiKeySaveToastTimeoutRef.current = setTimeout(() => {
      setApiKeySaveToast("");
      apiKeySaveToastTimeoutRef.current = null;
    }, 3000);
  };

  const handleSelectResume = (resumeId) => {
    const resume = resumes.find((item) => item.id === resumeId);
    if (!resume) return;

    setSelectedResumeId(resume.id);
    setMarkdown(resume.content);
    setIsResumeMenuOpen(false);
  };

  const handleDeleteResume = (resumeId) => {
    const remaining = resumes.filter((resume) => resume.id !== resumeId);
    const nextResumes = remaining.length > 0 ? remaining : [createResume()];
    const nextSelected = resumeId === selectedResumeId ? nextResumes[0] : selectedResume;

    setResumes(nextResumes);
    setSelectedResumeId(nextSelected.id);
    setMarkdown(nextSelected.content);
  };

  const handleOpenCreateResume = () => {
    setResumeCompanyDraft("");
    setResumeJobTitleDraft("");
    setIsResumeMenuOpen(false);
    setIsCreateResumeOpen(true);
  };

  const handleCreateResume = (e) => {
    e.preventDefault();

    if (!resumeCompanyDraft.trim() && !resumeJobTitleDraft.trim()) return;

    const resume = createResume(resumeCompanyDraft, resumeJobTitleDraft);
    setResumes((current) => [...current, resume]);
    setSelectedResumeId(resume.id);
    setMarkdown(resume.content);
    setResumeCompanyDraft("");
    setResumeJobTitleDraft("");
    setIsCreateResumeOpen(false);
  };

  const handleAddWorkHistory = () => {
    setWorkHistory((current) => [...current, createWorkHistoryItem()]);
  };

  const handleUpdateWorkHistory = (workId, field, value) => {
    let nextValue = value;
    if (field === "startMonth" || field === "endMonth") {
      nextValue = normalizeWorkMonth(value);
    } else if (field === "startYear" || field === "endYear") {
      nextValue = normalizeWorkYear(value);
    }

    setWorkHistory((current) =>
      sortWorkHistory(
        current.map((item) =>
          item.id === workId
            ? normalizeWorkHistoryItem({ ...item, [field]: nextValue })
            : item
        )
      )
    );

    if (field === "description") {
      if (workHistorySaveToastDebounceRef.current) {
        clearTimeout(workHistorySaveToastDebounceRef.current);
      }

      workHistorySaveToastDebounceRef.current = setTimeout(() => {
        setWorkHistorySaveToast("Work history saved.");

        if (workHistorySaveToastTimeoutRef.current) {
          clearTimeout(workHistorySaveToastTimeoutRef.current);
        }

        workHistorySaveToastTimeoutRef.current = setTimeout(() => {
          setWorkHistorySaveToast("");
          workHistorySaveToastTimeoutRef.current = null;
        }, 3000);
        workHistorySaveToastDebounceRef.current = null;
      }, 600);
    }
  };

  const handleDeleteWorkHistory = (workId) => {
    setWorkHistory((current) => current.filter((item) => item.id !== workId));
  };

  const handleAddEducation = () => {
    setProfile((current) => ({
      ...current,
      education: [...(current.education ?? []), createEducationItem()],
    }));
  };

  const handleUpdateEducation = (eduId, field, value) => {
    const nextValue = field === "year" ? normalizeWorkYear(value) : value;
    setProfile((current) => ({
      ...current,
      education: (current.education ?? []).map((item) =>
        item.id === eduId
          ? normalizeEducationItem({ ...item, [field]: nextValue })
          : item
      ),
    }));
  };

  const handleDeleteEducation = (eduId) => {
    setProfile((current) => ({
      ...current,
      education: (current.education ?? []).filter((item) => item.id !== eduId),
    }));
  };

  const handleScrapeJobPage = async () => {
    if (!scrapeUrl.trim()) return;
    setIsScraping(true);
    setScrapeError("");
    setScrapeSuccess("");

    let firecrawlKey = sanitizeApiKey(apiKeyDrafts.firecrawl) || sanitizeApiKey(llmSettings.firecrawlApiKey);
    if (!firecrawlKey && sanitizeApiKey(apiKeyDrafts.firecrawl)) {
      firecrawlKey = sanitizeApiKey(apiKeyDrafts.firecrawl);
      setLlmSettings((current) => applyApiKeyDrafts(current, apiKeyDrafts));
    }

    if (!firecrawlKey) {
      setScrapeError("Please enter and save a Firecrawl API key first.");
      setIsScraping(false);
      return;
    }

    try {
      // 1. Fetch raw markdown and metadata from Firecrawl
      const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${firecrawlKey}`,
        },
        body: JSON.stringify({
          url: scrapeUrl.trim(),
          formats: ["markdown"],
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Scrape failed with status ${response.status}`);
      }

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || "Scrape was unsuccessful.");
      }

      const scrapedText = result.data?.markdown;
      if (!scrapedText) {
        throw new Error("No markdown content was returned from the page.");
      }

      const pageTitle = result.data?.metadata?.title || "";
      const pageDescription = result.data?.metadata?.description || "";

      // 2. Select the cheapest model depending on the active provider
      const provider = llmSettings.provider;
      let cheapestModel = "";
      if (provider === "openai") {
        cheapestModel = "gpt-5.4-nano";
      } else if (provider === "anthropic") {
        cheapestModel = "claude-haiku-4-5";
      } else {
        cheapestModel = "gemini-3.1-flash-lite";
      }

      // Prepare LLM settings with cheapest model
      const settingsWithDraftKeys = applyApiKeyDrafts(llmSettings, apiKeyDrafts);
      const cleanLlmSettings = {
        ...settingsWithDraftKeys,
        model: cheapestModel,
      };

      // 3. Clean up raw content using the cheapest model
      setScrapeSuccess("Scraped raw text. Cleaning up job description with AI...");
      
      const cleanPrompt = extractJobDescription({
        title: pageTitle,
        metaDescription: pageDescription,
        rawText: scrapedText,
      });

      const cleanedLlmResponse = await callLlm(cleanLlmSettings, cleanPrompt, null);
      const cleanedText = extractCleanedJobDescription(cleanedLlmResponse);

      handleGenerationInstructionsChange(cleanedText);
      setScrapeSuccess("Job description successfully scraped and cleaned!");
      setTimeout(() => {
        setGenerationSourceType("text");
        setScrapeSuccess("");
      }, 1500);

    } catch (error) {
      setScrapeError(error instanceof Error ? error.message : "An error occurred while scraping the page.");
    } finally {
      setIsScraping(false);
    }
  };

  const handleFindMissingExperienceDetails = async () => {
    const jobDescription = generationInstructions.trim();
    if (!jobDescription) {
      setMissingExperienceStatus("Paste a job description first.");
      return;
    }
    if (!workHistory.length) {
      setMissingExperienceStatus("Add work history first so there is something to compare against.");
      return;
    }

    setIsFindingMissingExperience(true);
    setMissingExperienceStatus("Looking for useful details that are missing from your work history...");

    try {
      const parsed = await callLlmForJson(
        applyApiKeyDrafts(llmSettings, apiKeyDrafts),
        findMissingExperience({ workHistory, jobDescription }),
        null
      );
      const details = validateMissingExperienceDetails(parsed);
      setMissingExperienceDetails(details);
      setConfirmedMissingExperienceSkills([]);
      setDismissedMissingExperienceSkills([]);
      setMissingExperiencePositionFilters({});
      setMissingExperienceSelectedPositions({});
      setMissingExperienceElaborations({});
      setMissingExperienceSaveToast("");
      setMissingExperienceStatus(
        details.length
          ? `Found ${details.length} detail${details.length === 1 ? "" : "s"} to check.`
          : "No obvious missing work experience details found."
      );
    } catch (error) {
      setMissingExperienceStatus(error instanceof Error ? error.message : "Could not find missing details.");
    } finally {
      setIsFindingMissingExperience(false);
    }
  };

  const handleDismissMissingExperienceDetail = (skill) => {
    setDismissedMissingExperienceSkills((current) =>
      current.includes(skill) ? current : [...current, skill]
    );
    setConfirmedMissingExperienceSkills((current) => current.filter((item) => item !== skill));
    setMissingExperienceSelectedPositions((current) => {
      const { [skill]: _removed, ...remaining } = current;
      return remaining;
    });
    setMissingExperienceElaborations((current) => {
      const { [skill]: _removed, ...remaining } = current;
      return remaining;
    });
  };

  const handleConfirmMissingExperienceDetail = (skill) => {
    setConfirmedMissingExperienceSkills((current) =>
      current.includes(skill) ? current : [...current, skill]
    );
  };

  const handleMissingExperienceElaborationChange = (skill, workId, value) => {
    setMissingExperienceElaborations((current) => ({
      ...current,
      [skill]: {
        ...(current[skill] ?? {}),
        [workId]: value,
      },
    }));
  };

  const handleOpenAddPosition = (skill) => {
    setNewPositionDraft(EMPTY_POSITION_DRAFT);
    setAddPositionForSkill(skill);
  };

  const handleCloseAddPosition = () => {
    setAddPositionForSkill(null);
    setNewPositionDraft(EMPTY_POSITION_DRAFT);
  };

  const handleNewPositionDraftChange = (field, value) => {
    setNewPositionDraft((current) => ({ ...current, [field]: value }));
  };

  const handleAddMissingPosition = (e) => {
    e.preventDefault();
    const skill = addPositionForSkill;
    if (!skill) return;

    const position = newPositionDraft.position.trim();
    const company = newPositionDraft.company.trim();
    if (!position && !company) return;

    const item = createWorkHistoryItem({
      position,
      company,
      startMonth: newPositionDraft.startMonth,
      startYear: newPositionDraft.startYear,
      endMonth: newPositionDraft.endMonth,
      endYear: newPositionDraft.endYear,
    });

    setWorkHistory((current) => sortWorkHistory([...current, item]));
    // Auto-select the new role for this question and clear the search so it stays visible,
    // letting the user pop straight back to filling in the answer that prompted it.
    setMissingExperienceSelectedPositions((current) => ({
      ...current,
      [skill]: [...(current[skill] ?? []), item.id],
    }));
    setMissingExperiencePositionFilters((current) => ({ ...current, [skill]: "" }));
    handleCloseAddPosition();
  };

  const handleMissingExperiencePositionFilterChange = (skill, value) => {
    setMissingExperiencePositionFilters((current) => ({
      ...current,
      [skill]: value,
    }));
  };

  const handleToggleMissingExperiencePosition = (skill, workId) => {
    setMissingExperienceSelectedPositions((current) => {
      const selected = current[skill] ?? [];
      const nextSelected = selected.includes(workId)
        ? selected.filter((id) => id !== workId)
        : [...selected, workId];

      return {
        ...current,
        [skill]: nextSelected,
      };
    });
  };

  const showMissingExperienceSaveToast = (message) => {
    setMissingExperienceSaveToast(message);

    if (missingExperienceSaveToastTimeoutRef.current) {
      clearTimeout(missingExperienceSaveToastTimeoutRef.current);
    }

    missingExperienceSaveToastTimeoutRef.current = setTimeout(() => {
      setMissingExperienceSaveToast("");
      missingExperienceSaveToastTimeoutRef.current = null;
    }, 4000);
  };

  const handleSaveMissingExperienceDetails = async () => {
    const confirmedDetails = visibleMissingExperienceDetails.filter((detail) =>
      confirmedMissingExperienceSkills.includes(detail.skill)
    );

    // One task per (question, selected position). The typed answer, if any, gets
    // rewritten by the model; otherwise we fall back to the generic detail.
    const tasks = [];
    for (const detail of confirmedDetails) {
      const selectedWorkIds = missingExperienceSelectedPositions[detail.skill] ?? [];
      for (const workId of selectedWorkIds) {
        tasks.push({
          detail,
          workId,
          answer: (missingExperienceElaborations[detail.skill]?.[workId] ?? "").trim(),
        });
      }
    }

    if (tasks.length === 0) {
      setMissingExperienceStatus("Pick at least one position for a question before saving.");
      return;
    }

    setIsSavingMissingExperience(true);
    setMissingExperienceStatus("");

    try {
      const settings = applyApiKeyDrafts(llmSettings, apiKeyDrafts);
      const resolved = await Promise.all(
        tasks.map(async (task) => {
          const fallback = task.detail.plainspokenDetail.replace(/^[-•]\s*/, "").trim();
          if (!task.answer) {
            return { workId: task.workId, line: fallback };
          }
          const text = await callLlm(
            settings,
            formatExperienceElaboration({ question: task.detail.question, answer: task.answer }),
            null
          );
          return { workId: task.workId, line: cleanFormattedDetail(text) || fallback };
        })
      );

      const linesByWorkId = new Map();
      for (const { workId, line } of resolved) {
        if (!line) continue;
        const existing = linesByWorkId.get(workId) ?? [];
        existing.push(line);
        linesByWorkId.set(workId, existing);
      }

      let savedCount = 0;
      const nextWorkHistory = sortWorkHistory(
        workHistory.map((item) => {
          const newLines = linesByWorkId.get(item.id);
          if (!newLines || newLines.length === 0) return item;

          const existing = item.description.split("\n").map((line) => line.trim()).filter(Boolean);
          const existingLower = new Set(existing.map((line) => line.toLowerCase()));
          const additions = [];
          for (const line of newLines) {
            const key = line.toLowerCase();
            if (existingLower.has(key)) continue;
            existingLower.add(key);
            additions.push(line);
          }
          if (additions.length === 0) return item;

          savedCount += additions.length;
          return normalizeWorkHistoryItem({
            ...item,
            description: [...existing, ...additions].join("\n"),
          });
        })
      );

      setWorkHistory(nextWorkHistory);

      // Drop the questions we just saved so they leave the list (and the whole
      // section disappears once every question has been handled).
      const savedSkills = new Set(
        confirmedDetails
          .filter((detail) => (missingExperienceSelectedPositions[detail.skill] ?? []).length > 0)
          .map((detail) => detail.skill)
      );
      setDismissedMissingExperienceSkills((current) => {
        const additions = [...savedSkills].filter((skill) => !current.includes(skill));
        return additions.length ? [...current, ...additions] : current;
      });
      setConfirmedMissingExperienceSkills((current) =>
        current.filter((skill) => !savedSkills.has(skill))
      );
      setMissingExperienceSelectedPositions((current) => {
        const next = { ...current };
        for (const skill of savedSkills) delete next[skill];
        return next;
      });
      setMissingExperienceElaborations((current) => {
        const next = { ...current };
        for (const skill of savedSkills) delete next[skill];
        return next;
      });

      const positionLabel = savedCount === 1 ? "position" : "positions";
      showMissingExperienceSaveToast(
        savedCount > 0
          ? `Saved to ${savedCount} ${positionLabel}.`
          : "Those details were already saved."
      );
    } catch (error) {
      setMissingExperienceStatus(
        error instanceof Error ? error.message : "Could not save those experience details."
      );
    } finally {
      setIsSavingMissingExperience(false);
    }
  };

  const handleImportResume = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setImportStatus("Reading resume file...");

    try {
      const base64 = await readFileAsBase64(file);
      setImportStatus("Asking the model to extract profile and work history...");
      const imported = await callLlmForJson(applyApiKeyDrafts(llmSettings, apiKeyDrafts), importResume(), {
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        base64,
      });
      const importedProfile = coerceImportedProfile(imported.profile);
      const importedHistory = normalizeStoredList(imported.workHistory, []).map(normalizeWorkHistoryItem);

      setProfile((current) => {
        const nextProfile = {
          ...current,
          ...Object.fromEntries(
            Object.entries(importedProfile)
              .filter(([key, value]) => key !== "education" && value)
          ),
        };
        if (Array.isArray(importedProfile.education)) {
          nextProfile.education = mergeEducation(current.education ?? [], importedProfile.education);
        }
        return nextProfile;
      });
      setWorkHistory((current) => mergeWorkHistory(current, importedHistory));
      setImportStatus(`Imported ${importedHistory.length} role${importedHistory.length === 1 ? "" : "s"} from ${file.name}.`);
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setIsImporting(false);
      event.target.value = "";
    }
  };

  const handleGenerateMarkdown = async () => {
    setIsGenerating(true);
    setGenerateStatus("Extracting resume title details...");

    try {
      const settingsWithDraftKeys = applyApiKeyDrafts(llmSettings, apiKeyDrafts);
      const targetJson = await callLlmForJson(
        settingsWithDraftKeys,
        buildJobTargetPrompt(generationInstructions),
        null
      );
      const extractedTarget = validateExtractedJobTarget(targetJson);
      const resumeTitle = titleGeneratedResume(extractedTarget.company, extractedTarget.position);

      setGenerateStatus("Selecting aligned work history...");
      const selectionJson = await callLlmForJson(
        settingsWithDraftKeys,
        selectBestFittingExperience({ profile, workHistory, instructions: generationInstructions }),
        null
      );
      const selectedEvidence = validateSelectedResumeEvidence(selectionJson);

      setGenerateStatus("Generating resume from selected evidence...");
      const text = await callLlm(
        settingsWithDraftKeys,
        generateResume({
          profile,
          selectedEvidence,
          instructions: generationInstructions,
          jobTitle: extractedTarget.position,
        }),
        null
      );
      const nextMarkdown = text.replace(/^```(?:markdown)?\s*/i, "").replace(/```$/i, "").trim();
      // Save each generation as its own resume so existing resumes are never overwritten.
      const generatedResume = {
        ...createResume(extractedTarget.company, extractedTarget.position),
        name: resumeTitle,
        content: nextMarkdown,
        updatedAt: new Date().toISOString(),
      };
      setResumes((current) => [...current, generatedResume]);
      setSelectedResumeId(generatedResume.id);
      setMarkdown(nextMarkdown);
      setGenerateStatus("Generated a new resume.");
      setActiveMainTab("resume");
      setActiveResumeTab("editor");
    } catch (error) {
      setGenerateStatus(error instanceof Error ? error.message : "Generation failed.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExportPdf = useCallback(() => {
    const page = pageRef.current;
    if (!page) return;

    const hiddenEls = [];
    const ancestorSaved = [];
    let current = page;
    while (current.parentElement) {
      const parent = current.parentElement;
      Array.from(parent.children).forEach((sibling) => {
        if (sibling !== current) {
          hiddenEls.push({ el: sibling, prev: sibling.style.display });
          sibling.style.display = "none";
        }
      });
      if (parent !== document.body) {
        ancestorSaved.push({
          el: parent,
          overflow: parent.style.overflow,
          transform: parent.style.transform,
          position: parent.style.position,
          visibility: parent.style.visibility,
          background: parent.style.background,
        });
        parent.style.overflow = "visible";
        parent.style.transform = "none";
        parent.style.visibility = "visible";
        parent.style.background = "none";
      }
      current = parent;
    }

    const pageSaved = {
      position: page.style.position,
      top: page.style.top,
      left: page.style.left,
      transform: page.style.transform,
      transformOrigin: page.style.transformOrigin,
      boxShadow: page.style.boxShadow,
      background: page.style.background,
    };
    const printScale = 794 / PAGE_W;
    page.style.position = "fixed";
    page.style.top = "0";
    page.style.left = "0";
    page.style.transform = `scale(${printScale})`;
    page.style.transformOrigin = "top left";
    page.style.boxShadow = "none";
    page.style.background = "white";

    const guides = page.querySelectorAll("[data-margin-guide],[data-overflow]");
    guides.forEach((g) => (g.style.display = "none"));

    const style = document.createElement("style");
    style.textContent = `
      @page { size: A4; margin: 0; }
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      body::before { display: none !important; }
    `;
    document.head.appendChild(style);

    const restore = () => {
      style.remove();
      guides.forEach((g) => (g.style.display = ""));
      Object.assign(page.style, pageSaved);
      ancestorSaved.forEach((s) => {
        s.el.style.overflow = s.overflow;
        s.el.style.transform = s.transform;
        s.el.style.position = s.position;
        s.el.style.visibility = s.visibility;
        s.el.style.background = s.background;
        s.el.style.display = s.display;
      });
      hiddenEls.forEach((h) => (h.el.style.display = h.prev));
      window.onafterprint = null;
    };

    const savedTitle = document.title;
    // Browsers use document.title as the default "Save as PDF" filename.
    document.title = buildResumeExportName({
      fullName: profile.name,
      markdown,
      company: selectedResume?.company,
      jobTitle: selectedResume?.jobTitle,
      updatedAt: selectedResume?.updatedAt,
    });

    const origRestore = restore;
    const restoreWithTitle = () => {
      origRestore();
      document.title = savedTitle;
    };
    window.onafterprint = restoreWithTitle;
    window.print();
  }, [markdown, profile.name, selectedResume]);

  const fits = measuredHeight <= maxH;
  const pct = Math.min((measuredHeight / maxH) * 100, 100);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="shrink-0 border-b border-neutral-800 bg-neutral-950 px-4 py-3 text-neutral-50">
        <div className="flex flex-wrap items-center gap-2">
          {[
            ["workHistory", "Work history"],
            ["education", "Education"],
            ["profile", "Profile"],
            ["ai", "Generate Resume"],
            ["resume", "View Resumes"],
            ["settings", "Settings"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveMainTab(key)}
              className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                activeMainTab === key
                  ? "border-neutral-600 bg-neutral-800 text-neutral-50"
                  : "border-neutral-700 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-50"
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            className="ml-auto rounded-lg border border-neutral-700 p-2 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? (
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M10 2a.75.75 0 01.75.75v1a.75.75 0 01-1.5 0v-1A.75.75 0 0110 2zM10 15a.75.75 0 01.75.75v1a.75.75 0 01-1.5 0v-1A.75.75 0 0110 15zM10 6a4 4 0 100 8 4 4 0 000-8zM15.657 5.404a.75.75 0 10-1.06-1.06l-.708.707a.75.75 0 001.06 1.06l.708-.707zM6.11 14.895a.75.75 0 10-1.06-1.06l-.708.707a.75.75 0 001.06 1.06l.708-.707zM18 10a.75.75 0 01-.75.75h-1a.75.75 0 010-1.5h1A.75.75 0 0118 10zM5 10a.75.75 0 01-.75.75h-1a.75.75 0 010-1.5h1A.75.75 0 015 10zM14.596 15.657a.75.75 0 001.06-1.06l-.707-.708a.75.75 0 00-1.06 1.06l.707.708zM5.105 6.11a.75.75 0 001.06-1.06l-.707-.708a.75.75 0 00-1.06 1.06l.707.708z"
                  clipRule="evenodd"
                />
              </svg>
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M7.455 2.004a.75.75 0 01.26.77 7 7 0 009.958 7.967.75.75 0 011.067.853A8.5 8.5 0 116.647 1.921a.75.75 0 01.808.083z" />
              </svg>
            )}
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col sm:flex-row bg-neutral-900 text-neutral-50 min-h-0 overflow-hidden">
        {/* ── Mobile tab bar ─────────────────────────── */}
        {activeMainTab === "resume" && (
          <div className="flex gap-2 px-4 py-2 sm:hidden border-b border-neutral-800 shrink-0">
            {[["editor", "Editor"], ["preview", "Preview"]].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setActiveResumeTab(key)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium uppercase tracking-widest transition-colors ${
                  activeResumeTab === key
                    ? "border-neutral-600 bg-neutral-800 text-neutral-50"
                    : "border-neutral-700 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* ── Markdown editor ─────────────────────────── */}
        <div className={`relative flex-1 min-w-0 self-stretch border-r border-neutral-800 flex-col ${activeMainTab === "resume" && activeResumeTab === "editor" ? "flex" : "hidden"} ${activeMainTab === "resume" ? "sm:flex" : "sm:hidden"}`}>
          <div className="px-4 py-3 border-b border-neutral-800">
            <p className="text-xs text-neutral-500 uppercase tracking-widest">
              Markdown
            </p>
          </div>
          <textarea
            value={markdown}
            onChange={handleMarkdownChange}
            spellCheck={false}
            className="flex-1 bg-transparent text-neutral-300 text-sm font-mono leading-relaxed p-4 resize-none outline-none ring-0 focus:outline-none focus:ring-0 border-none placeholder-neutral-600 pagefit-scrollbar"
            style={{ caretColor: "#fff" }}
          />
        </div>

        {/* ── Profile ─────────────────────────────────── */}
        <div className={`flex-1 min-w-0 self-stretch flex-col min-h-0 ${activeMainTab === "profile" ? "flex" : "hidden"}`}>
          <div className="px-4 py-3 border-b border-neutral-800">
            <p className="text-xs text-neutral-500 uppercase tracking-widest">
              Profile
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Contact details and the basic info shown on generated resumes.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 pagefit-scrollbar">
            <div className="mx-auto max-w-3xl space-y-5">
              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Contact info
                </h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {[
                    ["name", "Name", "Your name"],
                    ["headline", "Headline", "Product engineer"],
                    ["location", "Location", "City, ST"],
                    ["email", "Email", "you@example.com"],
                    ["phone", "Phone", "(555) 123-4567"],
                    ["linkedin", "LinkedIn", "linkedin.com/in/you"],
                    ["github", "GitHub", "github.com/you"],
                    ["website", "Website", "your-site.com"],
                  ].map(([field, label, placeholder]) => (
                    <label key={field} className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        {label}
                      </span>
                      <input
                        type="text"
                        value={profile[field] ?? ""}
                        onChange={(e) => updateProfileField(field, e.target.value)}
                        placeholder={placeholder}
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Show on every generated resume
                </h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {CONTACT_FIELDS.map(([field, label]) => (
                    <label key={field} className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-300">
                      <input
                        type="checkbox"
                        checked={(profile.visibleContactFields ?? []).includes(field)}
                        onChange={() => toggleVisibleContactField(field)}
                        className="rounded border-neutral-600 bg-neutral-900 text-amber-400 focus:ring-amber-400"
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
                  <p className="text-xs uppercase tracking-widest text-neutral-500">
                    Contact line preview
                  </p>
                  <p className="mt-1 text-sm text-neutral-300">
                    {getVisibleContactLine(profile) || "Select fields and add details to build a contact line."}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Work history ────────────────────────────── */}
        <div className={`flex-1 min-w-0 self-stretch flex-col min-h-0 ${activeMainTab === "workHistory" ? "flex" : "hidden"}`}>
          <div className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-neutral-500 uppercase tracking-widest">
                Work History
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                Reusable roles available to every generated resume.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <label className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-700 dark:text-amber-200 transition-colors hover:bg-amber-500/20">
                <input
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={handleImportResume}
                  disabled={isImporting}
                  className="sr-only"
                />
                {isImporting ? "Importing..." : "Import Resume"}
              </label>
              <button
                type="button"
                onClick={handleAddWorkHistory}
                className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
              >
                Add Position
              </button>
            </div>
          </div>

          {sortedWorkHistory.length > 0 && (
            <div className="px-4 py-3 border-b border-neutral-800">
              <input
                type="text"
                value={workHistorySearch}
                onChange={(e) => setWorkHistorySearch(e.target.value)}
                placeholder="Search positions or companies"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
              />
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4 space-y-4 pagefit-scrollbar">
            {importStatus && (
              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4 text-sm text-neutral-400">
                {importStatus}
              </div>
            )}
            {sortedWorkHistory.length === 0 ? (
              <div className="rounded-xl border border-dashed border-neutral-700 p-4 text-sm text-neutral-500">
                Add every role you want available for this resume.
              </div>
            ) : visibleWorkHistory.length === 0 ? (
              <div className="rounded-xl border border-dashed border-neutral-700 p-4 text-sm text-neutral-500">
                No positions match that search.
              </div>
            ) : (
              visibleWorkHistory.map((item) => (
                <div key={item.id} className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                  <div className="flex justify-end mb-3">
                    <button
                      type="button"
                      onClick={() => handleDeleteWorkHistory(item.id)}
                      className="rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </div>

                  <div className="space-y-3">
                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        Position
                      </span>
                      <input
                        type="text"
                        value={item.position}
                        onChange={(e) => handleUpdateWorkHistory(item.id, "position", e.target.value)}
                        placeholder="Marketing Manager"
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                    </label>

                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        Company
                      </span>
                      <input
                        type="text"
                        value={item.company}
                        onChange={(e) => handleUpdateWorkHistory(item.id, "company", e.target.value)}
                        placeholder="Company name"
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                    </label>

                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="block text-xs text-neutral-500 mb-1">
                          Start Month
                        </span>
                        <select
                          value={normalizeWorkMonth(item.startMonth)}
                          onChange={(e) => handleUpdateWorkHistory(item.id, "startMonth", e.target.value)}
                          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                        >
                          <option value="">No month</option>
                          {MONTH_SELECT_OPTIONS.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="block">
                        <span className="block text-xs text-neutral-500 mb-1">
                          Start Year
                        </span>
                        <input
                          type="text"
                          value={item.startYear ?? ""}
                          onChange={(e) => handleUpdateWorkHistory(item.id, "startYear", e.target.value)}
                          placeholder="2022"
                          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                        />
                      </label>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="block text-xs text-neutral-500 mb-1">
                          End Month
                        </span>
                        <select
                          value={normalizeWorkMonth(item.endMonth)}
                          onChange={(e) => handleUpdateWorkHistory(item.id, "endMonth", e.target.value)}
                          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                        >
                          <option value="">No month</option>
                          {MONTH_SELECT_OPTIONS.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="block">
                        <span className="block text-xs text-neutral-500 mb-1">
                          End Year
                        </span>
                        <input
                          type="text"
                          value={item.endYear ?? ""}
                          onChange={(e) => handleUpdateWorkHistory(item.id, "endYear", e.target.value)}
                          placeholder="2024 or present"
                          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                        />
                      </label>
                    </div>

                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        Description
                      </span>
                      <textarea
                        value={item.description}
                        onChange={(e) => handleUpdateWorkHistory(item.id, "description", e.target.value)}
                        placeholder="Describe the responsibilities, accomplishments, and results from this role."
                        rows={4}
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 resize-none pagefit-scrollbar"
                      />
                    </label>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Education ───────────────────────────────── */}
        <div className={`flex-1 min-w-0 self-stretch flex-col min-h-0 ${activeMainTab === "education" ? "flex" : "hidden"}`}>
          <div className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-neutral-500 uppercase tracking-widest">
                Education
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                Degrees and certifications available to every generated resume.
              </p>
            </div>
            <button
              type="button"
              onClick={handleAddEducation}
              className="shrink-0 rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
            >
              Add Education
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 pagefit-scrollbar">
            {sortedEducation.length === 0 ? (
              <div className="rounded-xl border border-dashed border-neutral-700 p-4 text-sm text-neutral-500">
                Add any degrees or certifications you want available for your resumes.
              </div>
            ) : (
              sortedEducation.map((item) => (
                <div key={item.id} className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                  <div className="flex justify-end mb-3">
                    <button
                      type="button"
                      onClick={() => handleDeleteEducation(item.id)}
                      className="rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </div>

                  <div className="space-y-3">
                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        School
                      </span>
                      <input
                        type="text"
                        value={item.school}
                        onChange={(e) => handleUpdateEducation(item.id, "school", e.target.value)}
                        placeholder="University of California, Berkeley"
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                    </label>

                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        Degree or Certificate
                      </span>
                      <input
                        type="text"
                        value={item.degree}
                        onChange={(e) => handleUpdateEducation(item.id, "degree", e.target.value)}
                        placeholder="B.S. in Computer Science"
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                    </label>

                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        Year
                      </span>
                      <input
                        type="text"
                        value={item.year ?? ""}
                        onChange={(e) => handleUpdateEducation(item.id, "year", e.target.value)}
                        placeholder="2020"
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                    </label>

                    <label className="block">
                      <span className="block text-xs text-neutral-500 mb-1">
                        Description
                      </span>
                      <textarea
                        value={item.description}
                        onChange={(e) => handleUpdateEducation(item.id, "description", e.target.value)}
                        placeholder="Honors, GPA, relevant coursework, or activities (optional)."
                        rows={3}
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 resize-none pagefit-scrollbar"
                      />
                    </label>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Generate resume ─────────────────────────── */}
        <div className={`flex-1 min-w-0 self-stretch flex-col min-h-0 ${activeMainTab === "ai" ? "flex" : "hidden"}`}>
          <div className="px-4 py-3 border-b border-neutral-800">
            <p className="text-xs text-neutral-500 uppercase tracking-widest">
              Generate Resume
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Generate a resume from your profile, work history, and the target role.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 pagefit-scrollbar">
            <div className="mx-auto max-w-3xl space-y-5">
              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-neutral-200">
                      Job description
                    </h2>
                    <p className="mt-1 text-xs text-neutral-500">
                      The saved resume title is extracted from this description as company, position, and generation date.
                    </p>
                  </div>
                  <div className="flex gap-1 p-0.5 bg-neutral-900 rounded-lg w-fit shrink-0 border border-neutral-800">
                    <button
                      type="button"
                      onClick={() => setGenerationSourceType("text")}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                        generationSourceType === "text"
                          ? "bg-neutral-800 text-neutral-100 border border-neutral-700/50 shadow-sm"
                          : "text-neutral-400 hover:text-neutral-200"
                      }`}
                    >
                      Paste Text
                    </button>
                    <button
                      type="button"
                      onClick={() => setGenerationSourceType("url")}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                        generationSourceType === "url"
                          ? "bg-neutral-800 text-neutral-100 border border-neutral-700/50 shadow-sm"
                          : "text-neutral-400 hover:text-neutral-200"
                      }`}
                    >
                      Scrape URL
                    </button>
                  </div>
                </div>

                {generationSourceType === "text" ? (
                  <label className="mt-4 block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      Job description
                    </span>
                    <textarea
                      value={generationInstructions}
                      onChange={(e) => handleGenerationInstructionsChange(e.target.value)}
                      onPaste={(e) => {
                        const pasted = e.clipboardData.getData("text");
                        if (!pasted) return;
                        e.preventDefault();
                        const cleaned = collapseBlankLines(pasted);
                        const target = e.target;
                        const { selectionStart, selectionEnd, value } = target;
                        const nextValue =
                          value.slice(0, selectionStart) + cleaned + value.slice(selectionEnd);
                        const nextCursor = selectionStart + cleaned.length;
                        flushSync(() => handleGenerationInstructionsChange(nextValue));
                        target.setSelectionRange(nextCursor, nextCursor);
                      }}
                      placeholder="Paste a job description or notes about the role you want to target."
                      rows={7}
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 resize-none pagefit-scrollbar"
                    />
                  </label>
                ) : (
                  <div className="mt-4 space-y-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="flex-1">
                        <label className="block">
                          <span className="block text-xs text-neutral-500 mb-1">
                            Job Page URL
                          </span>
                          <input
                            type="url"
                            value={scrapeUrl}
                            onChange={(e) => setScrapeUrl(e.target.value)}
                            placeholder="https://example.com/careers/software-engineer..."
                            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                          />
                        </label>
                      </div>
                      <div className="shrink-0">
                        <button
                          type="button"
                          onClick={handleScrapeJobPage}
                          disabled={isScraping || !scrapeUrl.trim()}
                          className="w-full sm:w-auto rounded-lg border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:text-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 h-[38px] flex items-center justify-center gap-1.5"
                        >
                          {isScraping ? (
                            <>
                              <svg className="animate-spin h-4 w-4 text-neutral-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                              <span>Scraping...</span>
                            </>
                          ) : (
                            <span>Scrape Page</span>
                          )}
                        </button>
                      </div>
                    </div>

                    {scrapeError && (
                      <p className="text-xs text-red-400 font-medium">
                        {scrapeError}
                      </p>
                    )}

                    {scrapeSuccess && (
                      <p className="text-xs text-emerald-400 font-medium">
                        {scrapeSuccess}
                      </p>
                    )}

                    {/* Firecrawl API Key Box (if not yet saved) */}
                    {!(apiKeyDrafts.firecrawl?.trim() || llmSettings.firecrawlApiKey?.trim()) && (
                      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
                        <div className="flex items-start gap-2.5">
                          <div className="text-neutral-500 shrink-0 mt-0.5">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
                            </svg>
                          </div>
                          <div className="flex-1">
                            <p className="text-xs text-neutral-400">
                              A Firecrawl API key is required to scrape job descriptions. Get one for free at <a href="https://firecrawl.dev" target="_blank" rel="noopener noreferrer" className="underline hover:text-neutral-200">firecrawl.dev</a>.
                            </p>
                            <div className="mt-2 flex gap-2">
                              <input
                                type="password"
                                value={apiKeyDrafts.firecrawl ?? ""}
                                onChange={(e) => setApiKeyDrafts((current) => ({ ...current, firecrawl: e.target.value }))}
                                placeholder="fc-..."
                                className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                              />
                              <button
                                type="button"
                                onClick={handleSaveApiKeys}
                                className="rounded-md border border-neutral-700 bg-neutral-800 px-2.5 py-1.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-neutral-50"
                              >
                                Save Key
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Find missing work experience details
                </h2>
                <p className="mt-1 text-sm text-neutral-500">
                  Compare the job description with your saved work history, then add any missing details to the roles where you actually have that experience.
                </p>
                <button
                  type="button"
                  onClick={handleFindMissingExperienceDetails}
                  disabled={isFindingMissingExperience || !generationInstructions.trim() || sortedWorkHistory.length === 0}
                  className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isFindingMissingExperience ? "Analyzing work history..." : "Find missing experience"}
                </button>
                {missingExperienceStatus && (
                  <p className="mt-3 text-sm text-neutral-400">
                    {missingExperienceStatus}
                  </p>
                )}
                {missingExperienceSaveToast && (
                  <div role="status" className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-100">
                    {missingExperienceSaveToast}
                  </div>
                )}
                {visibleMissingExperienceDetails.length > 0 && (
                  <div className="mt-4 space-y-3">
                    {visibleMissingExperienceDetails.map((detail) => (
                      <div key={detail.skill} className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
                        {(() => {
                          const hasConfirmedExperience = confirmedMissingExperienceSkills.includes(detail.skill);

                          return (
                            <>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-sm font-medium text-neutral-200">
                              {detail.question}
                            </p>
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              onClick={() => handleConfirmMissingExperienceDetail(detail.skill)}
                              disabled={hasConfirmedExperience}
                              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                                hasConfirmedExperience
                                  ? "cursor-default border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-200"
                                  : "border-neutral-700 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                              }`}
                            >
                              Yes
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDismissMissingExperienceDetail(detail.skill)}
                              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
                            >
                              No
                            </button>
                          </div>
                        </div>
                        {hasConfirmedExperience && (
                          <div className="mt-3">
                            <p className="text-xs text-neutral-500">
                              Which positions should this be added to? Select a role to add an example from it.
                            </p>
                            {(() => {
                              const positionFilter = missingExperiencePositionFilters[detail.skill] ?? "";
                              const normalizedPositionFilter = positionFilter.trim().toLowerCase();
                              const filteredWorkHistory = workHistoryByPositionCompany.filter((item) => {
                                const searchableText = [item.position, item.company].filter(Boolean).join(" ").toLowerCase();
                                return !normalizedPositionFilter || searchableText.includes(normalizedPositionFilter);
                              });
                              const selectedWorkIdSet = new Set(missingExperienceSelectedPositions[detail.skill] ?? []);
                              const detailText = detail.plainspokenDetail.replace(/^[-•]\s*/, "").trim().toLowerCase();

                              return (
                                <>
                                  <input
                                    type="text"
                                    value={positionFilter}
                                    onChange={(e) => handleMissingExperiencePositionFilterChange(detail.skill, e.target.value)}
                                    placeholder="Search positions or companies"
                                    className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                                  />
                                  <div className="mt-2 max-h-96 overflow-y-auto rounded-lg border border-neutral-800 pagefit-scrollbar">
                                    {filteredWorkHistory.length === 0 ? (
                                      <p className="px-3 py-2 text-sm text-neutral-500">
                                        No positions match that search.
                                      </p>
                                    ) : (
                                      filteredWorkHistory.map((item) => {
                                        const hasDetail = item.description
                                          .split("\n")
                                          .some((line) => line.trim().toLowerCase() === detailText);
                                        const isSelected = selectedWorkIdSet.has(item.id);
                                        const roleLabel = [item.position, item.company].filter(Boolean).join(" at ") || "Untitled role";
                                        const elaboration = missingExperienceElaborations[detail.skill]?.[item.id] ?? "";

                                        return (
                                          <div key={item.id} className="border-b border-neutral-800 last:border-b-0">
                                            <button
                                              type="button"
                                              onClick={() => handleToggleMissingExperiencePosition(detail.skill, item.id)}
                                              disabled={hasDetail}
                                              className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                                                hasDetail
                                                  ? "cursor-default bg-amber-500/10 text-amber-800 dark:text-amber-100"
                                                  : isSelected
                                                    ? "bg-amber-500/10 text-amber-800 dark:text-amber-100 hover:bg-amber-500/20"
                                                  : "bg-neutral-950 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
                                              }`}
                                            >
                                              <input
                                                type="checkbox"
                                                checked={hasDetail || isSelected}
                                                readOnly
                                                className="rounded border-neutral-600 bg-neutral-900 text-amber-400 focus:ring-amber-400"
                                              />
                                              <span>{roleLabel}</span>
                                            </button>
                                            {isSelected && !hasDetail && (
                                              <div className="border-t border-neutral-800/60 bg-neutral-950 px-3 py-3">
                                                <textarea
                                                  value={elaboration}
                                                  onChange={(e) => handleMissingExperienceElaborationChange(detail.skill, item.id, e.target.value)}
                                                  rows={3}
                                                  placeholder={detail.answerPlaceholder}
                                                  className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                                                />
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => handleOpenAddPosition(detail.skill)}
                                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-amber-700 dark:text-amber-300 transition-colors hover:bg-neutral-800"
                                    >
                                      <span className="text-base leading-none">+</span>
                                      <span>Add a position that&apos;s missing</span>
                                    </button>
                                  </div>
                                </>
                              );
                            })()}
                          </div>
                        )}
                            </>
                          );
                        })()}
                      </div>
                    ))}
                    <div className="flex items-center gap-3 pt-1">
                      <button
                        type="button"
                        onClick={handleSaveMissingExperienceDetails}
                        disabled={isSavingMissingExperience || totalSelectedMissingExperiencePositions === 0}
                        className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isSavingMissingExperience
                          ? "Saving..."
                          : totalSelectedMissingExperiencePositions > 0
                            ? `Save experience details (${totalSelectedMissingExperiencePositions})`
                            : "Save experience details"}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Generate resume
                </h2>
                <p className="mt-1 text-sm text-neutral-500">
                  {sortedWorkHistory.length === 0
                    ? "Add work history first so the generator has real experience to choose from."
                    : "Uses your profile, global work history, model settings, and the job description above."}
                </p>
                {sortedWorkHistory.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => setActiveMainTab("workHistory")}
                    className="mt-4 rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                  >
                    Add work history
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleGenerateMarkdown}
                    disabled={isGenerating}
                    className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isGenerating ? "Generating..." : "Generate resume"}
                  </button>
                )}
                {generateStatus && (
                  <p className="mt-3 text-sm text-neutral-400">
                    {generateStatus}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Settings ────────────────────────────────── */}
        <div className={`flex-1 min-w-0 self-stretch flex-col min-h-0 ${activeMainTab === "settings" ? "flex" : "hidden"}`}>
          <div className="px-4 py-3 border-b border-neutral-800">
            <p className="text-xs text-neutral-500 uppercase tracking-widest">
              Settings
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Model provider, model choice, and API key for imports and generation.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 pagefit-scrollbar">
            <div className="mx-auto max-w-3xl space-y-5">
              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Model settings
                </h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      Provider
                    </span>
                    <select
                      value={llmSettings.provider}
                      onChange={(e) => updateLlmSetting("provider", e.target.value)}
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                    >
                      {LLM_PROVIDERS.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      Model
                    </span>
                    <select
                      value={llmSettings.model}
                      onChange={(e) => updateLlmSetting("model", e.target.value)}
                      disabled={activeModelOptionsStatus === "loading"}
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500 disabled:cursor-wait disabled:opacity-60"
                    >
                      {activeModelOptions.map(([model, label]) => (
                        <option key={model} value={model}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-neutral-600">
                      {activeModelOptionsStatus === "loading"
                        ? "Loading latest models..."
                        : activeModelOptionsStatus === "ready"
                          ? "Loaded from provider."
                          : activeModelOptionsStatus === "error"
                            ? "Could not load models. Showing defaults."
                            : "Save an API key to load the latest models."}
                    </p>
                  </label>
                </div>

                <div className="mt-4 space-y-3">
                  <p className="text-xs text-neutral-500">
                    API keys
                  </p>

                  <label className="block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      Google API key
                    </span>
                    <input
                      type="password"
                      value={apiKeyDrafts.gemini}
                      onChange={(e) => setApiKeyDrafts((current) => ({ ...current, gemini: e.target.value }))}
                      placeholder="AIza..."
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      OpenAI API key
                    </span>
                    <input
                      type="password"
                      value={apiKeyDrafts.openai}
                      onChange={(e) => setApiKeyDrafts((current) => ({ ...current, openai: e.target.value }))}
                      placeholder="sk-..."
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      Anthropic API key
                    </span>
                    <input
                      type="password"
                      value={apiKeyDrafts.anthropic}
                      onChange={(e) => setApiKeyDrafts((current) => ({ ...current, anthropic: e.target.value }))}
                      placeholder="sk-ant-..."
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                    />
                  </label>

                  <label className="block">
                    <span className="block text-xs text-neutral-500 mb-1">
                      Firecrawl API key
                    </span>
                    <input
                      type="password"
                      value={apiKeyDrafts.firecrawl ?? ""}
                      onChange={(e) => setApiKeyDrafts((current) => ({ ...current, firecrawl: e.target.value }))}
                      placeholder="fc-..."
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={handleSaveApiKeys}
                    className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                  >
                    Save API keys
                  </button>
                </div>

                <p className="mt-3 text-xs text-neutral-500">
                  API keys are saved in browser storage on this device.
                </p>
              </div>

              <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Export profile
                </h2>
                <p className="mt-1 text-sm text-neutral-500">
                  Download your profile, work history, resumes as markdown, and model preferences to use on another device.
                </p>
                <p className="mt-2 text-xs text-neutral-600">
                  API keys are not included in exports.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleExportProfileData}
                    className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                  >
                    Export profile data
                  </button>
                  <label className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50">
                    <input
                      type="file"
                      accept="application/json,.json"
                      onChange={handleImportProfileData}
                      className="sr-only"
                    />
                    Import profile data
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── A4 Page ─────────────────────────────────── */}
        <div className={`flex-1 min-w-0 flex-col overflow-hidden p-4 sm:p-8 ${activeMainTab === "resume" && activeResumeTab === "preview" ? "flex" : "hidden"} ${activeMainTab === "resume" ? "sm:flex" : "sm:hidden"}`}>
          <div ref={resumeMenuRef} className="relative z-20 mx-auto mb-4 w-full max-w-[620px] shrink-0">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setIsResumeMenuOpen((open) => !open)}
                className="min-w-0 flex-1 px-3 py-2 text-sm font-medium border border-neutral-700 text-neutral-300 rounded-lg hover:bg-neutral-800 hover:text-neutral-50 transition-colors flex items-center justify-between gap-2"
              >
                <span className="truncate text-left">
                  {selectedResume?.name ?? "Select resume"}
                </span>
                <svg
                  className={`h-4 w-4 shrink-0 text-neutral-500 transition-transform ${isResumeMenuOpen ? "rotate-180" : ""}`}
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => selectedResume && handleDeleteResume(selectedResume.id)}
                className="shrink-0 rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-red-300"
                aria-label={selectedResume ? `Delete ${selectedResume.name}` : "Delete selected resume"}
              >
                Delete
              </button>
            </div>

            {isResumeMenuOpen && (
              <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 shadow-2xl shadow-black/40">
                <div className="max-h-56 overflow-y-auto p-1 pagefit-scrollbar">
                  {resumes.map((resume) => (
                    <div
                      key={resume.id}
                      className={`group flex items-center gap-1 rounded-lg ${
                        resume.id === selectedResumeId
                          ? "bg-neutral-800 text-neutral-50"
                          : "text-neutral-300 hover:bg-neutral-900 hover:text-neutral-50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectResume(resume.id)}
                        className="min-w-0 flex-1 px-3 py-2 text-left text-sm"
                      >
                        <span className="block truncate">
                          {resume.name}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>

                <div className="border-t border-neutral-800 p-3">
                  <button
                    type="button"
                    onClick={handleOpenCreateResume}
                    className="w-full rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                  >
                    Create new resume
                  </button>
                </div>
              </div>
            )}
          </div>

          <div ref={previewRef} className="flex-1 min-h-0 min-w-0 flex items-center justify-center overflow-hidden">
            <div
              ref={pageRef}
              data-pagefit-page
              className="relative bg-white shadow-2xl shadow-black/50 shrink-0"
              style={{
                width: PAGE_W,
                height: PAGE_H,
                overflow: "hidden",
                transform: `scale(${pageScale})`,
                transformOrigin: "center center",
              }}
            >
              {positioned.map((item, i) => {
                if (item.type === "hr") {
                  return (
                    <div
                      key={i}
                      style={{
                        position: "absolute",
                        left: padding,
                        right: padding,
                        top: item.y,
                        height: 1,
                        backgroundColor: "#ddd",
                      }}
                    />
                  );
                }
                return (
                  <div
                    key={i}
                    style={{
                      position: "absolute",
                      left: item.x,
                      top: item.y,
                      fontSize: item.fontSize,
                      fontWeight: item.fontWeight,
                      fontFamily: FONT,
                      lineHeight: `${item.lineHeight}px`,
                      color: item.color,
                      whiteSpace: "pre",
                    }}
                  >
                    {item.text}
                  </div>
                );
              })}

              <div
                data-margin-guide
                className="absolute pointer-events-none"
                style={{
                  top: padding,
                  left: padding,
                  right: padding,
                  bottom: padding,
                  border: "1px dashed rgba(0,0,0,0.12)",
                }}
              />

              {!fits && (
                <div
                  data-overflow
                  className="absolute bottom-0 left-0 right-0 pointer-events-none"
                  style={{
                    height: 48,
                    background: "linear-gradient(transparent, rgba(248,113,113,0.18))",
                    borderBottom: "2px solid rgb(248,113,113)",
                  }}
                />
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={handleExportPdf}
            className="mx-auto mt-4 w-full max-w-[620px] shrink-0 px-3 py-2 text-sm font-medium bg-neutral-50 text-neutral-900 rounded-lg hover:bg-neutral-200 transition-colors"
          >
            Export as PDF
          </button>

        </div>

        {/* ── Collapsible fit sidebar ─────────────────── */}
        {activeMainTab === "resume" && isFitSidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/40 sm:hidden"
            onClick={() => setIsFitSidebarOpen(false)}
            aria-hidden="true"
          />
        )}
        <div
          className={`shrink-0 self-stretch overflow-hidden border-l border-neutral-800 bg-neutral-950 transition-[width] duration-200 ease-out ${
            activeMainTab !== "resume"
              ? "hidden"
              : isFitSidebarOpen
                ? "fixed inset-y-0 right-0 z-50 w-72 sm:static sm:z-auto"
                : "w-10"
          }`}
        >
          {isFitSidebarOpen ? (
          <div className="flex h-full w-72 flex-col gap-4 overflow-y-auto px-5 py-4 pagefit-scrollbar">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-neutral-500">
                Page fit
              </p>
              <button
                type="button"
                onClick={() => setIsFitSidebarOpen(false)}
                className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                aria-label="Close page fit settings"
              >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                </svg>
              </button>
            </div>

          {/* Auto-fit toggle */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-neutral-500 uppercase tracking-widest">
              Auto-fit
            </p>
            <button
              onClick={() => setAutoFit(!autoFit)}
              className={`w-10 h-5 rounded-full transition-colors relative ${
                autoFit ? "bg-emerald-500" : "bg-neutral-700"
              }`}
            >
              <div
                className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                style={{ left: 2, transform: autoFit ? "translateX(20px)" : "translateX(0)" }}
              />
            </button>
          </div>

          {/* Max Font Size */}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-widest mb-1.5">
              Max Font Size
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={8}
                max={24}
                step={0.5}
                value={maxFontSize}
                onChange={(e) => setMaxFontSize(parseFloat(e.target.value))}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-16 text-right">
                {maxFontSize}px
              </span>
            </div>
          </div>

          {/* Font scale */}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-widest mb-1.5">
              Font Scale
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={6}
                max={24}
                step={0.01}
                value={fontSize}
                onChange={handleSlider}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-16 text-right">
                {((fontSize / 16) * 100).toFixed(1)}%
              </span>
            </div>
          </div>

          {/* Line Spacing */}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-widest mb-1.5">
              Line Spacing
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={LH_MIN}
                max={LH_MAX}
                step={0.001}
                value={lineHeightMult}
                onChange={handleLineHeightSlider}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-14 text-right">
                {lineHeightMult.toFixed(2)}x
              </span>
            </div>
          </div>

          {/* Margin */}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-widest mb-1.5">
              Page Margin
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={16}
                max={80}
                step={1}
                value={padding}
                onChange={(e) => setPadding(parseInt(e.target.value))}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-14 text-right">
                {padding}px
              </span>
            </div>
          </div>

          {/* Section Spacing */}
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <p className="text-xs text-neutral-500 uppercase tracking-widest">
                Section Spacing
              </p>
              <span className="relative group/tip">
                <span className="w-3.5 h-3.5 rounded-full border border-neutral-600 text-neutral-500 text-[9px] font-medium flex items-center justify-center cursor-default">i</span>
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 text-xs text-neutral-300 bg-neutral-800 border border-neutral-700 rounded-md w-48 opacity-0 pointer-events-none group-hover/tip:opacity-100 transition-opacity">Gap before section headers like Experience, Education, and Skills.</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={48}
                step={1}
                value={sectionSpacing}
                onChange={(e) => setSectionSpacing(parseInt(e.target.value))}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-14 text-right">
                {sectionSpacing}px
              </span>
            </div>
          </div>

          {/* Item Spacing */}
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <p className="text-xs text-neutral-500 uppercase tracking-widest">
                Item Spacing
              </p>
              <span className="relative group/tip">
                <span className="w-3.5 h-3.5 rounded-full border border-neutral-600 text-neutral-500 text-[9px] font-medium flex items-center justify-center cursor-default">i</span>
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 text-xs text-neutral-300 bg-neutral-800 border border-neutral-700 rounded-md w-48 opacity-0 pointer-events-none group-hover/tip:opacity-100 transition-opacity">Gap between entries within a section, like between different jobs or degrees.</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={30}
                step={1}
                value={itemSpacing}
                onChange={(e) => setItemSpacing(parseFloat(e.target.value))}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-14 text-right">
                {itemSpacing}px
              </span>
            </div>
          </div>

          {/* Separator Spacing */}
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <p className="text-xs text-neutral-500 uppercase tracking-widest">
                Separator Spacing
              </p>
              <span className="relative group/tip">
                <span className="w-3.5 h-3.5 rounded-full border border-neutral-600 text-neutral-500 text-[9px] font-medium flex items-center justify-center cursor-default">i</span>
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 text-xs text-neutral-300 bg-neutral-800 border border-neutral-700 rounded-md w-48 opacity-0 pointer-events-none group-hover/tip:opacity-100 transition-opacity">Padding above and below the horizontal rule divider.</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={30}
                step={1}
                value={separatorSpacing}
                onChange={(e) => setSeparatorSpacing(parseInt(e.target.value))}
                className="flex-1 h-1 accent-neutral-50"
              />
              <span className="text-sm font-mono tabular-nums w-14 text-right">
                {separatorSpacing}px
              </span>
            </div>
          </div>

          {/* Page fit */}
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-widest mb-1.5">
              Page Fit
            </p>
            <div className="h-1.5 bg-neutral-800 rounded-full overflow-hidden mb-2">
              <div
                className="h-full rounded-full transition-all duration-100"
                style={{
                  width: `${pct}%`,
                  backgroundColor: fits ? "rgb(52, 211, 153)" : "rgb(248, 113, 113)",
                }}
              />
            </div>
            <div className="flex items-baseline justify-between text-xs">
              <span className={`font-medium ${fits ? "text-emerald-400" : "text-red-400"}`}>
                {fits ? "Fits on 1 page" : `Overflow +${measuredHeight - maxH}px`}
              </span>
              <span className="text-neutral-600 font-mono tabular-nums">
                {measuredHeight}/{maxH}px · {measureTime}ms
              </span>
            </div>
          </div>
          </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsFitSidebarOpen(true)}
              className="flex h-full w-10 flex-col items-center justify-start pt-4 text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-300"
              aria-label="Open page fit settings"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M3 4.5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3 5.5a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm2 5.5a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
              </svg>
            </button>
          )}
        </div>
      </main>

      {(apiKeySaveToast || workHistorySaveToast || profileDataToast) && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-emerald-500/30 bg-neutral-900 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-200 shadow-lg"
        >
          {apiKeySaveToast || workHistorySaveToast || profileDataToast}
        </div>
      )}

      {isCreateResumeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <form
            onSubmit={handleCreateResume}
            className="w-full max-w-sm rounded-2xl border border-neutral-700 bg-neutral-950 p-5 shadow-2xl shadow-black/50"
          >
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-neutral-50">
                Create new resume
              </h2>
              <p className="mt-1 text-sm text-neutral-500">
                Name the resume from the company and role you are applying for.
              </p>
            </div>

            <label htmlFor="resume-company" className="block text-xs text-neutral-500 uppercase tracking-widest mb-2">
              Company
            </label>
            <input
              id="resume-company"
              type="text"
              value={resumeCompanyDraft}
              onChange={(e) => setResumeCompanyDraft(e.target.value)}
              placeholder="Acme Co"
              autoFocus
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
            />

            <label htmlFor="resume-job-title" className="mt-4 block text-xs text-neutral-500 uppercase tracking-widest mb-2">
              Job title
            </label>
            <input
              id="resume-job-title"
              type="text"
              value={resumeJobTitleDraft}
              onChange={(e) => setResumeJobTitleDraft(e.target.value)}
              placeholder="Operations Manager"
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
            />

            {(resumeCompanyDraft.trim() || resumeJobTitleDraft.trim()) && (
              <p className="mt-3 text-xs text-neutral-500">
                Resume title: {titleResume(resumeCompanyDraft, resumeJobTitleDraft)}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsCreateResumeOpen(false)}
                className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-neutral-200 px-3 py-2 text-sm font-medium text-neutral-950 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!resumeCompanyDraft.trim() && !resumeJobTitleDraft.trim()}
              >
                Create resume
              </button>
            </div>
          </form>
        </div>
      )}

      {addPositionForSkill !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <form
            onSubmit={handleAddMissingPosition}
            className="w-full max-w-md rounded-2xl border border-neutral-700 bg-neutral-950 p-5 shadow-2xl shadow-black/50"
          >
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-neutral-50">
                Add a missing position
              </h2>
              <p className="mt-1 text-sm text-neutral-500">
                Add the role now, then pop back to fill in the detail that reminded you of it.
              </p>
            </div>

            <label className="block">
              <span className="block text-xs text-neutral-500 mb-1">Position</span>
              <input
                type="text"
                value={newPositionDraft.position}
                onChange={(e) => handleNewPositionDraftChange("position", e.target.value)}
                placeholder="Marketing Manager"
                autoFocus
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
              />
            </label>

            <label className="mt-4 block">
              <span className="block text-xs text-neutral-500 mb-1">Company</span>
              <input
                type="text"
                value={newPositionDraft.company}
                onChange={(e) => handleNewPositionDraftChange("company", e.target.value)}
                placeholder="Company name"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
              />
            </label>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs text-neutral-500 mb-1">Start Month</span>
                <select
                  value={normalizeWorkMonth(newPositionDraft.startMonth)}
                  onChange={(e) => handleNewPositionDraftChange("startMonth", e.target.value)}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                >
                  <option value="">No month</option>
                  {MONTH_SELECT_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs text-neutral-500 mb-1">Start Year</span>
                <input
                  type="text"
                  value={newPositionDraft.startYear}
                  onChange={(e) => handleNewPositionDraftChange("startYear", e.target.value)}
                  placeholder="2022"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                />
              </label>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs text-neutral-500 mb-1">End Month</span>
                <select
                  value={normalizeWorkMonth(newPositionDraft.endMonth)}
                  onChange={(e) => handleNewPositionDraftChange("endMonth", e.target.value)}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                >
                  <option value="">No month</option>
                  {MONTH_SELECT_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs text-neutral-500 mb-1">End Year</span>
                <input
                  type="text"
                  value={newPositionDraft.endYear}
                  onChange={(e) => handleNewPositionDraftChange("endYear", e.target.value)}
                  placeholder="2024 or present"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                />
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleCloseAddPosition}
                className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newPositionDraft.position.trim() && !newPositionDraft.company.trim()}
                className="rounded-lg bg-neutral-200 px-3 py-2 text-sm font-medium text-neutral-950 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add position
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
