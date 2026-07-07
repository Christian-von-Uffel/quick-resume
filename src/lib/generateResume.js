import { getVisibleContactLine, normalizeStoredList, splitDescriptionIntoDetails } from "./resumeModel";
import { MONTH_OPTIONS } from "./constants";
import { formatMonthSpan } from "./workHistoryTimeline";

// The resume generation pipeline, in the order the UI reports progress:
//   Step 1  buildJobAnalysisPrompt   -> company/position for the saved title, plus
//                                       the key responsibilities and must-have
//                                       requirements that anchor everything after
//   Step 2  selectRankedEvidence     -> which roles and bullets to use, with each
//                                       role's bullets ordered most-applicable-first
//   Step 3  composeResume            -> final markdown; the title line says what the
//                                       candidate has BEEN, never the job they want
// Every step grounds its output in the person's stored history — bullets are
// evidence to reorder and sharpen, never facts to invent.

export const GENERATE_STEPS = [
  { id: "analyze", label: "Reading the job's responsibilities and requirements" },
  { id: "select", label: "Selecting and ranking your most applicable experience" },
  { id: "compose", label: "Writing the tailored resume" },
];

const REASON_LABELS = {
  current: "current position — always list",
  "most-recent": "most recent position — always list",
  "covers-gap": "covers an employment gap — list to keep the timeline continuous",
};

// Readable date window for a stored work-history item, e.g. "March 2019 — Present".
export function formatRoleWindow(item) {
  const label = (year, month) => {
    if (/^(present|current)$/i.test(String(year ?? "").trim())) return "Present";
    if (!String(year ?? "").trim()) return "";
    const monthNum = parseInt(String(month ?? "").trim(), 10);
    const monthName = monthNum >= 1 && monthNum <= 12 ? `${MONTH_OPTIONS[monthNum - 1]} ` : "";
    return `${monthName}${String(year).trim()}`;
  };
  const start = label(item.startYear, item.startMonth);
  const endRaw = String(item.endYear ?? "").trim();
  const end = endRaw ? label(item.endYear, item.endMonth) : "Present";
  return [start, end].filter(Boolean).join(" — ");
}

// Human-readable identity used to describe and match a role across prompt/LLM output.
function roleIdentity(item) {
  return [item.position || "", item.company || "", formatRoleWindow(item)]
    .filter(Boolean)
    .join(" · ");
}

// Loose match so a required role can be found in the model's returned selection
// even if it lightly reworded the title/company.
function isSameRole(a, b) {
  const norm = (value) => String(value ?? "").trim().toLowerCase();
  const company = norm(a.company) && norm(a.company) === norm(b.company);
  const startYear = norm(a.startYear) && norm(a.startYear) === norm(b.startYear);
  const position = norm(a.position) && norm(a.position) === norm(b.position);
  return (company && startYear) || (company && position) || (position && startYear);
}

// One entry per stored detail — bullet lines and the separate sentences of any
// paragraph-style description both count, so prose-formatted histories backfill
// as real bullets instead of one blob line.
function bulletsFromDescription(description) {
  return splitDescriptionIntoDetails(description);
}

