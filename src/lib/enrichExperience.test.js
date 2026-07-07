import { describe, it, expect } from "vitest";
import {
  buildResponsibilityMapPrompt,
  validateResponsibilityMap,
  buildDrilldownPrompt,
  validateDrilldownQuestions,
  buildEnrichedBulletPrompt,
  appendDetailToDescription,
  isSparseDescription,
} from "./enrichExperience";

describe("validateResponsibilityMap", () => {
  it("keeps well-formed areas and assigns stable ids", () => {
    const parsed = {
      responsibilityAreas: [
        { area: "Customer discovery interviews", whyEmployersAsk: "Direct customer contact." },
        { area: "Sprint planning", whyEmployersAsk: "Common agile expectation." },
      ],
    };

    const result = validateResponsibilityMap(parsed);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("area-0");
    expect(result[0].area).toBe("Customer discovery interviews");
    expect(result[1].id).toBe("area-1");
  });

  it("trims, collapses whitespace, dedupes case-insensitively, and caps at eight", () => {
    const parsed = {
      responsibilityAreas: [
        { area: "  Sprint   planning " },
        { area: "sprint planning" },
        ...Array.from({ length: 10 }, (_, i) => ({ area: `Area ${i}` })),
      ],
    };

    const result = validateResponsibilityMap(parsed);
    expect(result[0].area).toBe("Sprint planning");
    expect(result).toHaveLength(8);
  });

  it("drops entries without a usable area label", () => {
    const parsed = {
      responsibilityAreas: [
        { area: "   " },
        { whyEmployersAsk: "No label." },
        "just a string",
        null,
        { area: "Roadmap planning" },
      ],
    };

    const result = validateResponsibilityMap(parsed);
    expect(result).toHaveLength(1);
    expect(result[0].area).toBe("Roadmap planning");
    expect(result[0].whyEmployersAsk).toBe("");
  });

  it("throws when the payload is not an object", () => {
    expect(() => validateResponsibilityMap(null)).toThrow();
    expect(() => validateResponsibilityMap([])).toThrow();
  });
});

describe("validateDrilldownQuestions", () => {
  const confirmed = ["Customer discovery interviews", "Sprint planning"];

  it("groups questions under confirmed areas in confirmed order", () => {
    const parsed = {
      areaQuestions: [
        {
          area: "Sprint planning",
          questions: [
            { kind: "specifics", question: "What did planning look like?", options: ["a", "b"] },
          ],
        },
        {
          area: "customer discovery interviews",
          questions: [
            { kind: "scale", question: "Roughly how many did you run?", options: ["A handful", "10–25", "25+"] },
          ],
        },
      ],
    };

    const result = validateDrilldownQuestions(parsed, confirmed);
    expect(result).toHaveLength(2);
    expect(result[0].area).toBe("Customer discovery interviews");
    expect(result[0].questions[0].id).toBe("enrich-0-q0");
    expect(result[0].questions[0].kind).toBe("scale");
    expect(result[1].area).toBe("Sprint planning");
  });

  it("drops questions for areas the person did not confirm", () => {
    const parsed = {
      areaQuestions: [
        {
          area: "Budget ownership",
          questions: [{ kind: "scale", question: "How big?", options: ["a", "b"] }],
        },
      ],
    };

    expect(validateDrilldownQuestions(parsed, confirmed)).toHaveLength(0);
  });

  it("normalizes kinds, marks tools as multi-select, and defaults unknown kinds to specifics", () => {
    const parsed = {
      areaQuestions: [
        {
          area: "Sprint planning",
          questions: [
            { kind: "TOOLS", question: "Which tools did you use?", options: ["Jira", "Linear"] },
            { kind: "made-up", question: "What did it look like?", options: ["a", "b"] },
          ],
        },
      ],
    };

    const result = validateDrilldownQuestions(parsed, confirmed);
    const [tools, fallback] = result[0].questions;
    expect(tools.kind).toBe("tools");
    expect(tools.multiSelect).toBe(true);
    expect(fallback.kind).toBe("specifics");
    expect(fallback.multiSelect).toBe(false);
  });

  it("dedupes repeated kinds within an area and caps at three questions", () => {
    const parsed = {
      areaQuestions: [
        {
          area: "Sprint planning",
          questions: [
            { kind: "specifics", question: "First?", options: ["a", "b"] },
            { kind: "specifics", question: "Duplicate kind?", options: ["c", "d"] },
            { kind: "scale", question: "How often?", options: ["Weekly", "Bi-weekly"] },
            { kind: "outcome", question: "What came of it?", options: ["Faster", "Nothing concrete I can point to"] },
            { kind: "ownership", question: "Ran it?", options: ["Owned it", "Supported"] },
          ],
        },
      ],
    };

    const result = validateDrilldownQuestions(parsed, confirmed);
    expect(result[0].questions).toHaveLength(3);
    expect(result[0].questions.map((q) => q.kind)).toEqual(["specifics", "scale", "outcome"]);
  });

  it("drops questions with fewer than two usable options and trims/dedupes options", () => {
    const parsed = {
      areaQuestions: [
        {
          area: "Sprint planning",
          questions: [
            { kind: "specifics", question: "Only one option?", options: ["a", "", "  ", "A"] },
            {
              kind: "scale",
              question: "How often?",
              options: [" Weekly ", "weekly", "Bi-weekly", "Monthly", "Quarterly", "Yearly", "Daily"],
            },
          ],
        },
      ],
    };

    const result = validateDrilldownQuestions(parsed, confirmed);
    expect(result[0].questions).toHaveLength(1);
    expect(result[0].questions[0].options).toEqual([
      "Weekly",
      "Bi-weekly",
      "Monthly",
      "Quarterly",
      "Yearly",
    ]);
  });

  it("drops areas whose questions all fail validation", () => {
    const parsed = {
      areaQuestions: [
        {
          area: "Sprint planning",
          questions: [{ kind: "specifics", question: "", options: ["a", "b"] }],
        },
      ],
    };

    expect(validateDrilldownQuestions(parsed, confirmed)).toHaveLength(0);
  });

  it("throws when the payload is not an object", () => {
    expect(() => validateDrilldownQuestions(null, confirmed)).toThrow();
    expect(() => validateDrilldownQuestions([], confirmed)).toThrow();
  });
});

