import { describe, expect, it } from "vitest";
import {
  EMPTY_JOB_PROGRESS,
  getNextPathStep,
  getRolePass,
  getStageStates,
  jobProgressFor,
} from "./happyPath";

const role = (id, extra = {}) => ({
  id,
  position: `Role ${id}`,
  company: "Acme",
  description: "Did things.",
  polishedAt: "",
  interviewedAt: "",
  ...extra,
});
const STAMP = "2026-11-03T12:00:00.000Z";
const JD = "Senior analyst. SQL, dashboards.";

describe("getRolePass", () => {
  it("counts only roles the pass applies to and returns the first unfinished", () => {
    const history = [role("a", { polishedAt: STAMP }), role("b", { description: "" }), role("c")];
    expect(getRolePass(history, "polish")).toMatchObject({ total: 2, done: 1, next: { id: "c" } });
    expect(getRolePass(history, "interview")).toMatchObject({ total: 3, done: 0, next: { id: "a" } });
  });

  it("skips untitled roles for the interview pass", () => {
    const history = [role("a", { position: " " })];
    expect(getRolePass(history, "interview")).toEqual({ total: 0, done: 0, next: null });
  });
});

describe("getNextPathStep", () => {
  it("starts with import when there is no experience", () => {
    expect(getNextPathStep({ workHistory: [] }).key).toBe("import");
    expect(getNextPathStep({ workHistory: [role("a", { position: "", company: "", description: "" })] }).key).toBe(
      "import"
    );
  });

  it("polishes every role before interviewing any", () => {
    const history = [role("a", { polishedAt: STAMP }), role("b")];
    expect(getNextPathStep({ workHistory: history })).toMatchObject({
      stage: "polish",
      work: { id: "b" },
      done: 1,
      total: 2,
    });
    const polished = history.map((item) => ({ ...item, polishedAt: STAMP }));
    expect(getNextPathStep({ workHistory: polished })).toMatchObject({ stage: "interview", work: { id: "a" } });
  });

  const finished = [role("a", { polishedAt: STAMP, interviewedAt: STAMP })];

  it("asks for a job once both passes are done", () => {
    expect(getNextPathStep({ workHistory: finished })).toEqual({ stage: "match", key: "job" });
  });

  it("walks the job steps in order", () => {
    const base = { workHistory: finished, jobDescription: JD };
    const at = (progress, extra = {}) =>
      getNextPathStep({ ...base, jobProgress: { ...EMPTY_JOB_PROGRESS, job: JD, ...progress }, ...extra });

    expect(at({}).key).toBe("check");
    expect(at({ checked: true }, { openQuestions: 2 })).toMatchObject({ key: "answer", count: 2 });
    expect(at({ checked: true }, { openQuestions: 0 }).key).toBe("generate");
    expect(at({ checked: true, answered: true }, { openQuestions: 2 }).key).toBe("generate");
    expect(at({ checked: true, resumeId: "r1" })).toMatchObject({ key: "download", resumeId: "r1" });
    expect(at({ checked: true, resumeId: "r1", downloaded: true }, { jobUrl: " https://jobs.example/1 " })).toEqual({
      stage: "apply",
      key: "done",
      resumeId: "r1",
      jobUrl: "https://jobs.example/1",
    });
  });

  it("starts the job steps over when the description changes", () => {
    const step = getNextPathStep({
      workHistory: finished,
      jobDescription: "A different job",
      jobProgress: { ...EMPTY_JOB_PROGRESS, job: JD, checked: true, resumeId: "r1" },
    });
    expect(step.key).toBe("check");
  });

  it("goes straight to the job steps from the Create tab", () => {
    const step = getNextPathStep({ workHistory: [role("a")], jobDescription: "" }, { from: "job" });
    expect(step).toEqual({ stage: "match", key: "job" });
  });
});

describe("jobProgressFor", () => {
  it("keeps progress for the same description, ignoring surrounding space", () => {
    const progress = { ...EMPTY_JOB_PROGRESS, job: JD, checked: true };
    expect(jobProgressFor(progress, `  ${JD}\n`)).toBe(progress);
    expect(jobProgressFor(progress, "other")).toEqual({ ...EMPTY_JOB_PROGRESS, job: "other" });
  });
});

describe("getStageStates", () => {
  it("marks unfinished passes as todo even after skipping ahead to a job", () => {
    const history = [role("a", { polishedAt: STAMP })];
    const step = getNextPathStep({ workHistory: history }, { from: "job" });
    expect(getStageStates(step, history)).toEqual(["done", "done", "todo", "current", "todo"]);
  });

  it("marks earlier job stages done", () => {
    const history = [role("a", { polishedAt: STAMP, interviewedAt: STAMP })];
    expect(getStageStates({ stage: "apply", key: "generate" }, history)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "current",
    ]);
  });
});
