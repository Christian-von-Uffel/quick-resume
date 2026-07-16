import { describe, it, expect, vi, afterEach } from "vitest";
import {
  describeLlmApiError,
  sanitizeApiKey,
  requireServerApiKey,
  getPreferredLlmProvider,
  omitSessionRejectedParams,
  rememberSessionRejectedParam,
} from "./server/llmProviders";
import { normalizeLlmSettings, getDefaultModelForProvider } from "./llm";

// Messages below mirror what the providers actually return, so the classifier
// is tested against real-world shapes rather than idealized ones.
describe("describeLlmApiError", () => {
  it("flags a bad Gemini key even though Gemini reports it as HTTP 400", () => {
    const message = describeLlmApiError("Gemini", 400, "API key not valid. Please pass a valid API key.");
    expect(message).toMatch(/rejected the server's API key/i);
    expect(message).toContain("GEMINI_API_KEY");
    expect(message).toContain("API key not valid");
  });

  it("flags a bad OpenAI key on HTTP 401", () => {
    const message = describeLlmApiError("OpenAI", 401, "Incorrect API key provided: sk-abc***.");
    expect(message).toMatch(/rejected the server's API key/i);
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).toContain("HTTP 401");
  });

  it("flags a bad Anthropic key on HTTP 401", () => {
    const message = describeLlmApiError("Anthropic", 401, "invalid x-api-key");
    expect(message).toMatch(/rejected the server's API key/i);
    expect(message).toContain("ANTHROPIC_API_KEY");
  });

  it("flags Anthropic's empty credit balance, reported as HTTP 400", () => {
    const message = describeLlmApiError(
      "Anthropic",
      400,
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
    );
    expect(message).toMatch(/out of credits/i);
    expect(message).toMatch(/billing/i);
  });

  it("classifies OpenAI's exhausted quota as billing, not rate limiting, despite HTTP 429", () => {
    const message = describeLlmApiError(
      "OpenAI",
      429,
      "You exceeded your current quota, please check your plan and billing details."
    );
    expect(message).toMatch(/out of credits/i);
    expect(message).not.toMatch(/rate-limiting/i);
  });

  it("classifies a plain HTTP 429 as rate limiting", () => {
    const message = describeLlmApiError("Anthropic", 429, "Number of requests has exceeded your per-minute rate limit.");
    expect(message).toMatch(/rate-limiting/i);
    expect(message).toMatch(/try again/i);
  });

  it("points at model selection when the model does not exist", () => {
    const message = describeLlmApiError("OpenAI", 404, "The model `gpt-nonexistent` does not exist or you do not have access to it.");
    expect(message).toMatch(/find the selected model/i);
    expect(message).toMatch(/Settings/);
  });

  it("recognizes Gemini's model-not-found phrasing without relying on the status code", () => {
    const message = describeLlmApiError(
      "Gemini",
      400,
      "models/gemini-nope is not found for API version v1beta, or is not supported for generateContent."
    );
    expect(message).toMatch(/find the selected model/i);
  });

  it("blames the provider for 5xx failures", () => {
    const overloaded = describeLlmApiError("Anthropic", 529, "Overloaded");
    expect(overloaded).toMatch(/down or overloaded/i);
    expect(overloaded).toMatch(/their side/i);

    const outage = describeLlmApiError("OpenAI", 503, "");
    expect(outage).toMatch(/down or overloaded/i);
    expect(outage).toContain("HTTP 503");
  });

  it("falls back to the status code and provider message for other 4xx errors", () => {
    const message = describeLlmApiError("Gemini", 400, "Request payload size exceeds the limit.");
    expect(message).toContain("HTTP 400");
    expect(message).toContain("Request payload size exceeds the limit.");
  });

  it("omits the quoted provider message when the body had none", () => {
    const message = describeLlmApiError("OpenAI", 400, "");
    expect(message).toBe("OpenAI rejected the request (HTTP 400).");
  });
});

describe("requireServerApiKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the sanitized env value when it is set", () => {
    vi.stubEnv("GEMINI_API_KEY", " AIza-key\n");
    expect(requireServerApiKey("Gemini")).toBe("AIza-key");
  });

  it("names the missing env var so the operator knows what to fix", () => {
    vi.stubEnv("MISTRAL_API_KEY", "");
    expect(() => requireServerApiKey("Mistral")).toThrowError(/MISTRAL_API_KEY isn't set/);
    try {
      requireServerApiKey("Mistral");
    } catch (error) {
      expect(error.status).toBe(503);
    }
  });
});

describe("getPreferredLlmProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers xAI when its key is set, even if Gemini is also set", () => {
    vi.stubEnv("XAI_API_KEY", "xai-key");
    vi.stubEnv("GEMINI_API_KEY", "gemini-key");
    expect(getPreferredLlmProvider()).toBe("xai");
  });

  it("falls through xAI → Anthropic → OpenAI → Google", () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("GEMINI_API_KEY", "gemini-key");
    expect(getPreferredLlmProvider()).toBe("openai");
  });

  it("uses Google when no higher-priority key is set", () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "gemini-key");
    expect(getPreferredLlmProvider()).toBe("gemini");
  });

  it("falls back to Google when no chat provider keys are set", () => {
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(getPreferredLlmProvider()).toBe("gemini");
  });
});

