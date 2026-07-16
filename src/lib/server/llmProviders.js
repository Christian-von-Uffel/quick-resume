// Server-only provider layer. API keys live exclusively in environment
// variables (.env.local in development, project env vars in production) and
// every provider call happens here, behind the /api routes — the browser never
// sees a key. Do not import this module from client components.
import {
  OPENAI_MODEL_OPTIONS,
  FALLBACK_MODEL_OPTIONS,
  MISTRAL_OCR_MODEL,
} from "../constants";

/* ── Env keys ──────────────────────────────────────────────── */
const PROVIDER_ENV_VARS = {
  Gemini: "GEMINI_API_KEY",
  OpenAI: "OPENAI_API_KEY",
  Anthropic: "ANTHROPIC_API_KEY",
  Mistral: "MISTRAL_API_KEY",
  Firecrawl: "FIRECRAWL_API_KEY",
  xAI: "XAI_API_KEY",
};

// Errors that should reach the browser carry the HTTP status the /api route
// should respond with; anything without one is treated as a 502 upstream
// failure by the routes.
export class LlmHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// API keys are sent as HTTP header values, which must be Latin-1. Env values
// sometimes pick up stray whitespace or invisible characters (trailing
// newlines, non-breaking spaces from a paste) that make fetch throw before the
// request is sent. Provider keys are always printable ASCII, so strip anything else.
export function sanitizeApiKey(key) {
  return (key ?? "").replace(/[^\x20-\x7E]/g, "").trim();
}

function getServerApiKey(providerLabel) {
  const envVar = PROVIDER_ENV_VARS[providerLabel];
  return envVar ? sanitizeApiKey(process.env[envVar]) : "";
}

export function hasServerApiKey(providerLabel) {
  return Boolean(getServerApiKey(providerLabel));
}

export function requireServerApiKey(providerLabel) {
  const key = getServerApiKey(providerLabel);
  if (!key) {
    throw new LlmHttpError(
      `${PROVIDER_ENV_VARS[providerLabel]} isn't set on the server. Add it to .env.local (see .env.example) and restart the server.`,
      503
    );
  }
  return key;
}

// Preference order when picking a default chat provider: use the first one
// whose server env key is set so a missing Gemini key doesn't fail generation
// when another provider is configured.
const LLM_PROVIDER_PRIORITY = [
  ["xai", "xAI"],
  ["anthropic", "Anthropic"],
  ["openai", "OpenAI"],
  ["gemini", "Gemini"],
];

export function getPreferredLlmProvider() {
  for (const [id, label] of LLM_PROVIDER_PRIORITY) {
    if (hasServerApiKey(label)) return id;
  }
  return LLM_PROVIDER_PRIORITY[LLM_PROVIDER_PRIORITY.length - 1][0];
}

export function getConfiguredLlmProviders() {
  return Object.fromEntries(
    LLM_PROVIDER_PRIORITY.map(([id, label]) => [id, hasServerApiKey(label)])
  );
}

/* ── Error classification ──────────────────────────────────── */
// Ceiling for a single model call. Non-streaming generations on large models can
// legitimately run past a minute, but without a cap a stalled endpoint leaves the
// UI on "Generating..." forever with no way to tell what went wrong.
const REQUEST_TIMEOUT_MS = 170_000;

// Providers don't agree on status codes for the failures that actually need to
// be distinguished (Gemini returns bad keys as 400, Anthropic reports empty
// credit balances as 400, OpenAI reports exhausted quotas as 429), so
// classification has to look at the message text as well as the status.
const AUTH_ERROR_PATTERN =
  /api[ _-]?key (?:not valid|invalid)|invalid (?:x-)?api[ _-]?key|incorrect api key|api_key_invalid|unauthorized|authentication|permission[ _]?error/i;
const BILLING_ERROR_PATTERN =
  /credit balance|billing|exceeded your current quota|insufficient_quota|out of credits|payment method|purchase/i;
const MISSING_MODEL_PATTERN = /model/i;
const NOT_FOUND_PATTERN = /not found|does not exist|not supported/i;

