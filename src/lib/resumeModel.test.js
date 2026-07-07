import { describe, it, expect } from "vitest";
import {
  splitDescriptionIntoDetails,
  splitLineIntoSentences,
  normalizeDetailForComparison,
} from "./resumeModel";

describe("splitDescriptionIntoDetails", () => {
  it("splits bullet lines and strips their markers", () => {
    expect(splitDescriptionIntoDetails("- Led the team\n• Shipped v2\n* Wrote docs")).toEqual([
      "Led the team",
      "Shipped v2",
      "Wrote docs",
    ]);
  });

  it("splits a paragraph into its sentences", () => {
    expect(
      splitDescriptionIntoDetails(
        "Analyzed retention across cohorts. Automated weekly reporting in Python! Presented findings to leadership?"
      )
    ).toEqual([
      "Analyzed retention across cohorts.",
      "Automated weekly reporting in Python!",
      "Presented findings to leadership?",
    ]);
  });

  it("splits sentences packed into one bullet line", () => {
    expect(splitDescriptionIntoDetails("- Led the team. Shipped v2 on time.")).toEqual([
      "Led the team.",
      "Shipped v2 on time.",
    ]);
  });

  it("handles empty and null descriptions", () => {
    expect(splitDescriptionIntoDetails("")).toEqual([]);
    expect(splitDescriptionIntoDetails(null)).toEqual([]);
    expect(splitDescriptionIntoDetails("   \n  ")).toEqual([]);
  });
});

describe("splitLineIntoSentences", () => {
  it("does not split on abbreviations, initials, or decimals", () => {
    expect(
      splitLineIntoSentences("Worked with Dr. Smith at Beta Inc. Improved ratings from 3.5 to 4.2 stars.")
    ).toEqual(["Worked with Dr. Smith at Beta Inc. Improved ratings from 3.5 to 4.2 stars."]);

    expect(splitLineIntoSentences("Led U.S. Expansion planning. Ran the launch.")).toEqual([
      "Led U.S. Expansion planning.",
      "Ran the launch.",
    ]);

    // "e.g." must not split its own sentence; the real boundary after it still does.
    expect(splitLineIntoSentences("Automated reports, e.g. Salesforce exports. Cut manual work.")).toEqual([
      "Automated reports, e.g. Salesforce exports.",
      "Cut manual work.",
    ]);
  });

  it("keeps sentences ending in numbers or percent signs separate", () => {
    expect(splitLineIntoSentences("Grew revenue 20%. Cut churn to 3.")).toEqual([
      "Grew revenue 20%.",
      "Cut churn to 3.",
    ]);
  });

  it("splits before quoted or parenthesized sentence starts", () => {
    expect(splitLineIntoSentences('Shipped the feature. "Best launch yet" said the CEO.')).toEqual([
      "Shipped the feature.",
      '"Best launch yet" said the CEO.',
    ]);
  });
});

describe("normalizeDetailForComparison", () => {
  it("ignores markers, whitespace runs, case, and trailing punctuation", () => {
    expect(normalizeDetailForComparison("-  Ran   Sprint Planning.")).toBe("ran sprint planning");
    expect(normalizeDetailForComparison("ran sprint planning")).toBe("ran sprint planning");
    expect(normalizeDetailForComparison("Ran sprint planning!!")).toBe("ran sprint planning");
  });

  it("handles empty input", () => {
    expect(normalizeDetailForComparison(null)).toBe("");
  });
});
