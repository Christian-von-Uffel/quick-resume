import { describe, it, expect } from "vitest";
import {
  getRoleInterval,
  groupRolesByEmployer,
  analyzeEmployment,
  selectRolesForContinuousCoverage,
  summarizeCoverage,
  seniorityRank,
  computeGaps,
  GAP_COVERAGE_HORIZON_MONTHS,
} from "./workHistoryTimeline";
import {
  describeMandatoryRoles,
  validateSelectedResumeEvidence,
  normalizeFitTier,
} from "./generateResume";

// A fixed "now" keeps every recency/gap computation deterministic.
const now = new Date(2026, 6, 1); // July 2026

const role = (o) => ({
  position: "",
  company: "",
  startMonth: "",
  startYear: "",
  endMonth: "",
  endYear: "",
  description: "",
  ...o,
});

const intervalsOf = (wh) => wh.map((item) => getRoleInterval(item, now));

describe("groupRolesByEmployer", () => {
  it("collapses case/typo/suffix variants but keeps distinct names distinct", () => {
    const wh = [
      role({ id: "a", company: "Acme Inc", startYear: "2020", endYear: "2021" }),
      role({ id: "b", company: "acme", startYear: "2021", endYear: "2022" }),
      role({ id: "c", company: "Celsius", startYear: "2022", endYear: "2023" }),
      role({ id: "d", company: "Celsius Network", startYear: "2023", endYear: "2024" }),
    ];
    const groups = groupRolesByEmployer(intervalsOf(wh));
    const memberships = groups.map((g) => g.roles.map((r) => r.id).sort());

    expect(groups).toHaveLength(3);
    expect(memberships).toContainEqual(["a", "b"]); // Acme Inc == acme
    expect(memberships).toContainEqual(["c"]); // Celsius stays alone
    expect(memberships).toContainEqual(["d"]); // Celsius Network stays alone
  });

  it("flags a promotion ladder (>=2 roles at distinct starts) and sorts rungs", () => {
    const wh = [
      role({ id: "mg", company: "Acme", position: "Manager", startYear: "2023", endYear: "present" }),
      role({ id: "an", company: "Acme", position: "Analyst", startYear: "2019", endYear: "2021" }),
      role({ id: "sr", company: "Acme", position: "Senior Analyst", startYear: "2021", endYear: "2023" }),
    ];
    const [acme] = groupRolesByEmployer(intervalsOf(wh));
    expect(acme.isPromotionLadder).toBe(true);
    expect(acme.roles.map((r) => r.id)).toEqual(["an", "sr", "mg"]); // chronological
  });

  it("does not flag two concurrent same-employer roles (same start) as a ladder", () => {
    const wh = [
      role({ id: "x", company: "Acme", startYear: "2020", endYear: "2022" }),
      role({ id: "y", company: "Acme", startYear: "2020", endYear: "2022" }),
    ];
    const [acme] = groupRolesByEmployer(intervalsOf(wh));
    expect(acme.isPromotionLadder).toBe(false);
  });
});

describe("seniorityRank", () => {
  it("ranks by title keywords, word-boundary safe", () => {
    expect(seniorityRank("Intern")).toBeLessThan(seniorityRank("Analyst"));
    expect(seniorityRank("Senior Analyst")).toBeGreaterThan(seniorityRank("Analyst"));
    expect(seniorityRank("Senior Manager")).toBeGreaterThan(seniorityRank("Manager"));
    expect(seniorityRank("Director")).toBeGreaterThan(seniorityRank("Senior Manager"));
    expect(seniorityRank("Chief Technology Officer")).toBeGreaterThan(seniorityRank("Director"));
    // "leadership"/"management" must NOT fire the lead/manager keywords.
    expect(seniorityRank("Leadership Program")).toBe(seniorityRank("Analyst"));
    expect(seniorityRank("Management Consultant")).toBe(seniorityRank("Analyst"));
  });
});

