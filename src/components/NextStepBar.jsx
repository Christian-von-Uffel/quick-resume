import { PATH_STAGES } from "../lib/happyPath";

const roleLabel = (item) => [item.position.trim(), item.company.trim()].filter(Boolean).join(", ");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// What the bar says for each step from lib/happyPath. `primary` is the button
// label (null = no button), `skip` the quiet link that moves past the step.
function describeStep(step, { onResumesTab }) {
  switch (step.key) {
    case "polish":
      return {
        title: `Polish wording: ${roleLabel(step.work)}`,
        detail: `Clears up hard-to-read sentences in what you wrote. ${step.done} of ${step.total} roles done.`,
        primary: "Polish this role",
        skip: "Skip this role",
      };
    case "interview":
      return {
        title: `Interview me: ${roleLabel(step.work)}`,
        detail: `Quick questions bring out work you haven't written down, in your own words. ${step.done} of ${step.total} roles done.`,
        primary: "Start interview",
        skip: "Skip this role",
      };
    case "job":
      return {
        title: "Add the job you're applying for",
        detail: "Paste the job description, or its link.",
        primary: "Add a job",
      };
    case "check":
      return {
        title: "Check for missing requirements",
        detail: "Shows what this job asks for that your experience already covers, and asks where you did the rest.",
        primary: "Check requirements",
        skip: "Skip",
      };
    case "answer":
      return {
        title: `Answer ${plural(step.count, "question")}`,
        detail: "Say yes where you've done it, pick the role, then save. Every future resume can use it too.",
        primary: "Show questions",
        skip: "I'm done",
      };
    case "generate":
      return {
        title: "Generate your resume",
        detail: "Picks the strongest true evidence from your experience for this job.",
        primary: "Generate resume",
      };
    case "download":
      return {
        title: "Download your PDF",
        detail: onResumesTab ? "Check the preview, then download." : "Your resume for this job is ready.",
        primary: onResumesTab ? "Download PDF" : "Open your resume",
      };
    default:
      return {
        title: "Apply",
        detail: step.jobUrl
          ? "Upload your PDF on the job posting. It's saved in Resumes."
          : "Upload your PDF wherever the job is posted. It's saved in Resumes.",
        primary: step.jobUrl ? "Open the job posting" : null,
      };
  }
}

// The one next thing to do on the happy path, with a five-stage rail showing
// where it sits. Lives at the top of the Work, Create, and Resumes screens.
export function NextStepBar({ step, stageStates, busyLabel = "", onPrimary, onSkip, onResumesTab = false }) {
  const { title, detail, primary, skip } = describeStep(step, { onResumesTab });

  return (
    <section
      aria-label="Next step"
      className="rounded-xl border border-amber-500/30 bg-neutral-950 p-3 shadow-lg shadow-black/10 sm:p-4"
    >
      <ol className="flex gap-1.5" aria-label="Progress">
        {PATH_STAGES.map((stage, index) => {
          const state = stageStates[index];
          return (
            <li key={stage.key} className="min-w-0 flex-1" aria-current={state === "current" ? "step" : undefined}>
              <span
                className={`block h-1 rounded-full ${
                  state === "done" ? "bg-emerald-500" : state === "current" ? "bg-amber-400" : "bg-neutral-700"
                }`}
              />
              <span
                className={`mt-1 block truncate text-[11px] ${
                  state === "current" ? "font-medium text-neutral-100" : "text-neutral-500"
                }`}
              >
                {state === "done" ? "✓ " : ""}
                {stage.label}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neutral-100">{title}</p>
          <p className="mt-0.5 text-xs text-neutral-500">{detail}</p>
        </div>
        {(primary || skip) && (
          <div className="flex shrink-0 items-center gap-3">
            {skip && (
              <button
                type="button"
                onClick={onSkip}
                disabled={Boolean(busyLabel)}
                className="text-xs text-neutral-500 underline-offset-2 transition-colors hover:text-neutral-200 hover:underline disabled:opacity-50"
              >
                {skip}
              </button>
            )}
            {primary && (
              <button
                type="button"
                onClick={onPrimary}
                disabled={Boolean(busyLabel)}
                className="flex-1 rounded-lg border border-amber-500/50 bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-500/25 disabled:cursor-wait disabled:opacity-60 sm:flex-none dark:text-amber-200"
              >
                {busyLabel || primary}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
