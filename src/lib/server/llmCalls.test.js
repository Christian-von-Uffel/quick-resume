import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The admin client is the only thing recordLlmCall talks to. `from().insert()`
// is the llm_calls write; `rpc("ensure_prompt")` resolves the prompts.id.
const admin = { rpc: vi.fn(), from: vi.fn() };
vi.mock("./supabaseAdmin", () => ({ getSupabaseAdmin: () => admin }));

import { recordLlmCall, normalizeRunId } from "./llmCalls";

const USER = "1993c46d-693d-4a15-9174-d5bc9505e419";
const RUN = "4f2ead5a-8614-4b7e-a13a-edd621386441";
const PROMPT_ID = "efc0a261-b48d-445b-870d-cc5e06d6daa0";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Prompt bodies are cached by content across calls (one ensure_prompt round
// trip per distinct prompt per instance), so each test uses its own body.
let seq = 0;
const uniquePrompt = () => `prompt body ${++seq}`;

let inserted;
let warn;

beforeEach(() => {
  inserted = [];
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  admin.rpc.mockReset().mockResolvedValue({ data: PROMPT_ID, error: null });
  admin.from.mockReset().mockImplementation((table) => ({
    insert: (row) => {
      inserted.push({ table, row });
      return Promise.resolve({ error: null });
    },
  }));
});

afterEach(() => {
  warn.mockRestore();
});

describe("recordLlmCall", () => {
  it("does not resolve until the llm_calls row is written, so the response cannot outrun the insert", async () => {
    // A hosted function is frozen as soon as it responds; a write still in
    // flight at that point is lost. The route awaits this, so it must not
    // settle before the insert does.
    const insert = deferred();
    admin.from.mockImplementation(() => ({ insert: () => insert.promise }));

    let settled = false;
    const pending = recordLlmCall({ userId: USER, prompt: uniquePrompt(), runId: RUN }).then(
      (value) => {
        settled = true;
        return value;
      }
    );

    await tick();
    await tick();
    expect(settled).toBe(false);

    insert.resolve({ error: null });
    await expect(pending).resolves.toBe(PROMPT_ID);
    expect(settled).toBe(true);
  });

  it("writes one row with the call's cost and identity", async () => {
    const promptId = await recordLlmCall({
      userId: USER,
      prompt: uniquePrompt(),
      runId: RUN,
      feature: "resume_generation",
      provider: "xai",
      model: "grok-4.5",
      inputTokens: 7888,
      outputTokens: 6730,
      durationMs: 95316.4,
      succeeded: true,
    });

    expect(promptId).toBe(PROMPT_ID);
    expect(admin.rpc).toHaveBeenCalledWith("ensure_prompt", expect.objectContaining({ p_prompt: expect.any(String) }));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe("llm_calls");
    expect(inserted[0].row).toEqual({
      user_id: USER,
      prompt_id: PROMPT_ID,
      run_id: RUN,
      feature: "resume_generation",
      provider: "xai",
      model: "grok-4.5",
      input_tokens: 7888,
      output_tokens: 6730,
      pages: 0,
      duration_ms: 95316,
      was_repair: false,
      succeeded: true,
    });
  });

  it("records a failed call too — it still burned tokens and counts toward burst", async () => {
    await recordLlmCall({
      userId: USER,
      prompt: uniquePrompt(),
      runId: RUN,
      feature: "resume_generation",
      wasRepair: true,
      durationMs: -5,
      succeeded: false,
    });

    expect(inserted[0].row).toMatchObject({
      succeeded: false,
      was_repair: true,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
    });
  });

  it("swallows an insert error and still hands back the prompt id, so metering never fails the call", async () => {
    admin.from.mockImplementation(() => ({
      insert: () => Promise.resolve({ error: { message: "relation llm_calls is on fire" } }),
    }));

    await expect(recordLlmCall({ userId: USER, prompt: uniquePrompt() })).resolves.toBe(PROMPT_ID);
    expect(warn).toHaveBeenCalledWith("[llm_calls] failed to record:", "relation llm_calls is on fire");
  });

  it("resolves rather than rejecting when the insert itself throws", async () => {
    admin.from.mockImplementation(() => ({
      insert: () => Promise.reject(new Error("fetch failed")),
    }));

    await expect(recordLlmCall({ userId: USER, prompt: uniquePrompt() })).resolves.toBe(PROMPT_ID);
    expect(warn).toHaveBeenCalledWith("[llm_calls] failed to record:", "fetch failed");
  });

  it("still writes the row when the prompt lookup fails, with a null prompt_id", async () => {
    admin.rpc.mockResolvedValue({ data: null, error: { message: "ensure_prompt exploded" } });

    await expect(recordLlmCall({ userId: USER, prompt: uniquePrompt(), runId: RUN })).resolves.toBeNull();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].row.prompt_id).toBeNull();
  });

  it("still writes the row when the prompt lookup throws", async () => {
    admin.rpc.mockRejectedValue(new Error("socket hang up"));

    await expect(recordLlmCall({ userId: USER, prompt: uniquePrompt() })).resolves.toBeNull();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].row.prompt_id).toBeNull();
  });

  it("skips the prompt lookup for calls with no prompt (OCR, scrape) but records them", async () => {
    await recordLlmCall({ userId: USER, feature: "resume_import", provider: "mistral", model: "ocr", pages: 3 });

    expect(admin.rpc).not.toHaveBeenCalled();
    expect(inserted[0].row).toMatchObject({ prompt_id: null, feature: "resume_import", pages: 3 });
  });

  it("nulls a malformed run id instead of letting it fail the insert", async () => {
    await recordLlmCall({ userId: USER, prompt: uniquePrompt(), runId: "not-a-uuid" });

    expect(inserted[0].row.run_id).toBeNull();
  });
});

describe("normalizeRunId", () => {
  it("passes a uuid through and rejects anything else", () => {
    expect(normalizeRunId(RUN)).toBe(RUN);
    expect(normalizeRunId(RUN.toUpperCase())).toBe(RUN.toUpperCase());
    expect(normalizeRunId("not-a-uuid")).toBeNull();
    expect(normalizeRunId(42)).toBeNull();
    expect(normalizeRunId(null)).toBeNull();
  });
});
