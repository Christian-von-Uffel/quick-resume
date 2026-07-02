import {
  OPENAI_MODEL_OPTIONS,
  FALLBACK_MODEL_OPTIONS,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_LLM_SETTINGS,
  LLM_PROVIDERS,
} from "./constants";

/* ── Model discovery ───────────────────────────────────────── */
function normalizeModelId(id) {
  return String(id ?? "").trim().replace(/^models\//, "");
}

function createModelOption(id) {
  const modelId = normalizeModelId(id);
  return [modelId, modelId];
}

export function getDefaultModelForProvider(provider, modelOptionsByProvider = FALLBACK_MODEL_OPTIONS) {
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

export async function fetchProviderModelOptions(provider, apiKey) {
  const key = sanitizeApiKey(apiKey);
  if (provider === "openai") return fetchOpenAIModelOptions(key);
  if (provider === "anthropic") return fetchAnthropicModelOptions(key);
  return fetchGeminiModelOptions(key);
}

/* ── API keys & settings ───────────────────────────────────── */
// API keys are sent as HTTP header values, which must be Latin-1. Pasted keys
// sometimes carry invisible or non-ASCII characters (smart quotes, zero-width
// spaces, non-breaking spaces) that survive .trim() and make fetch throw
// "String contains non ISO-8859-1 code point" before the request is sent.
// Provider keys are always printable ASCII, so strip anything else.
export function sanitizeApiKey(key) {
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

export function applyApiKeyDrafts(settings, drafts) {
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

export function normalizeLlmSettings(value) {
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

/* ── Response parsing ──────────────────────────────────────── */
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

/* ── Provider request layer ────────────────────────────────── */
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

export async function callLlm(settings, prompt, file) {
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
export async function callLlmForJson(settings, prompt, file) {
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
