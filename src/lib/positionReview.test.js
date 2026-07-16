import { describe, it, expect } from "vitest";
import {
  CONFLICT_KINDS,
  DATE_ISSUES,
  MIN_OVERLAP_FLAG_MONTHS,
  levenshteinDistance,
  isTypoMatch,
  isSameTitle,
  isSameCompany,
  normalizeTitleForMatch,
  mergeImportedWorkHistory,
  dedupeEntryDetails,
  detectPositionConflicts,
  mergedDatesPreview,
  applyDuplicateMerge,
  buildMergedDescription,
  applyBoundaryFix,
  collectConflictKeys,
  conflictPairKey,
  describeRoleDates,
} from "./positionReview";
import { getRoleInterval } from "./workHistoryTimeline";

// A fixed "now" keeps every duration/overlap computation deterministic.
const now = new Date(2026, 6, 1); // July 2026

let nextId = 0;
const role = (o) => ({
  id: `r${(nextId += 1)}`,
  position: "",
  company: "",
  startMonth: "",
  startYear: "",
  endMonth: "",
  endYear: "",
  description: "",
  ...o,
});

const detect = (wh, ackKeys = []) => detectPositionConflicts(wh, { now, ackKeys });

describe("levenshteinDistance", () => {
  it("computes classic edit distances", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("same", "same")).toBe(0);
  });

  it("counts a dropped letter as one edit", () => {
    expect(levenshteinDistance("sofware", "software")).toBe(1);
    expect(levenshteinDistance("gogle", "google")).toBe(1);
  });

  it("counts an adjacent transposition as one edit, not two", () => {
    expect(levenshteinDistance("enigneer", "engineer")).toBe(1);
    expect(levenshteinDistance("mangaer", "manager")).toBe(1);
  });
});

describe("isTypoMatch", () => {
  it("accepts single-edit typos in words of 5+ characters", () => {
    expect(isTypoMatch("google", "gogle")).toBe(true);
    expect(isTypoMatch("manager", "manger")).toBe(true);
  });

  it("requires exact matches for short words (Acme is not Acne)", () => {
    expect(isTypoMatch("acme", "acne")).toBe(false);
    expect(isTypoMatch("sale", "sales")).toBe(false);
  });

  it("allows one typo per word in multi-word strings", () => {
    expect(isTypoMatch("produt manger", "product manager")).toBe(true);
  });

  it("never bridges real word differences", () => {
    // "senior" → "junior" is distance 2: a different word, not a typo.
    expect(isTypoMatch("senior product manager", "junior product manager")).toBe(false);
    expect(isTypoMatch("engineer", "senior engineer")).toBe(false);
    expect(isTypoMatch("designer", "developer")).toBe(false);
  });

  it("treats blanks as no match", () => {
    expect(isTypoMatch("", "")).toBe(false);
    expect(isTypoMatch("acme", "")).toBe(false);
  });
});

describe("typo-tolerant title and company matching", () => {
  it("collapses case, punctuation, and Sr/Jr abbreviations", () => {
    expect(normalizeTitleForMatch("Sr. Software Engineer")).toBe("senior software engineer");
    expect(normalizeTitleForMatch("Engineer (Contract)")).toBe("engineer");
  });

  it("matches typo'd titles and companies", () => {
    expect(isSameTitle("Software Engineer", "Sofware Engineer")).toBe(true);
    expect(isSameTitle("Product Manager", "Product Manger")).toBe(true);
    expect(isSameCompany("Google", "Gogle")).toBe(true);
    expect(isSameCompany("Acme Inc.", "acme")).toBe(true);
  });

  it("keeps genuinely different names distinct", () => {
    expect(isSameTitle("Engineer", "Senior Engineer")).toBe(false);
    expect(isSameCompany("Celsius", "Celsius Network")).toBe(false);
    expect(isSameCompany("Acme", "Acne")).toBe(false);
  });
});

