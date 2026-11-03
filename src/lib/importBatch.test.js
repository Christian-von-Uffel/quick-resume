import { describe, it, expect, vi } from "vitest";
import {
  BURST_RETRY_DELAY_MS,
  applyProfileUpdates,
  describeBatchProgress,
  describeBatchSummary,
  mergeBatchWorkHistory,
  pickProfileUpdates,
  resumeRecency,
  runImportBatch,
} from "./importBatch";
import { UsageLimitError } from "./llm";

const role = (position, company, startYear, endYear, description = "") => ({
  position,
  company,
  startMonth: "01",
  startYear,
  endMonth: endYear === "present" ? "" : "12",
  endYear,
  description,
});

// Three resumes from different years of the same career. The 2019 and 2024
// resumes both list Novara; 2024 and the cover-letter-ish PDF both list Meridian.
const RESUME_2019 = [
  role("Product Manager", "Novara", "2018", "present", "Launched the payments roadmap."),
  role("Associate PM", "Brightline", "2016", "2017", "Ran sprint planning."),
];
const RESUME_2024 = [
  role("Senior Product Manager", "Meridian Health", "2022", "present", "Led the intake redesign."),
  role("Product Manager", "Novara", "2018", "present", "Launched the payments roadmap.\nGrew activation 12%."),
];
const RESUME_2024_COPY = [role("Senior Product Manager", "Meridian Health", "2022", "present", "Led the intake redesign.")];

const file = (name) => ({ name, type: "application/pdf" });

describe("mergeBatchWorkHistory", () => {
  it("folds a role repeated across files into one entry instead of adding it twice", () => {
    let history = [];
    const counts = [];
    for (const imported of [RESUME_2019, RESUME_2024, RESUME_2024_COPY]) {
      const result = mergeBatchWorkHistory(history, imported);
      history = result.workHistory;
      counts.push({ added: result.added, matched: result.matched });
    }

    expect(history.map((item) => `${item.position} @ ${item.company}`)).toEqual([
      "Senior Product Manager @ Meridian Health",
      "Product Manager @ Novara",
      "Associate PM @ Brightline",
    ]);
    expect(counts).toEqual([
      { added: 2, matched: 0 },
      { added: 1, matched: 1 },
      { added: 0, matched: 1 },
    ]);
  });

  it("keeps the extra bullet a later resume adds to a matched role", () => {
    const first = mergeBatchWorkHistory([], RESUME_2019).workHistory;
    const merged = mergeBatchWorkHistory(first, RESUME_2024).workHistory;
    const novara = merged.find((item) => item.company === "Novara");
    expect(novara.description).toContain("Grew activation 12%.");
  });

  it("gives the same result whichever order the files arrive in", () => {
    const names = (history) => history.map((item) => `${item.position} @ ${item.company}`).sort();
    const forward = [RESUME_2019, RESUME_2024].reduce((h, r) => mergeBatchWorkHistory(h, r).workHistory, []);
    const backward = [RESUME_2024, RESUME_2019].reduce((h, r) => mergeBatchWorkHistory(h, r).workHistory, []);
    expect(names(forward)).toEqual(names(backward));
  });
});

describe("resumeRecency", () => {
  it("ranks a resume with a current role above one that ended", () => {
    expect(resumeRecency(RESUME_2024)).toBeGreaterThan(resumeRecency([role("PM", "Old Co", "2014", "2016")]));
  });

  it("falls back to start dates and scores an undated resume lowest", () => {
    expect(resumeRecency([{ position: "PM", startYear: "2020", startMonth: "03" }])).toBeGreaterThan(0);
    expect(resumeRecency([{ position: "PM" }])).toBe(0);
    expect(resumeRecency(undefined)).toBe(0);
  });
});

describe("pickProfileUpdates", () => {
  it("keeps contact details from the more recent resume when an older one arrives later", () => {
    const newer = pickProfileUpdates({ email: "new@example.com", phone: "555-0200" }, 202401);
    const older = pickProfileUpdates(
      { email: "old@example.com", phone: "", headline: "Analyst" },
      201612,
      newer.claimed
    );
    expect(older.fields).toEqual({ headline: "Analyst" });
  });

  it("lets a more recent resume overwrite an older one, and ties go to the later file", () => {
    const older = pickProfileUpdates({ email: "old@example.com" }, 201612);
    expect(pickProfileUpdates({ email: "new@example.com" }, 202401, older.claimed).fields).toEqual({
      email: "new@example.com",
    });
    expect(pickProfileUpdates({ email: "same@example.com" }, 201612, older.claimed).fields).toEqual({
      email: "same@example.com",
    });
  });

  it("never writes empty values or education as a field", () => {
    expect(pickProfileUpdates({ name: "", education: [{ school: "MIT" }] }, 1).fields).toEqual({});
  });
});