// Turn a provider HTTP failure into a message that says what to DO. Key and
// billing problems belong to whoever operates the server (the keys are ours,
// not the user's), so those name the env var to fix; model and availability
// problems are still actionable from the UI.
export function describeLlmApiError(provider, status, apiMessage) {
  const detail = apiMessage ? ` ${provider} said: "${apiMessage}"` : "";
  const envVar = PROVIDER_ENV_VARS[provider] ?? "the API key";

  if (status === 401 || status === 403 || AUTH_ERROR_PATTERN.test(apiMessage)) {
    return `${provider} rejected the server's API key (HTTP ${status}). Check the ${envVar} value in the server environment — it may be mistyped, expired, or revoked.${detail}`;
  }
  if (status === 402 || BILLING_ERROR_PATTERN.test(apiMessage)) {
    return `${provider} refused the request for billing reasons (HTTP ${status}). The server's ${provider} account may be out of credits.${detail}`;
  }
  if (status === 429) {
    return `${provider} is rate-limiting requests (HTTP 429). Wait a moment and try again.${detail}`;
  }
  if (status === 404 || (MISSING_MODEL_PATTERN.test(apiMessage) && NOT_FOUND_PATTERN.test(apiMessage))) {
    return `${provider} can't find the selected model (HTTP ${status}). It may be renamed or unavailable — pick a different model in Settings.${detail}`;
  }
  if (status >= 500) {
    return `${provider} is down or overloaded (HTTP ${status}). This is on their side — try again in a minute.${detail}`;
  }
  return `${provider} rejected the request (HTTP ${status}).${detail}`;
}

function statusForUpstreamFailure(status) {
  // Pass rate limits through so the browser can tell "slow down" from "broken".
  // Everything else — auth, billing, provider outages — is the operator's
  // problem, not the caller's, so it surfaces as a 502 upstream failure.
  return status === 429 ? 429 : 502;
}

/* ── Provider request layer ────────────────────────────────── */
// Optional sampling params that some models reject: OpenAI's reasoning models
// don't accept `temperature`, and Anthropic removed `temperature`/`top_p`/`top_k`
// on its newer models (Opus 4.8, Fable 5, ...) — sending them there returns a 400.
const DROPPABLE_MODEL_PARAMS = ["temperature", "top_p", "top_k"];

// Params each provider/model pair has already rejected in this server process.
// The drop-and-retry probe below discovers them, but without a memo every call
// to a given model would re-pay a rejected round trip; with it, only the first
// call to a model pays the probe.
const sessionRejectedParams = new Map();

export function rememberSessionRejectedParam(memoKey, param) {
  if (!memoKey) return;
  if (!sessionRejectedParams.has(memoKey)) sessionRejectedParams.set(memoKey, new Set());
  sessionRejectedParams.get(memoKey).add(param);
}

export function omitSessionRejectedParams(memoKey, body) {
  const rejected = memoKey ? sessionRejectedParams.get(memoKey) : null;
  if (!rejected?.size) return body;

  const next = { ...body };
  for (const param of rejected) delete next[param];
  return next;
}

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
async function postModelJson(url, headers, body, provider, memoKey) {
  let attempt = omitSessionRejectedParams(memoKey, { ...body });

  // Guard against infinite loops; there are only a handful of optional params.
  for (let i = 0; i < 4; i += 1) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(attempt),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new LlmHttpError(
          `${provider} didn't respond within ${REQUEST_TIMEOUT_MS / 1000} seconds. The service may be overloaded — try again in a minute.`,
          504
        );
      }
      throw new LlmHttpError(
        `The server couldn't reach ${provider}. The service may be down — try again in a minute.`,
        502
      );
    }

    // Error bodies aren't guaranteed to be JSON (gateways can return HTML or an
    // empty body), so parse defensively rather than masking the HTTP status
    // behind a SyntaxError.
    const data = await response.json().catch(() => null);
    if (response.ok) {
      if (data === null) {
        throw new LlmHttpError(`${provider} returned a response that couldn't be read. Try again.`, 502);
      }
      return data;
    }

    // Gemini/OpenAI/Anthropic nest the message under `error`; Mistral puts it
    // at the top level; Firecrawl's `error` is a plain string.
    const message =
      data?.error?.message ??
      (typeof data?.error === "string" ? data.error : null) ??
      data?.message ??
      "";
    const unsupportedParam = getUnsupportedParam(message, attempt);

    if (unsupportedParam) {
      rememberSessionRejectedParam(memoKey, unsupportedParam);
      const { [unsupportedParam]: _removed, ...rest } = attempt;
      attempt = rest;
      continue;
    }

    throw new LlmHttpError(
      describeLlmApiError(provider, response.status, message),
      statusForUpstreamFailure(response.status)
    );
  }

  throw new LlmHttpError(`${provider} request failed.`, 502);
}

