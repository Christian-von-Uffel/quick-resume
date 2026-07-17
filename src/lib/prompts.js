// The code-side twin of the `prompts` table.
//
// Every key here has a matching row in public.prompts. Writes carry a
// (key, version) pair, which is resolved to a prompts.id and stored as a
// foreign key — that FK is what makes prompt performance comparable.
//
// CHANGING A PROMPT: bump its version here AND insert the matching row in a
// migration. Rows already written keep pointing at the old version, which is
// exactly what lets you compare v1 against v2. Editing a prompt builder
// without bumping silently mixes two prompts under one id.

export const PROMPTS = {
  IMPORT_EXTRACT: "import_extract",

  CLARITY_REVIEW: "clarity_review",
  CLARITY_REWRITE: "clarity_rewrite",

  EXPANSION_OPENING: "expansion_opening",
  EXPANSION_FOLLOWUP: "expansion_followup",
  EXPANSION_COMPOSE: "expansion_compose",

  GAP_REVIEW: "gap_review",
  GAP_ELABORATION: "gap_elaboration",

  GENERATION_ANALYSIS: "generation_analysis",
  GENERATION_EVIDENCE: "generation_evidence",
  GENERATION_COMPOSE: "generation_compose",

  JOB_DESCRIPTION_CLEAN: "job_description_clean",
};

// key → the version of that prompt this build ships.
export const PROMPT_VERSIONS = {
  [PROMPTS.IMPORT_EXTRACT]: 1,
  [PROMPTS.CLARITY_REVIEW]: 1,
  [PROMPTS.CLARITY_REWRITE]: 1,
  [PROMPTS.EXPANSION_OPENING]: 1,
  [PROMPTS.EXPANSION_FOLLOWUP]: 1,
  [PROMPTS.EXPANSION_COMPOSE]: 1,
  [PROMPTS.GAP_REVIEW]: 1,
  [PROMPTS.GAP_ELABORATION]: 1,
  [PROMPTS.GENERATION_ANALYSIS]: 1,
  [PROMPTS.GENERATION_EVIDENCE]: 1,
  [PROMPTS.GENERATION_COMPOSE]: 1,
  [PROMPTS.JOB_DESCRIPTION_CLEAN]: 1,
};

export function isKnownPrompt(key) {
  return typeof key === "string" && Object.hasOwn(PROMPT_VERSIONS, key);
}
