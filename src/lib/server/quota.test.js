import { describe, it, expect } from "vitest";
import {
  evaluateUsage,
  readLimit,
  normalizeFeature,
  usageWindowStart,
} from "./quota";

// The live plans.limits row, plus the trial keys this feature adds.
const LIMITS = {
  trial_resume_generations: 10,
  trial_tokens: 2_000_000,
  resume_generations_per_month: 50,
  clarity_reviews_per_month: 100,
  job_gap_reviews_per_month: 100,
  resume_imports_per_month: 25,
  tokens_per_month: 15_000_000,
  burst_per_minute: 5,
  max_jd_chars: 30_000,
};

const snapshot = (over = {}) => ({
  featureRuns: 0,
  windowTokens: 0,
  burstCalls: 0,
  runInFlight: false,
  ...over,
});

const decide = (over = {}, { isTrialing = true, feature = "resume_generation", limits = LIMITS } = {}) =>
  evaluateUsage({ feature, isTrialing, limits, snapshot: snapshot(over) });

describe("readLimit", () => {
  it("treats an absent or null key as unlimited so a limit can be lifted by deleting it", () => {
    expect(readLimit(LIMITS, "not_a_key")).toBeNull();
    expect(readLimit({ trial_tokens: null }, "trial_tokens")).toBeNull();
    expect(readLimit({}, undefined)).toBeNull();
  });

  it("keeps zero as a real limit rather than falling through to unlimited", () => {
    expect(readLimit({ trial_resume_generations: 0 }, "trial_resume_generations")).toBe(0);
  });

  it("ignores values that aren't usable numbers", () => {
    expect(readLimit({ a: "10" }, "a")).toBeNull();
    expect(readLimit({ a: -1 }, "a")).toBeNull();
    expect(readLimit({ a: Infinity }, "a")).toBeNull();
  });
});

describe("trial resume cap", () => {
  it("allows the tenth generation and blocks the eleventh", () => {
    expect(decide({ featureRuns: 9 }).allowed).toBe(true);

    const blocked = decide({ featureRuns: 10 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(429);
    expect(blocked.reason).toBe("quota");
    expect(blocked.limit).toBe(10);
    // The gate offers checkout only when subscribing actually lifts the limit.
    expect(blocked.upgrade).toBe(true);
    expect(blocked.error).toMatch(/10 resumes/);
    expect(blocked.error).toMatch(/Subscribe/);
  });

  it("does not block later calls of a run already counted, so a half-built resume still finishes", () => {
    // Three provider calls share one run id; the last two must not be refused
    // just because the run that paid for them was the one that hit the cap.
    expect(decide({ featureRuns: 10, runInFlight: true }).allowed).toBe(true);
  });

  it("uses the paid monthly allowance once the subscription is active", () => {
    expect(decide({ featureRuns: 10 }, { isTrialing: false }).allowed).toBe(true);

    const blocked = decide({ featureRuns: 50 }, { isTrialing: false });
    expect(blocked.allowed).toBe(false);
    expect(blocked.limit).toBe(50);
    // Nothing to upsell an active subscriber; it resets on its own.
    expect(blocked.upgrade).toBeFalsy();
    expect(blocked.error).toMatch(/resets/);
  });

  it("meters each feature separately, so clarity reviews don't spend resume allowance", () => {
    expect(decide({ featureRuns: 40 }, { feature: "clarity_review" }).allowed).toBe(true);
    expect(decide({ featureRuns: 100 }, { feature: "clarity_review" }).allowed).toBe(false);
  });

  it("leaves features with no quota key to the token and burst ceilings", () => {
    expect(decide({ featureRuns: 9999 }, { feature: "job_scrape" }).allowed).toBe(true);
    expect(decide({ featureRuns: 9999 }, { feature: "lab" }).allowed).toBe(true);
    expect(decide({ featureRuns: 9999 }, { feature: "" }).allowed).toBe(true);
  });
});

describe("ceilings that a forged feature label cannot dodge", () => {
  it("blocks on trial tokens no matter which feature is claimed", () => {
    for (const feature of ["resume_generation", "lab", "job_scrape", ""]) {
      const blocked = decide({ windowTokens: 2_000_000 }, { feature });
      expect(blocked.allowed, feature).toBe(false);
      expect(blocked.reason, feature).toBe("tokens");
    }
  });

  it("applies the larger monthly token ceiling to paid subscriptions", () => {
    expect(decide({ windowTokens: 2_000_000 }, { isTrialing: false }).allowed).toBe(true);
    expect(decide({ windowTokens: 15_000_000 }, { isTrialing: false }).allowed).toBe(false);
  });

  it("blocks a burst even mid-run, since hammering is a script and not a person", () => {
    const blocked = decide({ burstCalls: 5, runInFlight: true });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("burst");
  });

  it("reports burst before quota when both are exceeded", () => {
    expect(decide({ burstCalls: 9, featureRuns: 99 }).reason).toBe("burst");
  });

  it("treats a missing ceiling as unlimited rather than as zero", () => {
    const noCeilings = { trial_resume_generations: 10 };
    expect(decide({ windowTokens: 9e9, burstCalls: 500 }, { limits: noCeilings }).allowed).toBe(true);
  });
});

describe("normalizeFeature", () => {
  it("passes through known features", () => {
    expect(normalizeFeature("resume_generation")).toBe("resume_generation");
    expect(normalizeFeature(" clarity_review ")).toBe("clarity_review");
  });

  it("collapses anything unrecognised to the unlabelled bucket, which has no quota exemption", () => {
    for (const value of ["made_up", "", null, undefined, 42, {}]) {
      expect(normalizeFeature(value)).toBe("");
    }
  });
});

describe("usageWindowStart", () => {
  const now = new Date("2026-08-06T12:00:00Z");

  it("counts from the live billing or trial period", () => {
    const start = usageWindowStart({ current_period_start: "2026-07-24T09:00:00Z" }, now);
    expect(start.toISOString()).toBe("2026-07-24T09:00:00.000Z");
  });

  it("falls back to the subscription row's own start when the period is missing", () => {
    const start = usageWindowStart({ created_at: "2026-08-01T00:00:00Z" }, now);
    expect(start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("falls back to the calendar month with no subscription at all", () => {
    expect(usageWindowStart(null, now).getMonth()).toBe(now.getMonth());
    expect(usageWindowStart(null, now).getDate()).toBe(1);
  });

  it("ignores a period start in the future, which would zero out real usage", () => {
    const start = usageWindowStart({ current_period_start: "2027-01-01T00:00:00Z" }, now);
    expect(start.getTime()).toBeLessThan(now.getTime());
  });

  it("ignores an unparseable timestamp", () => {
    expect(usageWindowStart({ current_period_start: "not a date" }, now).getDate()).toBe(1);
  });
});