describe("applyProfileUpdates", () => {
  it("overwrites chosen fields and merges education without dropping existing entries", () => {
    const profile = { name: "Ana", email: "a@example.com", education: [{ id: "e1", school: "MIT", degree: "BS" }] };
    const next = applyProfileUpdates(profile, { email: "b@example.com" }, [{ school: "Stanford", degree: "MBA" }]);
    expect(next.name).toBe("Ana");
    expect(next.email).toBe("b@example.com");
    expect(next.education.map((item) => item.school).sort()).toEqual(["MIT", "Stanford"]);
  });
});

describe("runImportBatch", () => {
  const noWait = () => Promise.resolve();

  it("reads files in order and keeps going past a bad one", async () => {
    const seen = [];
    const summary = await runImportBatch([file("a.pdf"), file("broken.pdf"), file("c.pdf")], {
      extract: async (f) => {
        seen.push(f.name);
        if (f.name === "broken.pdf") throw new Error("The model did not return JSON.");
        return f.name;
      },
      apply: (extraction) => (extraction === "a.pdf" ? { added: 2, matched: 0 } : { added: 1, matched: 1 }),
      wait: noWait,
    });

    expect(seen).toEqual(["a.pdf", "broken.pdf", "c.pdf"]);
    expect(summary.files.map((r) => r.status)).toEqual(["imported", "failed", "imported"]);
    expect(summary.files[1].error).toBe("The model did not return JSON.");
    expect(summary).toMatchObject({ imported: 2, failed: 1, skipped: 0, added: 3, matched: 1, stoppedBy: null });
  });

  it("stops at the usage cap, keeps what already merged and skips the rest unsent", async () => {
    const extract = vi.fn(async (f) => {
      if (f.name === "3.pdf") {
        throw new UsageLimitError("Your free trial includes 25 resume imports.", { reason: "quota", upgrade: true });
      }
      return f.name;
    });
    const apply = vi.fn(() => ({ added: 1, matched: 0 }));

    const summary = await runImportBatch(["1.pdf", "2.pdf", "3.pdf", "4.pdf"].map(file), {
      extract,
      apply,
      wait: noWait,
    });

    expect(extract).toHaveBeenCalledTimes(3);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(summary.files.map((r) => r.status)).toEqual(["imported", "imported", "failed", "skipped"]);
    expect(summary.stoppedBy).toEqual({ message: "Your free trial includes 25 resume imports.", upgrade: true });
    expect(summary.added).toBe(2);
  });

  it("pauses and retries the same file when the per-minute burst limit hits", async () => {
    let calls = 0;
    const wait = vi.fn(() => Promise.resolve());
    const phases = [];
    const summary = await runImportBatch([file("a.docx")], {
      extract: async () => {
        calls += 1;
        if (calls === 1) throw new UsageLimitError("Slow down.", { reason: "burst" });
        return "ok";
      },
      apply: () => ({ added: 1, matched: 0 }),
      onProgress: ({ phase }) => phases.push(phase),
      wait,
    });

    expect(wait).toHaveBeenCalledWith(BURST_RETRY_DELAY_MS);
    expect(phases).toEqual(["reading", "waiting", "reading"]);
    expect(summary.files[0].status).toBe("imported");
  });

  it("gives up on a file after repeated burst limits but still reads the next one", async () => {
    const summary = await runImportBatch([file("a.pdf"), file("b.pdf")], {
      extract: async (f) => {
        if (f.name === "a.pdf") throw new UsageLimitError("Slow down.", { reason: "burst" });
        return f.name;
      },
      apply: () => ({ added: 1, matched: 0 }),
      wait: noWait,
      maxBurstRetries: 2,
    });

    expect(summary.files.map((r) => r.status)).toEqual(["failed", "imported"]);
    expect(summary.files[0].error).toBe("Slow down.");
  });

  it("treats a failure while merging like a failed file", async () => {
    const summary = await runImportBatch([file("a.pdf")], {
      extract: async () => "x",
      apply: () => {
        throw new Error("merge broke");
      },
      wait: noWait,
    });
    expect(summary.files[0]).toMatchObject({ status: "failed", error: "merge broke" });
  });
});

describe("batch copy", () => {
  it("describes progress as 'Reading N of M: name…'", () => {
    expect(describeBatchProgress({ index: 1, total: 4, file: file("resume_2019.pdf"), phase: "reading" })).toBe(
      "Reading 2 of 4: resume_2019.pdf…"
    );
    expect(describeBatchProgress({ index: 0, total: 1, file: file("cv.pdf"), phase: "reading" })).toBe(
      "Reading cv.pdf…"
    );
  });

  it("summarizes roles added and matched", () => {
    expect(
      describeBatchSummary({ files: [{}, {}, {}], imported: 3, added: 4, matched: 2 })
    ).toBe("4 new roles added from 3 resumes, 2 duplicates merged into existing roles.");
    expect(describeBatchSummary({ files: [{}], imported: 1, added: 1, matched: 0 })).toBe("1 new role added.");
    expect(describeBatchSummary({ files: [{}, {}], imported: 0, added: 0, matched: 0 })).toBe(
      "None of those resumes could be imported."
    );
  });
});