describe("buildResponsibilityMapPrompt", () => {
  it("includes the tenure block only when tenure is given", () => {
    const withTenure = buildResponsibilityMapPrompt({
      position: "Product Manager",
      company: "Acme",
      description: "Shipped things.",
      tenure: "3 yrs",
    });
    const withoutTenure = buildResponsibilityMapPrompt({
      position: "Product Manager",
      description: "Shipped things.",
    });

    expect(withTenure).toContain("<tenure>");
    expect(withTenure).toContain("About 3 yrs in the role.");
    expect(withTenure).toContain("at Acme");
    expect(withoutTenure).not.toContain("<tenure>");
  });

  it("marks an empty description so the model knows there is nothing yet", () => {
    const prompt = buildResponsibilityMapPrompt({ position: "Product Manager", description: "  " });
    expect(prompt).toContain("(none yet)");
  });
});

describe("buildDrilldownPrompt", () => {
  it("lists the confirmed areas and skips blank entries", () => {
    const prompt = buildDrilldownPrompt({
      position: "Product Manager",
      description: "Shipped things.",
      areas: ["Customer discovery interviews", "  ", null, "Sprint planning"],
    });

    expect(prompt).toContain("- Customer discovery interviews");
    expect(prompt).toContain("- Sprint planning");
    expect(prompt).not.toContain("- null");
  });
});

describe("buildEnrichedBulletPrompt", () => {
  it("includes each answered question as a Q/A pair and skips empty answers", () => {
    const prompt = buildEnrichedBulletPrompt({
      position: "Product Manager",
      area: "Customer discovery interviews",
      answers: [
        { question: "Roughly how many did you run?", answer: "25+" },
        { question: "What came of it?", answer: "" },
        { question: "", answer: "orphaned" },
      ],
    });

    expect(prompt).toContain("- Q: Roughly how many did you run?");
    expect(prompt).toContain("A: 25+");
    expect(prompt).not.toContain("orphaned");
    expect(prompt).not.toContain("What came of it?");
  });
});

describe("appendDetailToDescription", () => {
  it("appends a plain line when the description has no bullet markers", () => {
    const { description, appended } = appendDetailToDescription(
      "Led the team.\nShipped v2.",
      "Conducted more than 25 customer interviews."
    );

    expect(appended).toBe(true);
    expect(description).toBe(
      "Led the team.\nShipped v2.\nConducted more than 25 customer interviews."
    );
  });

  it("matches the existing bullet-marker style", () => {
    const { description } = appendDetailToDescription(
      "- Led the team.\n- Shipped v2.",
      "Conducted customer interviews."
    );

    expect(description).toBe(
      "- Led the team.\n- Shipped v2.\n- Conducted customer interviews."
    );
  });

  it("starts an empty description without a marker", () => {
    const { description, appended } = appendDetailToDescription("", "Ran sprint planning.");
    expect(appended).toBe(true);
    expect(description).toBe("Ran sprint planning.");
  });

  it("skips duplicates ignoring markers, whitespace, and case", () => {
    const { description, appended } = appendDetailToDescription(
      "- Ran  sprint planning.",
      "ran sprint planning."
    );

    expect(appended).toBe(false);
    expect(description).toBe("- Ran  sprint planning.");
  });

  it("skips a duplicate that already exists as a sentence inside a paragraph", () => {
    const { description, appended } = appendDetailToDescription(
      "Led the team through two launches. Ran sprint planning every week.",
      "ran sprint planning every week"
    );

    expect(appended).toBe(false);
    expect(description).toBe("Led the team through two launches. Ran sprint planning every week.");
  });

  it("cleans markers and quotes off the proposed bullet", () => {
    const { description } = appendDetailToDescription("Led the team.", '- "Shipped the release."');
    expect(description).toBe("Led the team.\nShipped the release.");
  });

  it("does nothing when the bullet is empty", () => {
    const { description, appended } = appendDetailToDescription("Led the team.", "   ");
    expect(appended).toBe(false);
    expect(description).toBe("Led the team.");
  });
});

describe("isSparseDescription", () => {
  it("flags empty and short descriptions", () => {
    expect(isSparseDescription("")).toBe(true);
    expect(isSparseDescription(null)).toBe(true);
    expect(isSparseDescription("- Led the team.\n- Shipped v2.")).toBe(true);
  });

  it("flags descriptions whose details average under eight words", () => {
    expect(isSparseDescription("- Led the team.\n- Shipped v2.\n- Wrote docs.")).toBe(true);
  });

  it("accepts three or more substantial details", () => {
    const description = [
      "- Led a team of five engineers through two major product launches.",
      "- Conducted more than 25 customer interviews to shape the roadmap.",
      "- Ran weekly sprint planning with engineering, design, and support.",
    ].join("\n");

    expect(isSparseDescription(description)).toBe(false);
  });

  it("counts the sentences of a paragraph as separate details", () => {
    const paragraph =
      "Led a team of five engineers through two major product launches. Conducted more than 25 customer interviews to shape the roadmap. Ran weekly sprint planning with engineering, design, and support.";

    expect(isSparseDescription(paragraph)).toBe(false);
  });
});