// Each test uses its own memo key: the memo is module-level session state, and
// unique keys keep tests independent without a reset hook.
describe("session rejected-param memo", () => {
  it("passes the body through untouched for a model with no remembered rejections", () => {
    const body = { model: "gpt-x", temperature: 0.2 };
    expect(omitSessionRejectedParams("openai:memo-test-unknown", body)).toBe(body);
  });

  it("omits remembered params on later calls without mutating the original body", () => {
    const key = "openai:memo-test-known";
    rememberSessionRejectedParam(key, "temperature");

    const body = { model: "gpt-x", temperature: 0.2, input: [] };
    const cleaned = omitSessionRejectedParams(key, body);

    expect(cleaned).toEqual({ model: "gpt-x", input: [] });
    expect(body.temperature).toBe(0.2);
  });

  it("scopes rejections to the provider/model key", () => {
    rememberSessionRejectedParam("anthropic:memo-test-a", "temperature");
    const body = { temperature: 0.2 };
    expect(omitSessionRejectedParams("anthropic:memo-test-b", body)).toBe(body);
  });

  it("ignores a missing memo key on both sides", () => {
    const body = { temperature: 0.2 };
    rememberSessionRejectedParam("", "temperature");
    expect(omitSessionRejectedParams("", body)).toBe(body);
    expect(omitSessionRejectedParams(undefined, body)).toBe(body);
  });
});

describe("sanitizeApiKey", () => {
  it("strips non-ASCII characters that would make fetch reject the header", () => {
    expect(sanitizeApiKey("​AIza-key  ")).toBe("AIza-key");
  });

  it("handles null and undefined", () => {
    expect(sanitizeApiKey(null)).toBe("");
    expect(sanitizeApiKey(undefined)).toBe("");
  });
});

describe("normalizeLlmSettings", () => {
  it("keeps a valid provider and model", () => {
    expect(normalizeLlmSettings({ provider: "anthropic", model: "claude-haiku-4-5" })).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("drops legacy stored API-key fields so they leave persisted state", () => {
    const normalized = normalizeLlmSettings({
      provider: "openai",
      model: "gpt-5.5",
      openaiApiKey: "sk-legacy",
      firecrawlApiKey: "fc-legacy",
      rememberApiKey: true,
    });

    expect(normalized).toEqual({ provider: "openai", model: "gpt-5.5" });
  });

  it("keeps a valid xAI provider and model", () => {
    expect(normalizeLlmSettings({ provider: "xai", model: "grok-4.5" })).toEqual({
      provider: "xai",
      model: "grok-4.5",
    });
  });

  it("falls back to defaults for unknown providers and models", () => {
    expect(normalizeLlmSettings({ provider: "aol", model: "clippy-9000" })).toEqual({
      provider: "gemini",
      model: "gemini-3.5-flash",
    });
  });
});

describe("getDefaultModelForProvider", () => {
  it("prefers the named xAI default even when it is not first in the live list", () => {
    const live = {
      xai: [
        ["grok-4.20-0309-non-reasoning", "grok-4.20-0309-non-reasoning"],
        ["grok-4.3", "grok-4.3"],
        ["grok-4.5", "grok-4.5"],
      ],
    };
    expect(getDefaultModelForProvider("xai", live)).toBe("grok-4.5");
  });

  it("falls back to the first option when the preferred model is missing", () => {
    const live = {
      xai: [
        ["grok-4.20-0309-non-reasoning", "grok-4.20-0309-non-reasoning"],
        ["grok-4.3", "grok-4.3"],
      ],
    };
    expect(getDefaultModelForProvider("xai", live)).toBe("grok-4.20-0309-non-reasoning");
  });
});