// Prompt block listing the roles the resume MUST include for a continuous,
// currently-employed timeline. Roles are grouped by employer so a promotion
// ladder reads as one growing tenure, annotated with recency (emphasis) and
// which role leads a concurrent pair. Empty string when there's nothing to
// require.
export function describeMandatoryRoles(coverage) {
  if (!coverage?.requiredRoles?.length) return "";

  // roleId -> interval (position/company/dates) from the shared employer model.
  const roleById = new Map();
  for (const emp of coverage.employers ?? []) {
    for (const role of emp.roles) roleById.set(role.id, role);
  }
  const employerByKey = new Map((coverage.employers ?? []).map((emp) => [emp.key, emp]));
  const keyOf = (id) => coverage.employerKeyByRoleId?.get(id);

  const recencyTag = (recency) =>
    recency >= 0.6 ? "recent — emphasize" : recency < 0.2 ? "older — keep brief" : "";

  const requiredById = new Map(coverage.requiredRoles.map((entry) => [entry.item.id, entry]));

  // A line for one role. Required roles carry their continuity reason; a
  // non-required rung of a promotion ladder is optional but shown for context.
  const roleLine = (item, { recency, reason }) => {
    const tags = [];
    if (reason) tags.push(REASON_LABELS[reason] ?? "keeps the timeline continuous");
    else tags.push("same employer — include only if it adds relevant evidence");
    const rt = recencyTag(recency ?? 0);
    if (rt) tags.push(rt);
    if (coverage.primaryRoleIds?.has(item.id)) tags.push("primary of a concurrent pair — lead with this");
    return `  - ${roleIdentity(item)} (${tags.join("; ")})`;
  };

  // Group required roles by employer; order employers by their most recent role.
  const groups = new Map();
  for (const entry of coverage.requiredRoles) {
    const key = keyOf(entry.item.id) ?? `solo:${entry.item.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const orderedGroups = [...groups.entries()]
    .map(([key, entries]) => ({
      employer: employerByKey.get(key),
      entries,
      maxRecency: Math.max(...entries.map((e) => e.recency ?? 0)),
    }))
    .sort((a, b) => b.maxRecency - a.maxRecency);

  const blocks = orderedGroups.map(({ employer, entries }) => {
    // A promotion-ladder employer is rendered as its full tenure (all rungs,
    // most-recent title first) so the growth story survives even when only the
    // current rung is strictly required for continuity.
    if (employer?.isPromotionLadder) {
      const rungs = [...employer.roles]
        .filter((role) => role.item)
        .sort((a, b) => b.start - a.start || b.end - a.end)
        .map((role) =>
          roleLine(role.item, {
            recency: coverage.recencyOf ? coverage.recencyOf(role.id) : 0,
            reason: requiredById.get(role.id)?.reason,
          })
        )
        .join("\n");
      return `${employer.company || "This employer"} — one continuous tenure; present as a SINGLE company entry showing the promotion history, most recent title first:\n${rungs}`;
    }
    return entries
      .sort((a, b) => (b.recency ?? 0) - (a.recency ?? 0))
      .map((entry) => roleLine(entry.item, entry))
      .join("\n");
  });

  // Concurrent-employment guidance from the overlap clusters.
  const concurrent = (coverage.overlapClusters ?? [])
    .map((cluster) => {
      const primary = roleById.get(cluster.primaryRoleId);
      if (!primary) return null;
      const who = [primary.position, primary.company].filter(Boolean).join(" — ") || "the primary role";
      return `  - Overlapping dates (${cluster.companies.join(" & ")}): lead with "${who}"; don't let a concurrent secondary role crowd it out.`;
    })
    .filter(Boolean);

  const notes = [];
  if (coverage.currentlyEmployed === false) {
    notes.push("The candidate is not currently employed; lead with the most recent role and do not fabricate an ongoing position.");
  }
  if (coverage.largestGap) {
    notes.push(`The longest remaining employment gap is about ${formatMonthSpan(coverage.largestGap.months)} and cannot be filled from the work history — do not invent a role to hide it.`);
  }
  if (coverage.undatedCount) {
    notes.push(`${coverage.undatedCount} role(s) have no dates and are not counted toward timeline continuity.`);
  }

  return `
<mandatory_roles>
These roles MUST appear in selectedWorkHistory regardless of how closely they match the target job. They anchor a continuous, current employment record and cover gaps a hiring manager would otherwise question. List experience most-recent-first:

${blocks.join("\n\n")}
${concurrent.length ? `\nConcurrent employment:\n${concurrent.join("\n")}` : ""}${notes.length ? `\nContinuity notes:\n${notes.map((note) => `- ${note}`).join("\n")}` : ""}
You still decide which bullets to surface for each role and how much space each gets — allocate emphasis by recency and fit. Any other older roles should be included only when they add relevant evidence for the target job.
</mandatory_roles>
`;
}

