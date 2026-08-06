import { getSupabaseAdmin } from "./supabaseAdmin";
import { labelForPrompt, normalizePromptBody } from "../prompts";
import { PRODUCTION_TEMPLATES } from "../promptLab";

/**
 * Ensure the current in-code production templates exist as prompts rows, then
 * load recent prompt bodies for the lab picker.
 */
export async function loadLabPromptLibrary(supabase) {
  const admin = getSupabaseAdmin();
  await Promise.all(
    Object.values(PRODUCTION_TEMPLATES).map(async (template) => {
      const body = normalizePromptBody(template);
      if (!body) return;
      const { error } = await admin.rpc("ensure_prompt", { p_prompt: body });
      if (error) console.error("Failed to sync production prompt:", error.message);
    })
  );

  const { data, error } = await supabase
    .from("prompts")
    .select("id, prompt, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("Failed to load prompts for lab:", error.message);
    return [];
  }

  const productionBodies = new Set(
    Object.values(PRODUCTION_TEMPLATES).map((template) => normalizePromptBody(template))
  );

  return (data ?? []).map((row) => ({
    id: row.id,
    template: row.prompt,
    label: labelForPrompt(row.prompt),
    savedAt: row.created_at || "",
    isProduction: productionBodies.has(normalizePromptBody(row.prompt)),
  }));
}
