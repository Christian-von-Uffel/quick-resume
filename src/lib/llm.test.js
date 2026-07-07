import { describe, it, expect } from "vitest";
import {
  describeLlmApiError,
  sanitizeApiKey,
  omitSessionRejectedParams,
  rememberSessionRejectedParam,
} from "./llm";

// Messages below mirror what the providers actually return, so the classifier
// is tested against real-world shapes rather than idealized ones.
describe("describeLlmApiError", () => {
  it("flags a bad Gemini key even though Gemini reports it as HTTP 400", () => {
    const message = describeLlmApiError("Gemini", 400, "API key not valid. Please pass a valid API key.");
    expect(message).toMatch(/rejected your API key/i);
    expect(message).toMatch(/Settings/);
    expect(message).toContain("API key not valid");
  });

  it("flags a bad OpenAI key on HTTP 401", () => {
    const message = describeLlmApiError("OpenAI", 401, "Incorrect API key provided: sk-abc***.");
    expect(message).toMatch(/rejected your API key/i);
    expect(message).toContain("HTTP 401");
  });

  it("flags a bad Anthropic key on HTTP 401", () => {
    const message = describeLlmApiError("Anthropic", 401, "invalid x-api-key");
    expect(message).toMatch(/rejected your API key/i);
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
    expect(sanitizeApiKey("​AIza-key  ")).toBe("AIza-key");
  });

  it("handles null and undefined", () => {
    expect(sanitizeApiKey(null)).toBe("");
    expect(sanitizeApiKey(undefined)).toBe("");
  });
});