/* ── Step 1: analyze the job description ───────────────────── */
// One call extracts everything later steps need from the job description: the
// company/position for the saved resume's title, the key responsibilities that
// bullets are ranked against, and the must-have requirements the summary may
// mirror (only where the evidence backs them).
export function buildJobAnalysisPrompt(jobDescription) {
  return `<task>
You are reading a job description to prepare a tailored resume.
1. Extract the company name and the position title, for the saved resume's name.
2. List the role's key responsibilities — the actual day-to-day work the hire will do — ordered most central to the job first.
3. List the must-have requirements: the skills, tools, methods, and qualifications the posting treats as essential.
</task>

<job_description>
${jobDescription}
</job_description>

<instructions>
- Base every item ONLY on this job description. Do not add responsibilities or requirements that are merely typical for this kind of title.
- Use empty strings when the company or position cannot be confidently determined. Do not infer missing values from general context.
- Write each responsibility as one short plain-language phrase naming ONE kind of work (e.g. "Build predictive models on employee data"). Merge duplicates. 3 to 6 items, the most central first.
- Write each requirement as a short phrase naming one skill, tool, method, or qualification (e.g. "Python", "Stakeholder communication"). Up to 8 items, most emphasized first.
- Return only valid JSON matching the schema below. Do not wrap it in markdown fences or add comments.
</instructions>

<schema>
{
  "company": "",
  "position": "",
  "keyResponsibilities": [
    "Most central responsibility, as a short phrase."
  ],
  "mustHaveRequirements": [
    "A skill, tool, method, or qualification the posting requires."
  ]
}
</schema>`;
}

// Clean up the model's job analysis: trim everything, drop empties and
// duplicates, cap list lengths. Missing lists degrade to empty arrays so a
// weak extraction still lets generation proceed.
export function validateJobAnalysis(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return a valid job analysis.");
  }

  const cleanList = (list, cap) => {
    const seen = new Set();
    return normalizeStoredList(list, [])
      .map((entry) => (typeof entry === "string" ? entry.replace(/\s+/g, " ").trim() : ""))
      .filter(Boolean)
      .filter((entry) => {
        const key = entry.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, cap);
  };

  return {
    company: typeof value.company === "string" ? value.company.trim() : "",
    position: typeof value.position === "string" ? value.position.trim() : "",
    keyResponsibilities: cleanList(value.keyResponsibilities, 6),
    mustHaveRequirements: cleanList(value.mustHaveRequirements, 8),
  };
}

// Shared prompt block presenting the step-1 analysis to later steps.
function describeJobAnalysis(jobAnalysis) {
  const target = [jobAnalysis?.position, jobAnalysis?.company].filter(Boolean).join(" at ");
  const responsibilities = (jobAnalysis?.keyResponsibilities ?? [])
    .map((entry) => `- ${entry}`)
    .join("\n");
  const requirements = (jobAnalysis?.mustHaveRequirements ?? [])
    .map((entry) => `- ${entry}`)
    .join("\n");

  return `<job_requirements>
Target: ${target || "(not stated in the job description)"}
Key responsibilities, most central first:
${responsibilities || "- (none extracted — use the job description directly)"}
Must-have requirements:
${requirements || "- (none extracted — use the job description directly)"}
</job_requirements>`;
}

