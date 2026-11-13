import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

// What each checklist stage is for, under its label in the open checklist.
const STAGE_DETAIL = {
  import: "Bring in your resumes",
  polish: "Clear up the wording on every role",
  interview: "Bring out work you haven't written down",
  match: "Add a job and check what it asks for",
  apply: "Generate, download, and apply",
};

// Elements marked data-path-toggle open and close the checklist themselves
// (the header's Job-ready button), so a press on them isn't an outside click.
const PATH_TOGGLE_ATTR = "data-path-toggle";

function StageMark({ state, number, size = "sm" }) {
  const box = size === "sm" ? "h-5 w-5 text-[10px]" : "h-6 w-6 text-xs";
  if (state === "done") {
    return (
      <span className={`flex ${box} shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white`}>
        <svg className="h-3/5 w-3/5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={`flex ${box} shrink-0 items-center justify-center rounded-full font-semibold tabular-nums ${
        state === "current"
          ? "bg-amber-400 text-neutral-950 ring-4 ring-amber-400/20"
          : "border border-neutral-600 text-neutral-500"
      }`}
    >
      {number}
    </span>
  );
}

// The happy path as the "Job-ready checklist". Minimized it's one card: the
// five stages as check marks, which step you're on, and its name. Pressing the
// card (or the header's Job-ready button) pops the full checklist open over the page, with the next
// step's action and skip under its stage. Lives at the top of the Work, Create,
// and Resumes screens.
export function NextStepBar({
  step,
  stageStates,
  busyLabel = "",
  open = false,
  onOpenChange,
  onPrimary,
  onSkip,
  onResumesTab = false,
}) {
  const { title, detail, primary, skip } = describeStep(step, { onResumesTab });
  const doneCount = stageStates.filter((state) => state === "done").length;
  const stepNumber = stageStates.indexOf("current") + 1;
  const rootRef = useRef(null);
  const [panelMaxHeight, setPanelMaxHeight] = useState(null);

  // The card is pinned at the top of a scrolling screen, so the open checklist
  // can't be scrolled into view with the page: fit it to the room below the
  // card (down to the screen's scroll area, or the window) and let it scroll.
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const root = rootRef.current;
      if (!root) return;
      let bottom = window.innerHeight;
      for (let el = root.parentElement; el; el = el.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
          bottom = Math.min(bottom, el.getBoundingClientRect().bottom);
          break;
        }
      }
      setPanelMaxHeight(Math.max(200, bottom - root.getBoundingClientRect().bottom - 16));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event) => {
      if (rootRef.current?.contains(event.target)) return;
      if (event.target.closest?.(`[${PATH_TOGGLE_ATTR}]`)) return;
      onOpenChange?.(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") onOpenChange?.(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <section ref={rootRef} aria-label="Job-ready checklist" className="relative z-20">
      <button
        type="button"
        onClick={() => onOpenChange?.(!open)}
        aria-expanded={open}
        className={`flex w-full items-center gap-3 rounded-xl border bg-neutral-950 px-3 py-2.5 text-left shadow-lg shadow-black/10 transition-colors ${
          open ? "border-amber-500/60" : "border-amber-500/30 hover:border-amber-500/60"
        }`}
      >
        <ol className="flex shrink-0 items-center" aria-label={`${doneCount} of ${PATH_STAGES.length} steps done`}>
          {PATH_STAGES.map((stage, index) => (
            <li key={stage.key} className="flex items-center" aria-current={stageStates[index] === "current" ? "step" : undefined}>
              {index > 0 && (
                <span
                  className={`h-0.5 w-2 sm:w-3 ${stageStates[index - 1] === "done" ? "bg-emerald-500" : "bg-neutral-700"}`}
                />
              )}
              <span title={stage.label}>
                <StageMark state={stageStates[index]} number={index + 1} />
              </span>
            </li>
          ))}
        </ol>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium uppercase tracking-widest text-amber-600 dark:text-amber-300">
            {/* Phones have room for the name only; the circles show the step. */}
            <span className="sm:hidden">Job-ready</span>
            <span className="hidden sm:inline">
              Job-ready checklist{stepNumber > 0 && ` · Step ${stepNumber} of ${PATH_STAGES.length}`}
            </span>
          </span>
          <span className="block truncate text-sm font-semibold text-neutral-100">{title}</span>
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div
          style={{ maxHeight: panelMaxHeight ?? undefined }}
          className="absolute inset-x-0 top-full mt-2 overflow-y-auto overscroll-contain rounded-xl border border-neutral-700 bg-neutral-950 p-4 shadow-2xl shadow-black/40 pagefit-scrollbar">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-neutral-100">Job-ready checklist</p>
            <p className="shrink-0 text-xs tabular-nums text-neutral-500">
              {doneCount} of {PATH_STAGES.length} done
            </p>
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            Five steps from your old resumes to a tailored application. Skip any of them.
          </p>

          <ol className="mt-4">
            {PATH_STAGES.map((stage, index) => {
              const state = stageStates[index];
              const isLast = index === PATH_STAGES.length - 1;
              return (
                <li key={stage.key} className="flex gap-3" aria-current={state === "current" ? "step" : undefined}>
                  <div className="flex flex-col items-center">
                    <StageMark state={state} number={index + 1} size="md" />
                    {!isLast && (
                      <span className={`my-1 w-0.5 flex-1 ${state === "done" ? "bg-emerald-500/60" : "bg-neutral-800"}`} />
                    )}
                  </div>
                  <div className={`min-w-0 flex-1 ${isLast ? "" : "pb-4"}`}>
                    <p
                      className={`text-sm leading-6 ${
                        state === "current"
                          ? "font-semibold text-neutral-100"
                          : state === "done"
                            ? "text-neutral-400"
                            : "text-neutral-300"
                      }`}
                    >
                      {stage.label}
                      {state === "done" && <span className="ml-2 text-xs font-normal text-emerald-500">Done</span>}
                    </p>
                    {state === "current" ? (
                      <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                        <p className="text-sm font-medium text-neutral-100">{title}</p>
                        <p className="mt-0.5 text-xs text-neutral-500">{detail}</p>
                        {(primary || skip) && (
                          <div className="mt-3 flex items-center gap-3">
                            {primary && (
                              <button
                                type="button"
                                onClick={() => {
                                  onOpenChange?.(false);
                                  onPrimary?.();
                                }}
                                disabled={Boolean(busyLabel)}
                                className="rounded-lg border border-amber-500/50 bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-500/25 disabled:cursor-wait disabled:opacity-60 dark:text-amber-200"
                              >
                                {busyLabel || primary}
                              </button>
                            )}
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
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-neutral-500">{STAGE_DETAIL[stage.key]}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
