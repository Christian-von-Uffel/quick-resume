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
// currently-employed timeline. Empty string when there's nothing to require.
export function describeMandatoryRoles(coverage) {
  if (!coverage?.requiredRoles?.length) return "";

  const lines = coverage.requiredRoles.map(({ item, reason }) => {
    const label = REASON_LABELS[reason] ?? "keeps the timeline continuous";
    return `- ${roleIdentity(item)} (${label})`;
  });

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
These roles MUST appear in selectedWorkHistory regardless of how closely they match the target job. They anchor a continuous, current employment record and cover gaps a hiring manager would otherwise question:
${lines.join("\n")}
${notes.length ? `\nContinuity notes:\n${notes.map((note) => `- ${note}`).join("\n")}` : ""}
You still decide which bullets to surface for each role and the overall ordering to best convey fit. Any other older roles should be included only when they add relevant evidence for the target job.
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
</selection_policy>

<instructions>
Return only valid JSON. Do not wrap it in markdown.
Copy selected role metadata exactly from the provided work history.
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

export function validateSelectedResumeEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model did not return valid fit selection JSON.");
  }

  return {
    fitSummary: typeof value.fitSummary === "string" ? value.fitSummary.trim() : "",
    selectedWorkHistory: Array.isArray(value.selectedWorkHistory) ? value.selectedWorkHistory : [],
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
${profile.headline || jobTitle || "Job Title"}
${getVisibleContactLine(profile)}

---

Brief summary.

## EXPERIENCE

### Role — Company
Start — End
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
