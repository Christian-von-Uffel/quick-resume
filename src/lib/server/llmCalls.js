// llm_calls writer: one row per provider call, written with the service role.
//
// This is the unspoofable half. The browser writes its own product metrics
// (RLS scopes them to the user, and faking your own funnel buys you nothing),
// but what a call actually cost has to be recorded where the user can't reach
// it — quotas will be enforced off this table.
//
// The client says which prompt ran (a key) and which run it belongs to; the key
// is resolved to a prompts.id here rather than trusting a raw id from the
// browser. Everything else — provider, model, tokens, duration, outcome — is
// observed on this side.

import { getSupabaseAdmin } from "./supabaseAdmin";
import { PROMPT_VERSIONS } from "../prompts";

// key@version → prompts.id. The catalog only changes on deploy (a new version
// means a new migration and a new build), so a process-lifetime cache is safe
// and keeps a lookup off the hot path of every call.
const promptIdCache = new Map();

async function resolvePromptId(promptKey) {
  if (!promptKey) return null;
  const version = PROMPT_VERSIONS[promptKey];
  if (!version) return null;

  const cacheKey = `${promptKey}@${version}`;
  if (promptIdCache.has(cacheKey)) return promptIdCache.get(cacheKey);

  const { data, error } = await getSupabaseAdmin()
    .from("prompts")
    .select("id")
    .eq("key", promptKey)
    .eq("version", version)
    .maybeSingle();

  // Don't cache a miss: a row that hasn't been migrated in yet should start
  // resolving as soon as it exists, without a redeploy.
  if (error || !data?.id) return null;
  promptIdCache.set(cacheKey, data.id);
  return data.id;
}

// A uuid from the browser is only ever a correlation key (llm_calls.run_id is
// deliberately not a foreign key), but a malformed one would fail the insert
// and lose the cost record, so it's validated rather than trusted.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeRunId(value) {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

export function normalizePromptKey(value) {
  return typeof value === "string" && Object.hasOwn(PROMPT_VERSIONS, value) ? value : "";
}

// Fire-and-forget: a metering write must never fail a call the user already
// paid for, so this swallows its own errors. Callers don't await it.
export async function recordLlmCall({
  userId,
  promptKey = "",
  runId = null,
  provider = "",
  model = "",
  inputTokens = 0,
  outputTokens = 0,
  pages = 0,
  durationMs = 0,
  wasRepair = false,
  succeeded = true,
}) {
  try {
    await getSupabaseAdmin()
      .from("llm_calls")
      .insert({
        user_id: userId,
        prompt_id: await resolvePromptId(promptKey),
        run_id: normalizeRunId(runId),
        provider,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        pages,
        duration_ms: Math.max(0, Math.round(durationMs)),
        was_repair: wasRepair,
        succeeded,
      });
  } catch (error) {
    console.warn("[llm_calls] failed to record:", error?.message ?? error);
  }
}
