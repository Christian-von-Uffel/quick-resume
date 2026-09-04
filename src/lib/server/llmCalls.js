// llm_calls writer: one row per provider call, written with the service role.
//
// This is the unspoofable half. The browser writes its own product metrics
// (RLS scopes them to the user, and faking your own funnel buys you nothing),
// but what a call actually cost has to be recorded where the user can't reach
// it — quotas are enforced off this table (see quota.js and usage_snapshot).
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

// Awaited, never thrown. The row is what quotas are enforced off, so it has to
// exist before the response goes out: a hosted function is frozen the moment
// it responds, and an insert fired just before that froze with it — every
// run's last call went unrecorded while this was fire-and-forget. Metering
// must still never fail a call the user already paid for, so errors are
// logged and swallowed; the promise only ever resolves, with the prompts.id
// so the HTTP response can hand it back.
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
    const { error } = await getSupabaseAdmin()
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
      });
    if (error) console.warn("[llm_calls] failed to record:", error.message);
  } catch (error) {
    console.warn("[llm_calls] failed to record:", error?.message ?? error);
  }

  return promptId;
}
