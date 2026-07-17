import { formatRoleWindow } from "./generateResume";

// Pure helpers for the prompt lab (src/components/PromptLab.jsx): the
// challenger prompt templates the lab seeds its editors with, the `$name`
// substitution that turns a template plus the person's real data into a
// sendable prompt, and the adapter that lets a minimal challenger schema flow
// through the PRODUCTION validators and UI components.
//
// Challengers are deliberately NOT entries in src/lib/prompts.js. That catalog
// is the versioned record of what production ships; a lab prompt is an
// experiment, so its calls go out with no promptKey and land in llm_calls with
// prompt_id null (see app/(product)/app/lab/page.jsx).

/* ── Template rendering ────────────────────────────────────── */
// Replace `$name` tokens with values. Longest names first, so `$jobTitle`
// is never half-eaten by a shorter `$job`. split/join instead of a regex
// replace keeps `$` characters inside VALUES (salaries, "$100k") literal.
// Unknown tokens stay in the text on purpose — the lab shows the exact prompt
// it sent, so a typo'd placeholder is visible instead of silently blank.
export function renderPromptTemplate(template, variables = {}) {
  let text = String(template ?? "");
  const names = Object.keys(variables).sort((a, b) => b.length - a.length);
  for (const name of names) {
    text = text.split(`$${name}`).join(String(variables[name] ?? ""));
  }
  return text;
}

/* ── Placeholder values from the person's real data ────────── */
// The whole work history as plain readable text — the "what you'd know about
// their work experience" a challenger presents instead of production's
// JSON.stringify dump.
export function formatWorkHistoryForPrompt(workHistory) {
  const items = (workHistory ?? []).filter(
    (item) => item && (item.position || item.company || item.description)
  );
  if (!items.length) return "(no work history saved)";

  return items
    .map((item) => {
      const heading = [item.position || "Untitled role", item.company ? `at ${item.company}` : ""]
        .filter(Boolean)
        .join(" ");
      const window = formatRoleWindow(item);
      const description = String(item.description ?? "").trim();
      return [`${heading}${window ? ` (${window})` : ""}`, description]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export function formatProfileForPrompt(profile) {
  if (!profile) return "(no profile saved)";
  const contact = [profile.email, profile.phone, profile.location, profile.linkedin, profile.github, profile.website]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" · ");
  const education = (profile.education ?? [])
    .map((item) =>
      [item.degree, item.school, item.year].map((value) => String(value ?? "").trim()).filter(Boolean).join(" — ")
    )
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");

  const lines = [
    `Name: ${profile.name || "(not set)"}`,
    profile.headline ? `Headline: ${profile.headline}` : "",
    contact ? `Contact: ${contact}` : "",
    education ? `Education:\n${education}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/* ── Challenger schema → production shapes ─────────────────── */
// The minimal challengers return `{ "questions": ["..."] }` — bare strings.
// Production's question normalizer keeps only objects (a plain string has no
// kind and no options, so it would drop to zero and the flow would look
// broken for the wrong reason). Since these challengers explicitly ask for
// yes-or-no questions, a bare string IS a yes/no question — so wrap it as
// one, and give a `{ question }` object with no kind and no options the same
// treatment. Anything richer passes through untouched, so a challenger that
// grows kinds and options later keeps working.
export function adaptChallengerQuestions(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  if (!Array.isArray(parsed.questions)) return parsed;

  const questions = parsed.questions.map((entry) => {
    if (typeof entry === "string") return { kind: "yes_no", question: entry };
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      !entry.kind &&
      !(Array.isArray(entry.options) && entry.options.length >= 2)
    ) {
      return { ...entry, kind: "yes_no" };
    }
    return entry;
  });

  return { ...parsed, questions };
}

/* ── Challenger seeds ──────────────────────────────────────────
   What the lab's challenger editors start out holding. The expand seed is
   Christian's prompt verbatim; the gap seed is the same prompt with the job
   description added ("this title" becomes "this job" — the title now lives
   inside the posting). The clarity and generate seeds carry the same minimal
   style to the other two flows; clarity keeps the production schema's key
   names so its output can drive the real review UI. All of them are just
   starting text — every run reads whatever is in the editor. */

export const CHALLENGER_SEEDS = {
  clarity: `<Prompt>

<JobTitle>$jobTitle</JobTitle>

<ExperienceDetails>$experienceDetails</ExperienceDetails>

<Query>If you were reading this work experience on a resume, which sentences would you find hard to understand? For each one, copy the sentence exactly as written, ask in plain words what the person meant, and offer two or three plain readings of what it could mean.</Query>

<ExampleSchema>
{
  "confusingSentences": [
    {
      "sentence": "The exact sentence, copied verbatim.",
      "question": "What do you mean by \\"...\\"?",
      "options": [
        "One plain reading of the sentence.",
        "Another plain reading."
      ]
    }
  ]
}
</ExampleSchema>

</Prompt>`,

  expand: `<Prompt>

<JobTitle>$jobTitle</JobTitle>

<ExperienceDetails>$experienceDetails</ExperienceDetails>

<Query>If you were interviewing a person for this title and knew this about their work experience, what are 3 yes or no questions you would ask?</Query>

<ExampleSchema>
{
  "questions": [
    "Question 1",
    "Question 2",
    "Question 3"
  ]
}
</ExampleSchema>

</Prompt>`,

  gap: `<Prompt>

<ExperienceDetails>$workHistory</ExperienceDetails>

<JobDescription>$jobDescription</JobDescription>

<Query>If you were interviewing a person for this job and knew this about their work experience, what are 3 yes or no questions you would ask?</Query>

<ExampleSchema>
{
  "questions": [
    "Question 1",
    "Question 2",
    "Question 3"
  ]
}
</ExampleSchema>

</Prompt>`,

  generate: `<Prompt>

<Profile>$profile</Profile>

<WorkHistory>$workHistory</WorkHistory>

<JobDescription>$jobDescription</JobDescription>

<Query>Write this person's resume for this job as clean markdown: their name and contact line, a short professional summary, their experience with dates and bullet points, education, and skills. Use only facts from the profile and work history. Never invent anything.</Query>

</Prompt>`,
};

// What each feature's templates may reference, shown as a legend under the
// editor. Values are filled from the person's saved data and the lab's inputs.
export const CHALLENGER_PLACEHOLDERS = {
  clarity: [
    ["$jobTitle", "the selected position's title"],
    ["$company", "the selected position's company"],
    ["$experienceDetails", "the experience description being reviewed"],
  ],
  expand: [
    ["$jobTitle", "the selected position's title"],
    ["$company", "the selected position's company"],
    ["$experienceDetails", "the experience description being expanded"],
    ["$tenure", "roughly how long they've held the role"],
  ],
  gap: [
    ["$workHistory", "every saved role with dates and details"],
    ["$jobDescription", "the pasted job description"],
  ],
  generate: [
    ["$profile", "name, headline, contact, education"],
    ["$workHistory", "every saved role with dates and details"],
    ["$jobDescription", "the pasted job description"],
  ],
};
