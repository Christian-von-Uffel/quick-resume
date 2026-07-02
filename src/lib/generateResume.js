import { getVisibleContactLine } from "./resumeModel";

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

export function selectBestFittingExperience({ profile, workHistory, instructions }) {
  return `<task>
Select the resume evidence that best shows the candidate is a straightforward fit for the target role.
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

<selection_policy>
Prefer direct evidence of fit over general impressiveness.
Select roles, bullets, skills, tools, and outcomes that clearly match the target job's responsibilities and requirements.
Exclude experience that is impressive but does not help a hiring manager quickly see role fit.
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

export function generateResume({ profile, selectedEvidence, instructions, jobTitle }) {
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
Work history dates are stored as numeric months ("01"-"12") and years ("2020", or "present"). Format them for the resume as readable ranges like "March 2020 — Present".
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