/* ── Step 2: select and rank the evidence ───────────────────── */
// Chooses which roles and bullets make the resume, with the ordering the final
// document will keep: within every role, bullets are ranked by how directly
// they evidence the job's key responsibilities, most applicable first.
export function selectRankedEvidence({ profile, workHistory, jobAnalysis, instructions, coverage }) {
  return `<task>
You are choosing the evidence for a resume tailored to one specific job, from the candidate's stored work history.
1. Read the job's key responsibilities and must-have requirements below.
2. Include every role listed in mandatory_roles (timeline continuity), then add any other roles that give direct evidence for this job.
3. For each included role, select the details from its description that best evidence the responsibilities and requirements.
4. Order each role's selectedBullets by how directly they apply to this job, MOST APPLICABLE FIRST — the first bullet is the one a rushed hiring manager must see. Tag each bullet with the key responsibility or requirement it supports.
5. Tag each role's overall fit tier.
</task>

${describeJobAnalysis(jobAnalysis)}

<profile>
${JSON.stringify(profile, null, 2)}
</profile>

<complete_work_history>
${JSON.stringify(workHistory, null, 2)}
</complete_work_history>

<job_description>
${instructions || "No job description provided. Select the most broadly relevant, concrete, and recent experience."}
</job_description>
${describeMandatoryRoles(coverage)}
<selection_policy>
- Always include every role in mandatory_roles, even weak matches, so the resume shows continuous employment with no unexplained gaps.
- Beyond those, prefer direct evidence of fit over general impressiveness. Exclude experience that is impressive but does not help a hiring manager quickly see role fit.
- Every bullet must restate facts already present in that role's stored description. You may tighten wording for clarity, but never invent employers, dates, tools, metrics, schools, or responsibilities, and never import job-description phrases the stored history does not support.
- selectedSkills holds hands-on skills, tools, and methods only. An education requirement in the posting is already covered by the profile's education, which renders in its own resume section — never restate a degree or school as a skill.
- Stored descriptions may be bullet lines or flowing sentences in a paragraph — treat each distinct fact as a selectable detail either way, and split a sentence that packs several facts into separate bullets when that reads better.
- Keep the selection plain, credible, and specific.
- List roles most-recent-first. Roles sharing one employer form a single company block showing progression, most recent title first. When roles overlap in time, lead with the primary named in mandatory_roles.
</selection_policy>

<ranking_bullets>
Within each role, order selectedBullets by applicability to THIS job, not by how the stored description happens to be written:
- First: bullets that directly evidence a key responsibility, strongest and most central responsibility first.
- Then: bullets that evidence a must-have requirement (a tool, skill, or qualification).
- Last: any bullet kept only for context or scope of the role.
Set "supports" to the specific responsibility or requirement the bullet evidences, copied or closely paraphrased from job_requirements — or "general" for context bullets.
</ranking_bullets>

<reconciliation>
Tag every selected role with a "fit" tier and let it drive how much space the role gets, so timeline continuity never crowds out suitability:
- "strong": directly matches the target role — lead with these and give them the most bullets.
- "supporting": relevant but secondary — include with a few bullets.
- "timeline-only": required only to keep employment continuous (see mandatory_roles) and a weak match for this job — keep it (never drop it), but minimize it to its title and dates plus at most one concise line; do not pad it with bullets that dilute the resume's focus.
Among roles of equal fit, prefer the more recent one for emphasis and ordering. A mandatory role that genuinely fits the target job should be tagged "strong" or "supporting", not "timeline-only".
</reconciliation>

<instructions>
Return only valid JSON matching the schema below. Do not wrap it in markdown fences or add comments.
Copy each selected role's position, company, and dates exactly from complete_work_history.
Use excludedItems to explain what you intentionally left out and why.
</instructions>

<schema>
{
  "fitSummary": "One plain-language sentence explaining the candidate's fit.",
  "selectedWorkHistory": [
    {
      "position": "",
      "company": "",
      "startMonth": "",
      "startYear": "",
      "endMonth": "",
      "endYear": "",
      "fit": "strong | supporting | timeline-only",
      "fitReason": "",
      "selectedBullets": [
        {
          "text": "Source-grounded detail, most applicable to this job first.",
          "supports": "The key responsibility or requirement this evidences, or \\"general\\"."
        }
      ]
    }
  ],
  "selectedSkills": [
    "A hands-on skill, tool, or method evidenced in the work history — never a degree, school, or other education credential."
  ],
  "excludedItems": [
    {
      "position": "",
      "company": "",
      "reason": "Why this was less aligned with the target role."
    }
  ]
}
</schema>`;
}

