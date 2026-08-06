import { describe, expect, it } from "vitest";
import { labelForPrompt, normalizePromptBody } from "./prompts";

describe("normalizePromptBody", () => {
  it("trims whitespace", () => {
    expect(normalizePromptBody("  hello  ")).toBe("hello");
  });

  it("turns empty input into an empty string", () => {
    expect(normalizePromptBody(null)).toBe("");
    expect(normalizePromptBody("   ")).toBe("");
  });
});

describe("labelForPrompt", () => {
  it("prefers Query, then task, then the first line", () => {
    expect(labelForPrompt(`<Query>Ask three questions.</Query>`)).toBe("Ask three questions.");
    expect(labelForPrompt(`<task>Review this role.</task>`)).toBe("Review this role.");
    expect(labelForPrompt("\n\nFirst line\nSecond")).toBe("First line");
  });
});