/* ── Model discovery ───────────────────────────────────────── */
function normalizeModelId(id) {
  return String(id ?? "").trim().replace(/^models\//, "");
}

function createModelOption(id) {
  const modelId = normalizeModelId(id);
  return [modelId, modelId];
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

function isXaiTextModel(model) {
  const id = model.id ?? "";
  if (!/^grok/i.test(id)) return false;
  // Imagine / voice / video endpoints aren't usable as chat generation models.
  if (/imagine|voice|video|tts|stt/i.test(id)) return false;
  return true;
}

async function fetchAllGeminiModels(apiKey) {
  const models = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({ pageSize: "1000" });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?${params}`, {
      headers: { "x-goog-api-key": apiKey },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new LlmHttpError(
        describeLlmApiError("Gemini", response.status, data?.error?.message ?? ""),
        502
      );
    }

    models.push(...(data?.models ?? []));
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
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new LlmHttpError(
        describeLlmApiError("Anthropic", response.status, data?.error?.message ?? ""),
        502
      );
    }

    models.push(...(data?.data ?? []));
    if (!data.has_more || !data.last_id) break;
    afterId = data.last_id;
  }

  return models;
}

// xAI's catalog is OpenAI-shaped (GET /v1/models → { data: [...] }).
async function fetchAllXaiModels(apiKey) {
  const response = await fetch("https://api.x.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new LlmHttpError(
      describeLlmApiError("xAI", response.status, data?.error?.message ?? ""),
      502
    );
  }
  return data?.data ?? [];
}

async function fetchLiveModelOptions(provider) {
  if (provider === "openai") return OPENAI_MODEL_OPTIONS;

  if (provider === "xai") {
    const models = await fetchAllXaiModels(requireServerApiKey("xAI"));
    return dedupeModelOptions(
      models.filter(isXaiTextModel).map((model) => createModelOption(model.id))
    );
  }

  if (provider === "anthropic") {
    const models = await fetchAllAnthropicModels(requireServerApiKey("Anthropic"));
    return dedupeModelOptions(models.filter(isAnthropicTextModel).map((model) => createModelOption(model.id)));
  }

  const models = await fetchAllGeminiModels(requireServerApiKey("Gemini"));
  return dedupeModelOptions(
    models
      .filter(isGeminiTextModel)
      .map((model) => createModelOption((model.name ?? "").replace(/^models\//, "")))
      .sort((a, b) => a[0].localeCompare(b[0]))
  );
}

// Model catalogs change on the order of weeks; without a memo every page load
// costs one upstream listing call per provider.
const MODEL_OPTIONS_TTL_MS = 10 * 60_000;
const modelOptionsCache = new Map();

export async function getModelOptionsForProvider(provider) {
  const cached = modelOptionsCache.get(provider);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const options = await fetchLiveModelOptions(provider);
    const value = { options, source: "live" };
    if (options.length) modelOptionsCache.set(provider, { value, expiresAt: Date.now() + MODEL_OPTIONS_TTL_MS });
    return value;
  } catch {
    // A missing key or an upstream hiccup shouldn't break the Settings screen;
    // the bundled defaults keep the model picker usable.
    return { options: FALLBACK_MODEL_OPTIONS[provider] ?? [], source: "fallback" };
  }
}

/* ── Generation ────────────────────────────────────────────── */
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
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { "x-goog-api-key": apiKey },
    {
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.2 },
    },
    "Gemini",
    `gemini:${model}`
  );

  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n").trim() ?? "";
}

// OpenAI and xAI both speak the Responses API. Same request/response shape;
// only the host and which env key we pull differ.
async function callResponsesApi({ apiKey, model, prompt, file, baseUrl, provider, memoKey }) {
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
    `${baseUrl}/responses`,
    { Authorization: `Bearer ${apiKey}` },
    {
      model,
      input: [{ role: "user", content }],
      // Reasoning-class models reject this with a 400; the probe-and-memo in
      // postModelJson drops it for them after the first call.
      temperature: 0.2,
    },
    provider,
    memoKey
  );

  if (data.output_text) return data.output_text.trim();

  return data.output
    ?.flatMap((item) => item.content ?? [])
    ?.map((item) => item.text ?? "")
    ?.join("\n")
    ?.trim() ?? "";
}

async function callOpenAI({ apiKey, model, prompt, file }) {
  return callResponsesApi({
    apiKey,
    model,
    prompt,
    file,
    baseUrl: "https://api.openai.com/v1",
    provider: "OpenAI",
    memoKey: `openai:${model}`,
  });
}

async function callXai({ apiKey, model, prompt, file }) {
  return callResponsesApi({
    apiKey,
    model,
    prompt,
    file,
    // OpenAI-compatible host per https://docs.x.ai/developers/quickstart
    baseUrl: "https://api.x.ai/v1",
    provider: "xAI",
    memoKey: `xai:${model}`,
  });
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
    "Anthropic",
    `anthropic:${model}`
  );

  return data.content?.map((block) => block.text ?? "").join("\n").trim() ?? "";
}

export async function callProvider({ provider, model, prompt, file }) {
  if (provider === "openai") {
    return callOpenAI({ apiKey: requireServerApiKey("OpenAI"), model, prompt, file });
  }
  if (provider === "xai") {
    return callXai({ apiKey: requireServerApiKey("xAI"), model, prompt, file });
  }
  if (provider === "anthropic") {
    return callAnthropic({ apiKey: requireServerApiKey("Anthropic"), model, prompt, file });
  }
  return callGemini({ apiKey: requireServerApiKey("Gemini"), model, prompt, file });
}

/* ── Mistral OCR (document → markdown) ─────────────────────── */
// Converts formats the chat providers can't ingest natively (Word, PowerPoint,
// OpenDocument) into markdown text. This doesn't replace the selected chat
// provider — whichever model the user picked still does the JSON extraction;
// OCR only supplies it readable text.
export async function runMistralOcr(file) {
  const apiKey = requireServerApiKey("Mistral");

  const dataUrl = `data:${file.mimeType};base64,${file.base64}`;
  const data = await postModelJson(
    "https://api.mistral.ai/v1/ocr",
    { Authorization: `Bearer ${apiKey}` },
    {
      model: MISTRAL_OCR_MODEL,
      document: file.mimeType.startsWith("image/")
        ? { type: "image_url", image_url: dataUrl }
        : { type: "document_url", document_url: dataUrl },
    },
    "Mistral",
    null
  );

  const text = (data.pages ?? [])
    .map((page) => page.markdown ?? "")
    .join("\n\n")
    .trim();

  if (!text) {
    throw new LlmHttpError(`Mistral OCR found no text in ${file.name}. Check the file and try again.`, 422);
  }

  return text;
}

/* ── Firecrawl (job page → markdown) ───────────────────────── */
export async function scrapePageMarkdown(url) {
  const apiKey = requireServerApiKey("Firecrawl");

  const data = await postModelJson(
    "https://api.firecrawl.dev/v1/scrape",
    { Authorization: `Bearer ${apiKey}` },
    { url, formats: ["markdown"] },
    "Firecrawl",
    null
  );

  if (!data.success) {
    throw new LlmHttpError(String(data.error || "Scrape was unsuccessful."), 502);
  }

  const markdown = data.data?.markdown;
  if (!markdown) {
    throw new LlmHttpError("No markdown content was returned from the page.", 502);
  }

  return {
    markdown,
    title: data.data?.metadata?.title || "",
    description: data.data?.metadata?.description || "",
  };
}