const FIT_TIERS = new Set(["strong", "supporting", "timeline-only"]);

// Coerce a model-supplied fit tag to a known tier, defaulting to "supporting"
// when absent or unrecognized.
export function normalizeFitTier(value) {
  const tier = String(value ?? "").trim().toLowerCase();
  return FIT_TIERS.has(tier) ? tier : "supporting";
}

// A selected bullet is `{ text, supports }`, ordered most-applicable-first.
// Models sometimes return plain strings despite the schema; accept those too so
// one lazy response doesn't sink the whole generation.
function normalizeSelectedBullet(value) {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { text, supports: "" } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text) return null;

  return {
    text,
    supports: typeof value.supports === "string" ? value.supports.trim() : "",
  };
}

function normalizeSelectedRole(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  return {
    ...value,
    fit: normalizeFitTier(value.fit),
    selectedBullets: normalizeStoredList(value.selectedBullets, [])
      .map(normalizeSelectedBullet)
      .filter(Boolean),
  };
}

// Words of a stored credential, for loose matching ("BBA, Finance & Marketing"
// -> bba/finance/marketing).
const credentialWords = (value) =>
  String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// The selection model sometimes "covers" a degree requirement by copying an
// education credential into selectedSkills, where it reads as keyword stuffing.
// Degrees belong only in the EDUCATION section, so drop any skill that restates
// a stored degree or school. A multi-word credential matches when the skill
// contains every one of its words (catches "BBA in Finance & Marketing —
// Hofstra"); a single-word credential ("MBA") matches only a skill that is
// exactly that word, so a real skill sharing a word ("Product Marketing"
// against a "Marketing" degree) survives.
function dropEducationCredentialSkills(skills, education) {
  const credentials = (education ?? [])
    .flatMap((item) => [item?.degree, item?.school])
    .map(credentialWords)
    .filter((words) => words.length > 0);
  if (!credentials.length) return skills;

  return skills.filter((skill) => {
    if (typeof skill !== "string") return true;
    const words = credentialWords(skill);
    const wordSet = new Set(words);
    return !credentials.some((credential) =>
      credential.length === 1
        ? words.length === 1 && words[0] === credential[0]
        : credential.every((word) => wordSet.has(word))
    );
  });
}

export function validateSelectedResumeEvidence(value, profile) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid fit selection JSON.");
  }

  return {
    fitSummary: typeof value.fitSummary === "string" ? value.fitSummary.trim() : "",
    selectedWorkHistory: normalizeStoredList(value.selectedWorkHistory, [])
      .map(normalizeSelectedRole)
      .filter(Boolean),
    selectedSkills: dropEducationCredentialSkills(
      normalizeStoredList(value.selectedSkills, []),
      profile?.education
    ),
    excludedItems: normalizeStoredList(value.excludedItems, []),
  };
}

// Guarantee the deterministic rule holds even if the model dropped a required
// role: append any missing mandatory role from the source work history.
export function ensureRequiredRolesSelected(selectedEvidence, coverage, workHistory) {
  if (!coverage?.requiredRoles?.length) return selectedEvidence;

  const selected = Array.isArray(selectedEvidence.selectedWorkHistory)
    ? [...selectedEvidence.selectedWorkHistory]
    : [];
  const byId = new Map((workHistory ?? []).map((item) => [item.id, item]));

  for (const { item } of coverage.requiredRoles) {
    const source = byId.get(item.id) ?? item;
    const alreadyThere = selected.some((entry) => isSameRole(entry, source));
    if (alreadyThere) continue;

    selected.push({
      position: source.position ?? "",
      company: source.company ?? "",
      startMonth: source.startMonth ?? "",
      startYear: source.startYear ?? "",
      endMonth: source.endMonth ?? "",
      endYear: source.endYear ?? "",
      // The model dropped this despite it being required, so it's a weak match —
      // keep it for continuity but flag it to be rendered compactly.
      fit: "timeline-only",
      fitReason: "Included to keep the employment timeline continuous.",
      selectedBullets: bulletsFromDescription(source.description).map((text) => ({
        text,
        supports: "",
      })),
    });
  }

  return { ...selectedEvidence, selectedWorkHistory: selected };
}

