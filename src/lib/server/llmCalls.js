// llm_calls writer: one row per provider call, written with the service role.
//
// This is the unspoofable half. The browser writes its own product metrics
// (RLS scopes them to the user, and faking your own funnel buys you nothing),
// but what a call actually cost has to be recorded where the user can't reach
// it — quotas will be enforced off this table.
//
// The prompt body that was sent is find-or-inserted into public.prompts here,
// and the resulting id is stamped on the llm_calls row.

import { getSupabaseAdmin } from "./supabaseAdmin";
import { normalizePromptBody } from "../prompts";

const promptIdCache = new Map();

async function ensurePromptId(prompt) {
  const body = normalizePromptBody(prompt);
  if (!body) return null;
  if (promptIdCache.has(body)) return promptIdCache.get(body);

  const { data, error } = await getSupabaseAdmin().rpc("ensure_prompt", { p_prompt: body });
  if (error || typeof data !== "string" || !data) {
    if (error) console.warn("[prompts] ensure_prompt failed:", error.message);
    return null;
  }
  promptIdCache.set(body, data);
  return data;
}

// A uuid from the browser is only ever a correlation key (llm_calls.run_id is
// deliberately not a foreign key), but a malformed one would fail the insert
// and lose the cost record, so it's validated rather than trusted.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeRunId(value) {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

// Fire-and-forget: a metering write must never fail a call the user already
// paid for, so this swallows its own errors. Resolves the prompts.id first so
// the HTTP response can hand it back; the llm_calls insert is not awaited.
export async function recordLlmCall({
  userId,
  prompt = "",
  runId = null,
  feature = "",
  provider = "",
  model = "",
  inputTokens = 0,
  outputTokens = 0,
  pages = 0,
  durationMs = 0,
  wasRepair = false,
  succeeded = true,
}) {
  let promptId = null;
  try {
    promptId = await ensurePromptId(prompt);
  } catch (error) {
    console.warn("[llm_calls] prompt resolve failed:", error?.message ?? error);
  }

  try {
    void getSupabaseAdmin()
      .from("llm_calls")
      .insert({
        user_id: userId,
        prompt_id: promptId,
        run_id: normalizeRunId(runId),
        feature,
        provider,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        pages,
        duration_ms: Math.max(0, Math.round(durationMs)),
        was_repair: wasRepair,
        succeeded,
      })
      .then(({ error }) => {
        if (error) console.warn("[llm_calls] failed to record:", error.message);
      });
  } catch (error) {
    console.warn("[llm_calls] failed to record:", error?.message ?? error);
  }

  return promptId;
}
