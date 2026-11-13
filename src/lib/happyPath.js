// The guided happy path: import your resumes → polish the wording on every
// role → interview every role for what's missing → match it to a job → apply.
// The next step is derived, never stored: the two passes read the per-role
// polishedAt / interviewedAt stamps (saved with the profile), and the job steps
// read this session's job-description work, keyed by the description's text so
// pasting a new job starts its steps over.

export const PATH_STAGES = [
  { key: "import", label: "Import" },
  { key: "polish", label: "Polish" },
  { key: "interview", label: "Interview" },
  { key: "match", label: "Match" },
  { key: "apply", label: "Apply" },
];

// Polish wording needs sentences to read; Interview me needs a title to ask about.
export const canPolishRole = (item) => Boolean(item?.description?.trim());
export const canInterviewRole = (item) => Boolean(item?.position?.trim());

const hasContent = (item) =>
  Boolean(item?.position?.trim() || item?.company?.trim() || item?.description?.trim());

// One pass over the roles, in the order given (the app passes most recent
// first): how many roles it applies to, how many are finished, and the next.
export function getRolePass(workHistory, pass) {
  const applies = pass === "polish" ? canPolishRole : canInterviewRole;
  const stamp = pass === "polish" ? "polishedAt" : "interviewedAt";
  const roles = (workHistory ?? []).filter(applies);
  const done = roles.filter((item) => item[stamp]).length;
  return { total: roles.length, done, next: roles.find((item) => !item[stamp]) ?? null };
}

// The job work this session has done, as the app tracks it:
//   job          the description the record belongs to (trimmed)
//   checked      "Check for missing requirements" ran (or was skipped)
//   answered     the person finished with the questions (or skipped them)
//   resumeId     the resume generated for this job
//   downloaded   that resume's PDF was exported
export const EMPTY_JOB_PROGRESS = { job: "", checked: false, answered: false, resumeId: null, downloaded: false };

export function jobProgressFor(progress, jobDescription) {
  const job = (jobDescription ?? "").trim();
  return progress?.job === job ? progress : { ...EMPTY_JOB_PROGRESS, job };
}

// The single next step. `from: "job"` starts at the job steps, for the Create
// and Resumes tabs, where the person has already chosen to work on a job.
export function getNextPathStep(
  { workHistory = [], jobDescription = "", jobProgress = EMPTY_JOB_PROGRESS, openQuestions = 0, jobUrl = "" },
  { from = "start" } = {}
) {
  if (from === "start") {
    if (!workHistory.some(hasContent)) return { stage: "import", key: "import" };
    for (const pass of ["polish", "interview"]) {
      const { total, done, next } = getRolePass(workHistory, pass);
      if (next) return { stage: pass, key: pass, work: next, done, total };
    }
  }

  const job = jobProgressFor(jobProgress, jobDescription);
  if (!job.job) return { stage: "match", key: "job" };
  if (!job.checked) return { stage: "match", key: "check" };
  if (!job.answered && openQuestions > 0) return { stage: "match", key: "answer", count: openQuestions };
  if (!job.resumeId) return { stage: "apply", key: "generate" };
  if (!job.downloaded) return { stage: "apply", key: "download", resumeId: job.resumeId };
  return { stage: "apply", key: "done", resumeId: job.resumeId, jobUrl: jobUrl.trim() };
}

// Each rail stage as "done" | "current" | "todo" for the step on screen. The
// passes report their own completion, so skipping ahead to a job still shows
// which passes are unfinished.
export function getStageStates(step, workHistory = []) {
  const currentIndex = PATH_STAGES.findIndex((stage) => stage.key === step.stage);
  return PATH_STAGES.map((stage, index) => {
    if (stage.key === step.stage) return "current";
    if (stage.key === "import") return workHistory.some(hasContent) ? "done" : "todo";
    if (stage.key === "polish" || stage.key === "interview") {
      return getRolePass(workHistory, stage.key).next ? "todo" : "done";
    }
    return index < currentIndex ? "done" : "todo";
  });
}