/* ── Step 3: compose the resume markdown ────────────────────── */
export function composeResume({ profile, selectedEvidence, jobAnalysis, instructions, coverage }) {
  const continuityInstruction = coverage?.requiredRoles?.length
    ? "\nInclude every role in the selected evidence. Do not drop roles that cover employment gaps or the current position; the work history must read as continuous and up to date."
    : "";
  return `<task>
Generate polished resume markdown from curated, pre-ranked fit evidence.
1. Render the format below with the profile and every role in the selected evidence.
2. Keep each role's bullets in their given order — they are already ranked most-applicable-first for this job.
3. Write a professional title that says what the candidate has actually been, and a summary that argues fit through the job's key responsibilities.
</task>

<format>
# ${profile.name || "Your Name"}
[Professional title — see title instructions]
${getVisibleContactLine(profile)}

---

[Professional summary — see summary instructions]

## EXPERIENCE

### Role — Company
Start — End
- Achievement bullet

### Company
**Most recent title** · Start — End
- Achievement bullet
**Earlier title** · Start — End
- Achievement bullet

## EDUCATION

### Degree or Certification — School
Year · Details

## SKILLS

Skill one · Skill two · Skill three
</format>

${describeJobAnalysis(jobAnalysis)}

<profile>
${JSON.stringify(profile, null, 2)}
</profile>

<selected_resume_evidence>
${JSON.stringify(selectedEvidence, null, 2)}
</selected_resume_evidence>

<job_description>
${instructions || "Create a concise, results-focused one-page resume from the selected evidence."}
</job_description>

<instructions>
Return only markdown. Use the exact heading style shown in the format.
Use only the selected resume evidence and profile. Do not include excluded work history.
Write to show straightforward fit for the target role, not generic impressiveness.
Prefer measurable, plain-language bullets. Do not invent employers, dates, schools, tools, metrics, or responsibilities not present in the provided data.
Work history dates are stored as numeric months ("01"-"12") and years ("2020", or "present"). Format them for the resume as readable ranges like "March 2020 — Present".${continuityInstruction}

Experience section:
- List roles most-recent-first.
- Each selectedBullets entry has "text" (the detail) and "supports" (the job responsibility or requirement it evidences). Render only the text as the bullet line; "supports" exists so you understand why the order matters.
- KEEP each role's bullets in the given order — they are already ranked most-applicable-first for this job. The first bullet under every role must be its strongest evidence for the target role. You may tighten wording, but do not reorder, merge away, or bury the leading bullets.
- When multiple selected roles share one employer, render them as a SINGLE company block: one "### Company" heading followed by each title with its own dates (most recent first), as shown in the format. This presents internal promotions as one continuous, growing tenure rather than separate jobs.
- When two roles overlap in time, lead with the one already tagged the stronger fit (or the primary); do not give equal space to a concurrent secondary role.
- Allocate bullets by recency and the role's "fit" tier: "strong" recent roles get the most bullets; "supporting" roles get a few; a "timeline-only" role gets its title and dates and at most one concise line — never pad it. This keeps the resume suitable for the target job while the timeline stays continuous.

Skills section:
- List only hands-on skills, tools, and methods from the selected evidence. Never list a degree, school, or other education credential as a skill — education appears ONLY under EDUCATION.

Professional title (the line directly under the name):
- The title line states what the candidate HAS ACTUALLY BEEN — it is a fact about their history, not a label for the job they want. NEVER use the target job's title (or a trivial variant of it) unless a role in the selected evidence carries that exact title.
- Build it from the candidate's real titles${profile.headline ? ` or their saved headline "${profile.headline}"` : ""}, most recent experience first. You may append a short truthful specialty qualifier that points toward the target role's domain when the selected evidence supports it (e.g. "Product Manager — Analytics & Experimentation" for a data-focused target), but the base identity must be real.
- Keep it a concise title, not a sentence.
- If no job description is provided, use ${profile.headline || jobAnalysis?.position ? `"${profile.headline || jobAnalysis.position}"` : "a concise professional title drawn from the strongest, most recent experience"}.

Professional summary (the line under the divider):
- Write 2-3 sentences that argue fit through the job's key responsibilities, not through a claimed identity. Never open with the target job title as if the candidate already holds it (e.g. do NOT write "Data Scientist with 8 years..." unless a selected role carries that title).
- Open with the candidate's real professional identity, then connect their strongest selected evidence directly to the most central key responsibilities in job_requirements — the reader should finish the summary thinking "they have already done the core of this job", not "they claim to be one of these".
- Anchor it with one or two of the strongest, most relevant achievements from the selected evidence, with real metrics where available.
- Mirror the job description's own wording for skills and requirements ONLY where the selected evidence actually demonstrates them, so it passes recruiter scanning and ATS keyword matching without overstating. Do not invent qualifications, years of experience, tools, or outcomes.
- Mention education only when it clearly satisfies an education requirement stated in the job description; when the match is partial or borderline, leave it to the EDUCATION section rather than spotlighting it in the summary.
</instructions>`;
}

