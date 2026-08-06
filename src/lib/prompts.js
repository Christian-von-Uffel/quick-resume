// The `prompts` table: one row per distinct prompt body (`id`, `prompt`,
// `created_at`). No keys, no versions — the text is the identity.
//
// Server and browser both resolve a body to an id via the ensure_prompt RPC
// (find-or-insert). Product runs stamp that id onto clarity_reviews,
// experience_expansions, job_gap_analyses, resume_generations, and onto
// questions / suggestions / llm_calls for per-call attribution.

export function normalizePromptBody(value) {
  return String(value ?? "").trim();
}

export function labelForPrompt(prompt) {
  const text = String(prompt ?? "");
  const query = text.match(/<Query>\s*([\s\S]*?)\s*<\/Query>/i)?.[1]?.trim();
  const task = text.match(/<task>\s*([\s\S]*?)\s*<\/task>/i)?.[1]?.trim();
  const source = (
    query ||
    task ||
    text.split("\n").map((line) => line.trim()).find(Boolean) ||
    "Untitled prompt"
  )
    .replace(/\s+/g, " ")
    .trim();
  return source.length > 72 ? `${source.slice(0, 71)}…` : source;
}

/**
 * Find or insert a prompts row for this body. Returns the uuid, or null when
 * the body is empty / the call fails.
 */
export async function ensurePromptId(supabase, prompt) {
  const body = normalizePromptBody(prompt);
  if (!supabase || !body) return null;
  const { data, error } = await supabase.rpc("ensure_prompt", { p_prompt: body });
  if (error) {
    console.warn("[prompts] ensure_prompt failed:", error.message);
    return null;
  }
  return typeof data === "string" && data ? data : null;
}
