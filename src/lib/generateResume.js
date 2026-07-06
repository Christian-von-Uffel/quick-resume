import { getVisibleContactLine } from "./resumeModel";
import { MONTH_OPTIONS } from "./constants";
import { formatMonthSpan } from "./workHistoryTimeline";

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

function bulletsFromDescription(description) {
  return String(description ?? "")
    .split("\n")
    .map((line) => line.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);
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
      selectedBullets: bulletsFromDescription(source.description),
    });
  }

  return { ...selectedEvidence, selectedWorkHistory: selected };
}

export function buildJobTargetPrompt(jobDescription) {
  return `<task>
Extract the company and position from this job description for a saved resume title.
</task>

<job_description>
${jobDescription}
</job_description>

<instructions>
Return only valid JSON. Do not wrap it in markdown.
Use empty strings when the company or position cannot be confidently determined from the job description.
Do not infer missing values from general context.
</instructions>

<schema>
{
  "company": "",
  "position": ""
}
</schema>`;
}

export function validateExtractedJobTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid title JSON.");
  }

  const { company, position } = value;
  if (typeof company !== "string" || typeof position !== "string") {
    throw new Error("The title JSON must include company and position strings.");
  }

  return {
    company: company.trim(),
    position: position.trim(),
  };
}

export function selectBestFittingExperience({ profile, workHistory, instructions, coverage }) {
  return `<task>
Select the resume evidence that best shows the candidate is a straightforward fit for the target role, while keeping the employment timeline continuous.
</task>

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
Always include every role listed in mandatory_roles, even if it is a weaker match, so the resume shows continuous, current employment with no unexplained gaps.
Beyond those, prefer direct evidence of fit over general impressiveness.
Select roles, bullets, skills, tools, and outcomes that clearly match the target job's responsibilities and requirements.
Exclude experience that is impressive but does not help a hiring manager quickly see role fit, unless it is a mandatory role needed for timeline continuity.
Do not invent facts, employers, dates, tools, metrics, schools, or responsibilities.
Do not copy phrases from the job description unless they already appear in the work history.
Keep the selection plain, credible, and specific.
List experience most-recent-first. When several selected roles share one employer, treat them as a single company block showing progression (a promotion history), most recent title first. When roles overlap in time, lead with the primary named in mandatory_roles and keep any concurrent secondary role lighter.
</selection_policy>

<reconciliation>
Tag every selected role with a "fit" tier and let it drive how much space the role gets, so timeline continuity never crowds out suitability:
- "strong": directly matches the target role — lead with these and give them the most bullets.
- "supporting": relevant but secondary — include with a few bullets.
- "timeline-only": required only to keep employment continuous (see mandatory_roles) and a weak match for this job — keep it (never drop it), but minimize it to its title and dates plus at most one concise line; do not pad it with bullets that dilute the resume's focus.
Among roles of equal fit, prefer the more recent one for emphasis and ordering. A mandatory role that genuinely fits the target job should be tagged "strong" or "supporting", not "timeline-only".
</reconciliation>

<instructions>
Return only valid JSON. Do not wrap it in markdown.
Copy selected role metadata exactly from the provided work history.
Tag each selected role with its fit tier: "strong", "supporting", or "timeline-only".
Rewrite selected bullets only when needed for clarity, while preserving the facts from the source material.
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
        "Specific source-grounded bullet that supports the target role."
      ]
    }
  ],
  "selectedSkills": [
    "Relevant skill or tool present in the profile or work history."
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

export function validateSelectedResumeEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid fit selection JSON.");
  }

  const selectedWorkHistory = Array.isArray(value.selectedWorkHistory)
    ? value.selectedWorkHistory.map((role) =>
        role && typeof role === "object" && !Array.isArray(role)
          ? { ...role, fit: normalizeFitTier(role.fit) }
          : role
      )
    : [];

  return {
    fitSummary: typeof value.fitSummary === "string" ? value.fitSummary.trim() : "",
    selectedWorkHistory,
    selectedSkills: Array.isArray(value.selectedSkills) ? value.selectedSkills : [],
    excludedItems: Array.isArray(value.excludedItems) ? value.excludedItems : [],
  };
}

export function generateResume({ profile, selectedEvidence, instructions, jobTitle, coverage }) {
  const continuityInstruction = coverage?.requiredRoles?.length
    ? "\nInclude every role in the selected evidence. Do not drop roles that cover employment gaps or the current position; the work history must read as continuous and up to date."
    : "";
  return `<task>
Generate polished resume markdown for the current resume builder from curated fit evidence.
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
- When multiple selected roles share one employer, render them as a SINGLE company block: one "### Company" heading followed by each title with its own dates (most recent first), as shown in the format. This presents internal promotions as one continuous, growing tenure rather than separate jobs.
- When two roles overlap in time, lead with the one already tagged the stronger fit (or the primary); do not give equal space to a concurrent secondary role.
- Allocate bullets by recency and the role's "fit" tier: "strong" recent roles get the most bullets; "supporting" roles get a few; a "timeline-only" role gets its title and dates and at most one concise line — never pad it. This keeps the resume suitable for the target job while the timeline stays continuous.

Professional title (the line directly under the name):
- Mirror the target role in the job description so a recruiter or ATS instantly sees a match. When the candidate's background genuinely supports it, use the exact role title from the job description.
- Keep it a concise title, not a sentence. An optional short qualifier is fine (e.g. "Senior Product Manager — B2B SaaS & Growth").
- Ground it in the candidate's real experience; never claim a level or specialty the selected evidence does not support.${profile.headline ? `\n- The candidate's saved headline is "${profile.headline}". Use it as a starting point and adapt it toward the target role.` : ""}
- If no job description is provided, use ${profile.headline || jobTitle ? `"${profile.headline || jobTitle}"` : "a concise professional title drawn from the strongest, most recent experience"}.

Professional summary (the line under the divider):
- Write 2-3 sentences positioned as a pitch for this specific role, not a generic bio.
- Lead with the candidate's fit for the target title, then weave in the requirements, skills, and keywords from the job description that the candidate genuinely meets — matching the job's own wording where truthful, so it passes both recruiter scanning and ATS keyword matching.
- Anchor it with one or two of the strongest, most relevant achievements from the selected evidence, with real metrics where available.
- Only mirror job-description language the candidate can actually back up with the selected evidence and profile. Do not invent qualifications, years of experience, tools, or outcomes.
</instructions>`;
}

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