/* ── Job description scraping helpers ───────────────────────── */
export function extractJobDescription({ title, metaDescription, rawText }) {
  return `<task>
Extract and print out just the core job description from the provided raw page text.
</task>

${title ? `<page_title>${title}</page_title>\n` : ""}${metaDescription ? `<meta_description>${metaDescription}</meta_description>\n` : ""}
<raw_content>
${rawText}
</raw_content>

<instructions>
Please extract the core job description, including:
- Role overview
- Responsibilities and tasks
- Requirements, qualifications, and skills
- Benefits and company details (if relevant)

Remove any unrelated page elements like navigation bars, sidebars, header/footer links, social sharing widgets, cookie notices, or other boilerplate content.

Your response must be a valid JSON object wrapped in <json_output> and </json_output> XML tags.
The JSON object must contain exactly one key: "jobDescription".

Format the response exactly like this:
<json_output>
{
  "jobDescription": "Extracted and clean job description markdown here..."
}
</json_output>

Remember to output ONLY the XML-wrapped JSON. No explanations, no introductory text, no conversational text.
</instructions>`;
}

export function extractCleanedJobDescription(text) {
  const match = text.match(/<json_output>([\s\S]*?)<\/json_output>/i);
  const jsonString = match ? match[1].trim() : text;

  try {
    let cleanedJsonString = jsonString;
    if (cleanedJsonString.startsWith("```")) {
      cleanedJsonString = cleanedJsonString.replace(/^```(?:json)?\s*\n/, "").replace(/\n```$/, "");
    }
    const data = JSON.parse(cleanedJsonString);
    if (data && typeof data === "object" && typeof data.jobDescription === "string") {
      return data.jobDescription.trim();
    }
  } catch (error) {
    console.warn("Failed to parse extracted JSON, falling back to regex block or raw text", error);
  }

  // Fallback if JSON parsing failed: if XML tags existed, return their content directly, or return the whole text stripped of tags
  const textWithoutTags = text.replace(/<\/?[a-zA-Z0-9_]+>/g, "").trim();
  return textWithoutTags;
}

export function collapseBlankLines(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/(?:[ \t]*\n){2,}[ \t]*/g, "\n");
}