describe("selectRolesForContinuousCoverage", () => {
  it("requires only one of two fully-overlapping gap-fillers", () => {
    const wh = [
      role({ id: "cur", company: "Now Co", startMonth: "01", startYear: "2024", endYear: "present" }),
      role({ id: "a", company: "Alpha", startMonth: "01", startYear: "2018", endMonth: "12", endYear: "2023" }),
      role({ id: "b", company: "Beta", startMonth: "01", startYear: "2018", endMonth: "12", endYear: "2023" }),
    ];
    const { requiredIds } = selectRolesForContinuousCoverage(wh, { now });
    expect(requiredIds).toContain("cur");
    // The two concurrent roles cover the same gap — only one is needed.
    expect(requiredIds.filter((id) => id === "a" || id === "b")).toHaveLength(1);
    expect(requiredIds).toHaveLength(2);
  });

  it("fills the more recent gap before an older one", () => {
    const wh = [
      role({ id: "cur", company: "Now Co", startMonth: "01", startYear: "2024", endYear: "present" }),
      role({ id: "mid", company: "Mid Co", startMonth: "01", startYear: "2017", endMonth: "12", endYear: "2021" }),
      role({ id: "recent", company: "Recent Co", startMonth: "01", startYear: "2022", endMonth: "12", endYear: "2023" }),
      role({ id: "old", company: "Old Co", startMonth: "01", startYear: "2014", endMonth: "12", endYear: "2016" }),
    ];
    const { requiredIds } = selectRolesForContinuousCoverage(wh, { now });
    expect(requiredIds).toContain("recent");
    expect(requiredIds).toContain("old");
    expect(requiredIds.indexOf("recent")).toBeLessThan(requiredIds.indexOf("old"));
  });

  it("selects a set that is contiguous across the recent window", () => {
    const wh = [
      role({ id: "cur", company: "Now Co", startMonth: "01", startYear: "2024", endYear: "present" }),
      role({ id: "mid", company: "Mid Co", startMonth: "01", startYear: "2017", endMonth: "12", endYear: "2021" }),
      role({ id: "recent", company: "Recent Co", startMonth: "01", startYear: "2022", endMonth: "12", endYear: "2023" }),
      role({ id: "old", company: "Old Co", startMonth: "01", startYear: "2014", endMonth: "12", endYear: "2016" }),
    ];
    const sel = selectRolesForContinuousCoverage(wh, { now });
    const chosen = intervalsOf(wh).filter((iv) => sel.requiredIds.includes(iv.id));
    const coverageStart = Math.max(sel.careerStart, sel.nowIdx - GAP_COVERAGE_HORIZON_MONTHS);
    const gaps = computeGaps(chosen, { domainStart: coverageStart, domainEnd: sel.nowIdx });
    expect(gaps).toHaveLength(0);
  });

  it("keeps a genuine current unemployment gap and anchors on the most recent role", () => {
    const wh = [
      role({ id: "x", company: "Old Job", startMonth: "01", startYear: "2020", endMonth: "01", endYear: "2024" }),
    ];
    const cov = summarizeCoverage(wh, now);
    expect(cov.currentlyEmployed).toBe(false);
    expect(cov.requiredRoles.map((r) => r.item.id)).toEqual(["x"]);
    expect(cov.requiredRoles[0].reason).toBe("most-recent");
    expect(cov.largestGap).toBeTruthy();
    expect(cov.timeline.gaps.some((g) => g.toPresent)).toBe(true);
  });
});

describe("analyzeEmployment overlap primaries", () => {
  it("picks the ongoing role as primary among concurrent employers", () => {
    const wh = [
      role({ id: "sa", company: "Alpha", position: "Senior Engineer", startYear: "2020", endYear: "2022" }),
      role({ id: "eb", company: "Beta", position: "Engineer", startYear: "2021", endYear: "present" }),
    ];
    const { overlapClusters } = analyzeEmployment(wh, now);
    expect(overlapClusters).toHaveLength(1);
    expect(overlapClusters[0].primaryRoleId).toBe("eb");
  });

  it("breaks ties by seniority when neither is ongoing", () => {
    const wh = [
      role({ id: "d", company: "Gamma", position: "Director", startYear: "2018", endYear: "2020" }),
      role({ id: "an", company: "Delta", position: "Analyst", startYear: "2019", endYear: "2021" }),
    ];
    const { overlapClusters } = analyzeEmployment(wh, now);
    expect(overlapClusters).toHaveLength(1);
    expect(overlapClusters[0].primaryRoleId).toBe("d");
  });
});

describe("describeMandatoryRoles", () => {
  it("groups a promotion ladder and marks the concurrent primary", () => {
    const wh = [
      role({ id: "an", company: "Acme", position: "Analyst", startMonth: "01", startYear: "2019", endMonth: "12", endYear: "2020" }),
      role({ id: "sr", company: "Acme", position: "Senior Analyst", startMonth: "01", startYear: "2021", endMonth: "12", endYear: "2022" }),
      role({ id: "mg", company: "Acme", position: "Manager", startMonth: "01", startYear: "2023", endYear: "present" }),
      role({ id: "adv", company: "Side Co", position: "Advisor", startMonth: "01", startYear: "2022", endMonth: "12", endYear: "2024" }),
    ];
    const cov = summarizeCoverage(wh, now);
    const text = describeMandatoryRoles(cov);

    expect(text).toContain("promotion history");
    // All three rungs of the ladder surface under the single tenure...
    expect(text).toContain("Analyst");
    expect(text).toContain("Senior Analyst");
    expect(text).toContain("Manager");
    // ...even though only the current Manager rung is strictly required.
    expect(text).toContain("Concurrent employment");
    expect(text).toMatch(/lead with "Manager — Acme"/);
    expect(text).toContain("recent — emphasize"); // current role flagged for emphasis
  });
});

describe("validateSelectedResumeEvidence fit tier", () => {
  it("preserves a valid fit tier and defaults when missing/invalid", () => {
    const out = validateSelectedResumeEvidence({
      selectedWorkHistory: [
        { position: "A", fit: "strong" },
        { position: "B" },
        { position: "C", fit: "bogus" },
      ],
    });
    expect(out.selectedWorkHistory.map((r) => r.fit)).toEqual(["strong", "supporting", "supporting"]);
  });

  it("normalizeFitTier maps unknowns to supporting", () => {
    expect(normalizeFitTier("timeline-only")).toBe("timeline-only");
    expect(normalizeFitTier("STRONG")).toBe("strong");
    expect(normalizeFitTier(undefined)).toBe("supporting");
  });
});