describe("mergeImportedWorkHistory (auto-merge on import)", () => {
  it("folds an imported copy with the same title, company, and dates into the existing entry", () => {
    const existing = role({
      position: "Designer",
      company: "Acme",
      startMonth: "01",
      startYear: "2020",
      endMonth: "06",
      endYear: "2022",
      description: "Led the design system.",
    });
    const { merged, mergedCount } = mergeImportedWorkHistory(
      [existing],
      [{
        position: "designer",
        company: "Acme Inc.",
        startMonth: "01",
        startYear: "2020",
        endMonth: "06",
        endYear: "2022",
        description: "led the design system\nShipped the mobile app.",
      }]
    );
    expect(mergedCount).toBe(1);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(existing.id);
    expect(merged[0].description).toBe("Led the design system.\nShipped the mobile app.");
  });

  it("merges typo'd titles when the dates match exactly", () => {
    const existing = role({
      position: "Software Engineer",
      company: "Google",
      startYear: "2019",
      endYear: "2021",
    });
    const { merged, mergedCount } = mergeImportedWorkHistory(
      [existing],
      [{ position: "Sofware Engineer", company: "Gogle", startYear: "2019", endYear: "2021" }]
    );
    expect(mergedCount).toBe(1);
    expect(merged).toHaveLength(1);
    expect(merged[0].position).toBe("Software Engineer"); // existing spelling wins
  });

  it("treats a blank end and an explicit present as the same ongoing date", () => {
    const existing = role({ position: "Engineer", company: "Acme", startYear: "2020" });
    const { merged, mergedCount } = mergeImportedWorkHistory(
      [existing],
      [{ position: "Engineer", company: "Acme", startYear: "2020", endYear: "present" }]
    );
    expect(mergedCount).toBe(1);
    expect(merged).toHaveLength(1);
  });

  it("keeps entries with different dates separate for review instead of merging", () => {
    const existing = role({ position: "Designer", company: "Acme", startYear: "2020", endYear: "2022" });
    const { merged, mergedCount } = mergeImportedWorkHistory(
      [existing],
      [{ position: "Designer", company: "Acme", startMonth: "03", startYear: "2020", endYear: "2022" }]
    );
    expect(mergedCount).toBe(0);
    expect(merged).toHaveLength(2);
  });

  it("dedupes a role listed twice within the imported batch itself", () => {
    const { merged, mergedCount } = mergeImportedWorkHistory(
      [],
      [
        { position: "Analyst", company: "Beta", startYear: "2021", endYear: "2023", description: "Built dashboards." },
        { position: "Analyst", company: "Beta", startYear: "2021", endYear: "2023", description: "Built dashboards.\nAutomated reports." },
        { position: "PM", company: "Zed", startYear: "2023", endYear: "present" },
      ]
    );
    expect(mergedCount).toBe(1);
    expect(merged).toHaveLength(2);
    const analyst = merged.find((item) => item.company === "Beta");
    expect(analyst.description).toBe("Built dashboards.\nAutomated reports.");
  });

  it("skips empty imported rows and appends genuinely new roles", () => {
    const { merged, mergedCount } = mergeImportedWorkHistory(
      [role({ position: "Designer", company: "Acme", startYear: "2020", endYear: "2022" })],
      [{ position: "", company: "", description: "" }, { position: "PM", company: "Zed", startYear: "2023" }]
    );
    expect(mergedCount).toBe(0);
    expect(merged).toHaveLength(2);
  });
});

