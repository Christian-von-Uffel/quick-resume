/* ── Billing ───────────────────────────────────────────────── */
export const STRIPE_PAYMENT_LINK =
  "https://buy.stripe.com/4gMbJ1geYbMo6g54do0sU02";
export const MONTHLY_PRICE = 20;

/* ── Page constants ────────────────────────────────────────── */
export const PAGE_W = 620;
export const PAGE_H = Math.round(PAGE_W * (297 / 210));
export const DEFAULT_PAD = 40;
export const FONT = "InterVariable, sans-serif";
export const LH_MIN = 1.15;
export const LH_MAX = 1.8;
export const LH_DEFAULT = 1.5;
export const FS_MAX_DEFAULT = 14;
export const PROFILE_EXPORT_VERSION = 1;
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_XAI_MODEL = "grok-4.5";
export const MISTRAL_OCR_MODEL = "mistral-ocr-latest";

export const LLM_PROVIDERS = [
  ["xai", "xAI"],
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["gemini", "Google"],
];

export const OPENAI_MODEL_OPTIONS = [
  ["gpt-5.5", "gpt-5.5"],
  ["gpt-5.4", "gpt-5.4"],
  ["gpt-5.4-mini", "gpt-5.4-mini"],
  ["gpt-5.4-nano", "gpt-5.4-nano"],
];

export const XAI_MODEL_OPTIONS = [
  ["grok-4.5", "grok-4.5"],
  ["grok-4.3", "grok-4.3"],
];

export const FALLBACK_MODEL_OPTIONS = {
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
  xai: XAI_MODEL_OPTIONS,
};

export const CONTACT_FIELDS = [
  ["location", "Location"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["linkedin", "LinkedIn"],
  ["github", "GitHub"],
  ["website", "Website"],
];

export const DEFAULT_VISIBLE_CONTACT_FIELDS = ["location", "email", "linkedin", "github", "website"];

export const DEFAULT_PROFILE = {
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
  // Pair-signature keys of work-history date conflicts the person confirmed as
  // intentional (dual-held jobs, separate stints) so they aren't re-flagged.
  conflictAcks: [],
};

export const DEFAULT_LLM_SETTINGS = {
  // Bundled startup default before the server reports which keys are set.
  // App load then switches to the first configured provider (xAI → Anthropic →
  // OpenAI → Google).
  provider: "gemini",
  model: DEFAULT_GEMINI_MODEL,
};

// Exact phrase the delete-account dialog requires before it will act.
export const DELETE_ACCOUNT_CONFIRM_PHRASE = "DELETE";

// Exact phrase the delete-position dialog requires before it will act.
export const DELETE_POSITION_CONFIRM_PHRASE = "DELETE";

export const MONTH_OPTIONS = [
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

export const MONTH_SELECT_OPTIONS = MONTH_OPTIONS.map((label, index) => [
  String(index + 1).padStart(2, "0"),
  label,
]);

export const EMPTY_POSITION_DRAFT = {
  position: "",
  company: "",
  startMonth: "",
  startYear: "",
  endMonth: "",
  endYear: "",
};

export const MONTH_NAME_TO_NUM = MONTH_OPTIONS.reduce((acc, month, index) => {
  const num = String(index + 1).padStart(2, "0");
  acc[month.toLowerCase()] = num;
  acc[month.slice(0, 3).toLowerCase()] = num;
  return acc;
}, {});

for (let month = 1; month <= 12; month += 1) {
  MONTH_NAME_TO_NUM[String(month)] = String(month).padStart(2, "0");
  MONTH_NAME_TO_NUM[String(month).padStart(2, "0")] = String(month).padStart(2, "0");
}
