import {
  FALLBACK_MODEL_OPTIONS,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_XAI_MODEL,
  DEFAULT_LLM_SETTINGS,
} from "./constants";

// Browser-side client for the app's /api routes. Provider API keys live only
// in the server environment (src/lib/server/llmProviders.js); nothing in this
// module — or anywhere else shipped to the browser — ever sees one.

/* ── Settings ──────────────────────────────────────────────── */
export function getDefaultModelForProvider(provider, modelOptionsByProvider = FALLBACK_MODEL_OPTIONS) {
  const options = modelOptionsByProvider[provider] ?? FALLBACK_MODEL_OPTIONS[provider] ?? [];
  const preferred =
    provider === "openai"
      ? DEFAULT_OPENAI_MODEL
      : provider === "anthropic"
        ? DEFAULT_ANTHROPIC_MODEL
        : provider === "xai"
          ? DEFAULT_XAI_MODEL
          : DEFAULT_GEMINI_MODEL;

  // Prefer the named default when the catalog includes it. Live listings are
  // unordered (xAI returns grok-4.20… before grok-4.5), so "first option" is
  // not a stable product default.
  if (options.some(([id]) => id === preferred)) return preferred;
  if (options[0]?.[0]) return options[0][0];
  return preferred;
}

function normalizeLlmProvider(value) {
  if (value === "openai" || value === "anthropic" || value === "xai") return value;
  return "gemini";
}

// Reduces stored/imported settings to the two fields that still exist. Earlier
// versions kept API keys in here (and in localStorage); rebuilding from scratch
// instead of spreading the raw object is what scrubs those legacy keys out of
// persisted state on the next save.
export function normalizeLlmSettings(value) {
  const raw = value && typeof value === "object" ? value : {};
  const provider = normalizeLlmProvider(raw.provider);
  const fallbackModel = getDefaultModelForProvider(provider);
  const modelOptions = (FALLBACK_MODEL_OPTIONS[provider] ?? []).map(([model]) => model);
  const model = modelOptions.includes(raw.model) ? raw.model : fallbackModel;

  return { ...DEFAULT_LLM_SETTINGS, provider, model };
}

/* ── API-route request layer ───────────────────────────────── */
// Slightly past the server routes' own ceilings, so the server's specific
// error ("Gemini didn't respond within...") wins the race when a provider
// stalls, and this guard only fires when our own server has gone quiet.
const REQUEST_TIMEOUT_MS = 190_000;

async function fetchApiJson(path, init) {
  let response;
  try {
    response = await fetch(path, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error("The server didn't respond in time. Try again in a minute.");
    }
    throw new Error("Couldn't reach the server. Check your internet connection and try again.");
  }

  // Error bodies aren't guaranteed to be JSON (a crashed dev server or a proxy
  // can answer with HTML), so parse defensively.
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || `The server request failed (HTTP ${response.status}).`);
  }
  if (data === null) {
    throw new Error("The server returned a response that couldn't be read. Try again.");
  }
  return data;
}

function postApiJson(path, body) {
  return fetchApiJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ── Model discovery ───────────────────────────────────────── */
// source is "live" when the server listed models from the provider's API and
// "fallback" when it answered with the bundled defaults (missing key, upstream
// hiccup) — the Settings hint tells the user which one they're looking at.
export async function fetchProviderModelOptions(provider) {
  const data = await fetchApiJson(`/api/llm/models?provider=${encodeURIComponent(provider)}`);
  return {
    options: Array.isArray(data.options) ? data.options : [],
    source: data.source === "live" ? "live" : "fallback",
  };
}

// First chat provider with a server API key set (xAI → Anthropic → OpenAI →
// Google). Used on load so the default picker lands on a usable provider.
export async function fetchPreferredLlmProvider() {
  const data = await fetchApiJson("/api/llm/models");
  const preferred =
    data.preferred === "openai" ||
    data.preferred === "anthropic" ||
    data.preferred === "xai" ||
    data.preferred === "gemini"
      ? data.preferred
      : null;
  return {
    preferred,
    configured: data.configured && typeof data.configured === "object" ? data.configured : {},
  };
}

/* ── Generation ────────────────────────────────────────────── */
// `meta` is metrics context — { promptKey, runId, purpose } — that the server
// stamps onto llm_calls. It's advisory: the route validates the prompt key
// against the catalog and resolves the foreign key itself, so a wrong or
// missing meta costs attribution, never the generation.
export async function callLlm(settings, prompt, file, meta = {}) {
  const data = await postApiJson("/api/llm", {
    provider: settings.provider,
    model: settings.model.trim() || getDefaultModelForProvider(settings.provider),
    prompt,
    file: file ?? null,
    promptKey: meta.promptKey ?? "",
    runId: meta.runId ?? null,
    purpose: meta.purpose ?? "",
  });
  return data.text ?? "";
}

/* ── Mistral OCR (document → markdown) ─────────────────────── */
// Converts formats the chat providers can't ingest natively (Word, PowerPoint,
// OpenDocument) into markdown text. The selected chat model still does the
// JSON extraction; OCR only supplies it readable text.
export async function callMistralOcr(file, meta = {}) {
  const data = await postApiJson("/api/ocr", { file, runId: meta.runId ?? null });
  return data.text ?? "";
}

/* ── Firecrawl (job page → markdown) ───────────────────────── */
export async function scrapeJobPage(url, meta = {}) {
  return postApiJson("/api/scrape", { url, runId: meta.runId ?? null });
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

// Call the model and parse its response as JSON. Models occasionally wrap the
// object in prose or emit a stray token that breaks a strict parse; when that
// happens, hand the model its own output back once and ask for clean JSON before
// giving up. The file (if any) isn't resent on retry — only the text needs fixing.
export async function callLlmForJson(settings, prompt, file, meta = {}) {
  const text = await callLlm(settings, prompt, file, meta);
  try {
    return extractJson(text);
  } catch {
    const repairPrompt = `The following response was supposed to be a single valid JSON object but could not be parsed. Return only the corrected JSON object, with no markdown fences, comments, or surrounding text.

<invalid_response>
${text}
</invalid_response>`;
    // The repair call is logged against the ORIGINAL prompt with purpose
    // 'repair', not against the repair template: what we want to learn is which
    // prompt keeps producing unparseable JSON, and that's the caller's.
    const repaired = await callLlm(settings, repairPrompt, null, { ...meta, purpose: "repair" });
    return extractJson(repaired);
  }
}