describe("within-entry bullet dedup on import", () => {
  it("drops an exact repeated bullet, keeping order and marker", () => {
    expect(
      dedupeEntryDetails("- Led the design system\n- Shipped the app\n- Led the design system")
    ).toBe("- Led the design system\n- Shipped the app");
  });

  it("keeps the fuller wording when one bullet elaborates another", () => {
    // "Led design system" is contained in the longer line → keep the longer.
    expect(
      dedupeEntryDetails("Led design system\nMentored two juniors\nLed the design system for twelve people")
    ).toBe("Led the design system for twelve people\nMentored two juniors");
  });

  it("collapses a reordered restatement", () => {
    expect(dedupeEntryDetails("Owned analytics roadmap\nRoadmap analytics owned")).toBe(
      "Owned analytics roadmap"
    );
  });

  it("collapses a typo'd repeat", () => {
    expect(dedupeEntryDetails("Managed the hiring pipeline\nManaged the hiring pipeine")).toBe(
      "Managed the hiring pipeline"
    );
  });

  it("keeps bullets that differ only by a number (distinct metrics)", () => {
    const text = "Grew revenue by 20%\nGrew revenue by 40%";
    expect(dedupeEntryDetails(text)).toBe(text);
  });

  it("leaves distinct bullets and blank lines untouched", () => {
    const text = "Built the dashboard\n\nHired three engineers";
    expect(dedupeEntryDetails(text)).toBe(text);
  });

  it("cleans an imported entry's own repeats through mergeImportedWorkHistory", () => {
    const { merged } = mergeImportedWorkHistory(
      [],
      [
        {
          position: "PM",
          company: "Acme",
          startYear: "2020",
          endYear: "2022",
          description: "Owned the roadmap\nShipped v2\nOwned the roadmap",
        },
      ]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe("Owned the roadmap\nShipped v2");
  });
});

describe("duplicate detection", () => {
  it("flags same employer + same title with overlapping dates", () => {
    const wh = [
      role({ position: "Designer", company: "Acme Inc", startMonth: "01", startYear: "2020", endMonth: "06", endYear: "2022" }),
      role({ position: "Sr. Designer", company: "Beta", startYear: "2023", endYear: "present" }),
      role({ position: "designer", company: "acme", startMonth: "02", startYear: "2020", endMonth: "06", endYear: "2022" }),
    ];
    const conflicts = detect(wh);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe(CONFLICT_KINDS.DUPLICATE);
  });

  it("flags typo'd duplicates and marks the fuzzy match", () => {
    const wh = [
      role({ position: "Product Manager", company: "Acme", startMonth: "01", startYear: "2020", endYear: "present" }),
      role({ position: "Product Manger", company: "Acme", startMonth: "03", startYear: "2020", endMonth: "06", endYear: "2021" }),
    ];
    const [conflict] = detect(wh);
    expect(conflict.kind).toBe(CONFLICT_KINDS.DUPLICATE);
    expect(conflict.fuzzy.title).toBe(true);
    expect(conflict.fuzzy.company).toBe(false);
  });

  it("flags a same-title copy that has no dates (double import)", () => {
    const dated = role({ position: "Designer", company: "Acme", startYear: "2020", endYear: "2022" });
    const undated = role({ position: "Designer", company: "Acme" });
    const conflicts = detect([dated, undated]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe(CONFLICT_KINDS.DUPLICATE);
    // Only the dated copy contributes date choices.
    expect(conflicts[0].merge.startOptions).toHaveLength(1);
    expect(conflicts[0].merge.endOptions).toHaveLength(1);
    expect(mergedDatesPreview(conflicts[0].merge, null, null, now).dates).toBe("2020 – 2022");
  });

  it("does not flag a rehire (same title, non-overlapping dates)", () => {
    const wh = [
      role({ position: "Designer", company: "Acme", startYear: "2018", endYear: "2019" }),
      role({ position: "Designer", company: "Acme", startYear: "2021", endYear: "2022" }),
    ];
    expect(detect(wh)).toHaveLength(0);
  });

  it("stays quiet for blank in-progress entries", () => {
    const wh = [
      role({ position: "Designer", company: "Acme", startYear: "2020", endYear: "2022" }),
      role({}),
      role({ company: "Acme" }),
    ];
    expect(detect(wh)).toHaveLength(0);
  });

  it("collects both entries' start and end dates as choices with live durations", () => {
    const wh = [
      role({ position: "Designer", company: "Acme", startMonth: "01", startYear: "2020", endMonth: "06", endYear: "2021" }),
      role({ position: "Designer", company: "Acme", startMonth: "03", startYear: "2020", endYear: "present" }),
    ];
    const [conflict] = detect(wh);
    const { merge } = conflict;
    expect(merge.startOptions.map((o) => o.label)).toEqual(["Jan 2020", "Mar 2020"]);
    expect(merge.endOptions.map((o) => o.label)).toEqual(["Jun 2021", "Present"]);
    // Defaults to the widest span: earliest start, latest end.
    expect(mergedDatesPreview(merge, merge.defaultStartId, merge.defaultEndId, now)).toEqual({
      dates: "Jan 2020 – Present",
      duration: "6 yrs 7 mos",
    });
    // Any other combination previews its own duration.
    const startB = merge.startOptions[1].id;
    const endA = merge.endOptions[0].id;
    expect(mergedDatesPreview(merge, startB, endA, now)).toEqual({
      dates: "Mar 2020 – Jun 2021",
      duration: "1 yr 4 mos",
    });
  });
});

describe("same-employer overlap detection", () => {
  it("flags different titles at one employer overlapping ≥2 months as a promotion cut", () => {
    const wh = [
      role({ position: "Analyst", company: "Acme", startMonth: "05", startYear: "2019", endYear: "present" }),
      role({ position: "Manager", company: "Acme", startMonth: "03", startYear: "2022", endYear: "present" }),
    ];
    const [conflict] = detect(wh);
    expect(conflict.kind).toBe(CONFLICT_KINDS.SAME_EMPLOYER_OVERLAP);
    // The old role forgot its end date: ending it when the new one begins is
    // the offered fix; starting the new one "after present" is not.
    expect(conflict.fixes).toHaveLength(1);
    expect(conflict.fixes[0].id).toBe("trim-earlier-end");
    expect(conflict.fixes[0].after.dates).toBe("May 2019 – Feb 2022");
  });

  it("ignores a single transition month", () => {
    const wh = [
      role({ position: "Analyst", company: "Acme", startMonth: "05", startYear: "2019", endMonth: "02", endYear: "2022" }),
      role({ position: "Manager", company: "Acme", startMonth: "02", startYear: "2022", endYear: "present" }),
    ];
    expect(MIN_OVERLAP_FLAG_MONTHS).toBe(2);
    expect(detect(wh)).toHaveLength(0);
  });

  it("does NOT flag two different employers overlapping — concurrent jobs are fine", () => {
    const wh = [
      role({ position: "Engineer", company: "Acme", startMonth: "01", startYear: "2020", endMonth: "06", endYear: "2022" }),
      role({ position: "Consultant", company: "Beta", startMonth: "01", startYear: "2022", endMonth: "12", endYear: "2023" }),
    ];
    expect(detect(wh)).toHaveLength(0);
  });

  it("offers both boundary fixes for overlapping titles at one employer", () => {
    const wh = [
      role({ position: "Engineer", company: "Acme", startMonth: "01", startYear: "2020", endMonth: "06", endYear: "2022" }),
      role({ position: "Manager", company: "Acme", startMonth: "01", startYear: "2022", endMonth: "12", endYear: "2023" }),
    ];
    const [conflict] = detect(wh);
    expect(conflict.kind).toBe(CONFLICT_KINDS.SAME_EMPLOYER_OVERLAP);
    expect(conflict.overlapLabel).toBe("6 mos");
    expect(conflict.fixes.map((f) => f.id).sort()).toEqual(["trim-earlier-end", "trim-later-start"]);
    // End the earlier title when the next begins → Dec 2021 (month before a January start).
    expect(conflict.fixes.find((f) => f.id === "trim-earlier-end").after.dates).toBe("Jan 2020 – Dec 2021");
    // Start the later title after the earlier ends → Jul 2022.
    expect(conflict.fixes.find((f) => f.id === "trim-later-start").after.dates).toBe("Jul 2022 – Dec 2023");
  });

  it("offers no boundary fixes when the ranges are identical (keep both is the call)", () => {
    const wh = [
      role({ position: "Engineer", company: "Acme", startYear: "2020", endYear: "2022" }),
      role({ position: "Advisor", company: "Acme", startYear: "2020", endYear: "2022" }),
    ];
    const [conflict] = detect(wh);
    expect(conflict.kind).toBe(CONFLICT_KINDS.SAME_EMPLOYER_OVERLAP);
    expect(conflict.fixes).toHaveLength(0);
    expect(conflict.keepBothLabel).toMatch(/keep both/i);
  });

  it("does not offer pushing a contained role past its container's end", () => {
    const wh = [
      role({ position: "Engineer", company: "Acme", startYear: "2019", endYear: "2024" }),
      role({ position: "Advisor", company: "Acme", startYear: "2021", endYear: "2022" }),
    ];
    const [conflict] = detect(wh);
    expect(conflict.fixes.map((f) => f.id)).toEqual(["trim-earlier-end"]);
  });
});

describe("impossible dates (mislisted import data)", () => {
  it("flags a role whose end date precedes its start and offers a swap", () => {
    const wh = [
      role({ position: "Engineer", company: "Acme", startMonth: "06", startYear: "2022", endMonth: "01", endYear: "2020" }),
    ];
    const [conflict] = detect(wh);
    expect(conflict.kind).toBe(CONFLICT_KINDS.IMPOSSIBLE_DATES);
    expect(conflict.dateIssue).toBe(DATE_ISSUES.REVERSED);
    expect(conflict.b).toBeNull();
    expect(conflict.fixes).toHaveLength(1);
    expect(conflict.fixes[0].id).toBe("swap-dates");
    expect(conflict.fixes[0].after.dates).toBe("Jan 2020 – Jun 2022");
  });

  it("swaps reversed dates back into order via applyBoundaryFix", () => {
    const reversed = role({ position: "Engineer", company: "Acme", startMonth: "06", startYear: "2022", endMonth: "01", endYear: "2020" });
    const [conflict] = detect([reversed]);
    const result = applyBoundaryFix([reversed], conflict.fixes[0]);
    expect(result[0].startMonth).toBe("01");
    expect(result[0].startYear).toBe("2020");
    expect(result[0].endMonth).toBe("06");
    expect(result[0].endYear).toBe("2022");
    expect(detect(result)).toHaveLength(0);
  });

  it("flags a role that starts in the future with no auto-fix (year typo)", () => {
    const wh = [
      role({ position: "Engineer", company: "Acme", startMonth: "03", startYear: "2030", endYear: "present" }),
    ];
    const [conflict] = detect(wh);
    expect(conflict.kind).toBe(CONFLICT_KINDS.IMPOSSIBLE_DATES);
    expect(conflict.dateIssue).toBe(DATE_ISSUES.FUTURE_START);
    expect(conflict.fixes).toHaveLength(0);
  });

  it("leaves an undated or sane role alone", () => {
    const wh = [
      role({ position: "Engineer", company: "Acme", startYear: "2020", endYear: "2022" }),
      role({ position: "Advisor", company: "Beta" }), // no dates at all
      role({ position: "Intern", company: "Zed", startYear: "2018" }), // year-only, open
    ];
    expect(detect(wh)).toHaveLength(0);
  });

  it("stops flagging a date issue marked correct, until the dates change", () => {
    const wh = [
      role({ position: "Engineer", company: "Acme", startMonth: "06", startYear: "2022", endMonth: "01", endYear: "2020" }),
    ];
    const [conflict] = detect(wh);
    expect(detect(wh, [conflict.id])).toHaveLength(0);
    // Different dates → the acknowledged signature no longer matches → re-flags.
    const edited = [{ ...wh[0], endYear: "2019" }];
    expect(detect(edited, [conflict.id])).toHaveLength(1);
  });

  it("collectConflictKeys includes single-role signatures so date-issue acks survive pruning", () => {
    const reversed = role({ position: "Engineer", company: "Acme", startMonth: "06", startYear: "2022", endMonth: "01", endYear: "2020" });
    const [conflict] = detect([reversed]);
    expect(collectConflictKeys([reversed]).has(conflict.id)).toBe(true);
  });
});

describe("acknowledgments", () => {
  it("pair keys are order-independent and content-based", () => {
    const a = role({ position: "Engineer", company: "Acme", startYear: "2020", endYear: "2022" });
    const b = role({ position: "Advisor", company: "Beta", startYear: "2020", endYear: "2022" });
    expect(conflictPairKey(a, b)).toBe(conflictPairKey(b, a));
    expect(conflictPairKey({ ...a, id: "different-id" }, b)).toBe(conflictPairKey(a, b));
  });

  it("skips pairs the person confirmed as intentional", () => {
    const wh = [
      role({ position: "Engineer", company: "Acme", startYear: "2020", endYear: "2022" }),
      role({ position: "Advisor", company: "Acme", startYear: "2020", endYear: "2022" }),
    ];
    const [conflict] = detect(wh);
    expect(detect(wh, [conflict.id])).toHaveLength(0);
  });

  it("re-flags after the dates change (the acknowledged situation is gone)", () => {
    const wh = [
      role({ position: "Engineer", company: "Acme", startYear: "2020", endYear: "2022" }),
      role({ position: "Advisor", company: "Acme", startYear: "2020", endYear: "2022" }),
    ];
    const [conflict] = detect(wh);
    const edited = [wh[0], { ...wh[1], endYear: "2023" }];
    expect(detect(edited, [conflict.id])).toHaveLength(1);
  });
});

describe("applyDuplicateMerge", () => {
  it("merges with the chosen dates: survivor keeps its id and gains unique details", () => {
    const rich = role({
      position: "Designer",
      company: "Acme",
      startMonth: "01",
      startYear: "2020",
      endMonth: "06",
      endYear: "2021",
      description: "Led the design system.\nShipped the mobile app.",
    });
    const sparse = role({
      position: "Designer",
      company: "Acme",
      startMonth: "03",
      startYear: "2020",
      endYear: "present",
      description: "shipped the mobile app\nMentored two juniors.",
    });
    const other = role({ position: "PM", company: "Zed", startYear: "2023", endYear: "present" });
    const [conflict] = detect([rich, sparse, other]);
    const { merge } = conflict;

    // Pick the widest span (the defaults): Jan 2020 – Present.
    const result = applyDuplicateMerge([rich, sparse, other], conflict, {
      startId: merge.defaultStartId,
      endId: merge.defaultEndId,
    });
    expect(result).toHaveLength(2);
    const merged = result.find((item) => item.company === "Acme");
    expect(merged.id).toBe(rich.id); // richer entry survives, id stable
    expect(merged.startMonth).toBe("01");
    expect(merged.startYear).toBe("2020");
    expect(merged.endYear).toBe("present");
    expect(merged.description).toBe(
      "Led the design system.\nShipped the mobile app.\nMentored two juniors."
    );
    // The duplicate pair is gone. (The merged Present role now overlaps PM at
    // Zed, but those are different employers, so that's intentionally unflagged.)
    expect(detect(result)).toHaveLength(0);
  });

  it("honors a non-default date pick", () => {
    const a = role({ position: "Designer", company: "Acme", startMonth: "01", startYear: "2020", endMonth: "06", endYear: "2021" });
    const b = role({ position: "Designer", company: "Acme", startMonth: "03", startYear: "2020", endYear: "present" });
    const [conflict] = detect([a, b]);
    const startB = conflict.merge.startOptions[1].id;
    const endA = conflict.merge.endOptions[0].id;

    const result = applyDuplicateMerge([a, b], conflict, { startId: startB, endId: endA });
    expect(result).toHaveLength(1);
    expect(result[0].startMonth).toBe("03");
    expect(result[0].startYear).toBe("2020");
    expect(result[0].endMonth).toBe("06");
    expect(result[0].endYear).toBe("2021");
  });
});

describe("merge bullet chooser", () => {
  const olderNewer = () => [
    role({
      position: "PM",
      company: "Acme",
      startYear: "2018",
      endYear: "2020",
      description: "Owned the analytics roadmap\nMentored two analysts",
    }),
    role({
      position: "PM",
      company: "Acme",
      startYear: "2018",
      endYear: "2023",
      description: "Owned the analytics roadmap end to end\nRan the weekly review",
    }),
  ];

  it("offers a choice for reworded bullets and defaults to the more recent copy's wording", () => {
    const [conflict] = detect(olderNewer());
    const { merge } = conflict;
    expect(merge.bulletChoices).toHaveLength(1);
    const choice = merge.bulletChoices[0];
    expect(choice.strict).toBe(true);
    expect([choice.survivorWording, choice.removedWording]).toEqual(
      expect.arrayContaining(["Owned the analytics roadmap", "Owned the analytics roadmap end to end"])
    );
    // Newer copy (ends 2023) wins the default; unique bullets from both survive.
    const merged = buildMergedDescription(merge, {});
    expect(merged).toContain("Owned the analytics roadmap end to end");
    expect(merged).not.toContain("Owned the analytics roadmap\n"); // the shorter wording is dropped
    expect(merged).toContain("Mentored two analysts");
    expect(merged).toContain("Ran the weekly review");
  });

  it("honors an explicit pick of the other wording", () => {
    const [conflict] = detect(olderNewer());
    const { merge } = conflict;
    const choice = merge.bulletChoices[0];
    const other = choice.defaultChoice === "survivor" ? "removed" : "survivor";
    const merged = buildMergedDescription(merge, { [choice.id]: other });
    expect(merged).toContain("Owned the analytics roadmap");
    expect(merged).not.toContain("end to end");
  });

  it("keeps both wordings when the pick is 'both'", () => {
    const [conflict] = detect(olderNewer());
    const { merge } = conflict;
    const choice = merge.bulletChoices[0];
    const merged = buildMergedDescription(merge, { [choice.id]: "both" });
    const roadmapLines = merged.split("\n").filter((line) => /analytics roadmap/i.test(line));
    expect(roadmapLines).toHaveLength(2);
  });

  it("defaults to the fuller wording when the copies' dates tie", () => {
    const wh = [
      role({ position: "PM", company: "Acme", startYear: "2020", endYear: "2022", description: "Owned the roadmap" }),
      role({ position: "PM", company: "Acme", startYear: "2020", endYear: "2022", description: "Owned the product roadmap end to end" }),
    ];
    const [conflict] = detect(wh);
    expect(conflict.merge.recentSide).toBeNull();
    expect(buildMergedDescription(conflict.merge, {})).toBe("Owned the product roadmap end to end");
  });

  it("proposes a shared-wording pair but keeps both by default (no silent loss)", () => {
    const wh = [
      role({ position: "PM", company: "Acme", startYear: "2020", endYear: "2022", description: "Led user research for the redesign" }),
      role({ position: "PM", company: "Acme", startYear: "2020", endYear: "2022", description: "Led UX research on the redesign" }),
    ];
    const [conflict] = detect(wh);
    expect(conflict.merge.bulletChoices).toHaveLength(1);
    expect(conflict.merge.bulletChoices[0].strict).toBe(false);
    expect(conflict.merge.bulletChoices[0].defaultChoice).toBe("both");
    expect(buildMergedDescription(conflict.merge, {}).split("\n")).toHaveLength(2);
  });

  it("does not offer a choice for bullets that differ only by a figure", () => {
    const wh = [
      role({ position: "Sales", company: "Acme", startYear: "2020", endYear: "2022", description: "Grew revenue by 20%" }),
      role({ position: "Sales", company: "Acme", startYear: "2020", endYear: "2022", description: "Grew revenue by 40%" }),
    ];
    const [conflict] = detect(wh);
    expect(conflict.merge.bulletChoices).toHaveLength(0);
    expect(buildMergedDescription(conflict.merge, {}).split("\n")).toHaveLength(2);
  });

  it("applyDuplicateMerge writes the picked wording into the survivor", () => {
    const wh = olderNewer();
    const [conflict] = detect(wh);
    const { merge } = conflict;
    const choice = merge.bulletChoices[0];
    const result = applyDuplicateMerge(wh, conflict, {
      startId: merge.defaultStartId,
      endId: merge.defaultEndId,
      bulletPicks: { [choice.id]: "removed" }, // force the shorter/older wording
    });
    expect(result).toHaveLength(1);
    const survivor = result[0];
    expect(survivor.description).toContain("Owned the analytics roadmap");
    expect(survivor.description).not.toContain("end to end");
  });
});

describe("applyBoundaryFix", () => {
  it("trims a boundary and normalizes the result", () => {
    const early = role({ position: "Engineer", company: "Acme", startMonth: "01", startYear: "2020", endMonth: "06", endYear: "2022" });
    const late = role({ position: "Manager", company: "Acme", startMonth: "01", startYear: "2022", endMonth: "12", endYear: "2023" });
    const [conflict] = detect([early, late]);
    const fix = conflict.fixes.find((f) => f.id === "trim-earlier-end");

    const result = applyBoundaryFix([early, late], fix);
    const trimmed = result.find((item) => item.id === early.id);
    expect(trimmed.endMonth).toBe("12");
    expect(trimmed.endYear).toBe("2021");
    // The pair no longer conflicts once the fix is applied.
    expect(detect(result)).toHaveLength(0);
  });
});

describe("describeRoleDates", () => {
  it("respects year-only entries and ongoing roles", () => {
    const yearOnly = role({ startYear: "2020", endYear: "2021" });
    expect(describeRoleDates(yearOnly, getRoleInterval(yearOnly, now)).dates).toBe("2020 – 2021");
    const ongoing = role({ startMonth: "03", startYear: "2024", endYear: "present" });
    const described = describeRoleDates(ongoing, getRoleInterval(ongoing, now));
    expect(described.dates).toBe("Mar 2024 – Present");
    expect(described.duration).toBe("2 yrs 5 mos");
  });
});
