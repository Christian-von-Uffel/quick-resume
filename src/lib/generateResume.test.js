import { describe, it, expect } from "vitest";
import {
  GENERATE_STEPS,
  buildJobAnalysisPrompt,
  validateJobAnalysis,
  selectRankedEvidence,
  validateSelectedResumeEvidence,
  ensureRequiredRolesSelected,
  composeResume,
} from "./generateResume";

const jobAnalysis = {
  company: "Acme Corp",
  position: "Data Scientist",
  keyResponsibilities: [
    "Build predictive models on employee data",
    "Communicate analytical insights to non-technical stakeholders",
  ],
  mustHaveRequirements: ["Python", "Stakeholder communication"],
};

const profile = { name: "Sam Jones", headline: "Product Manager" };

describe("GENERATE_STEPS", () => {
  it("exposes the pipeline in order with user-facing labels", () => {
    expect(GENERATE_STEPS.map((step) => step.id)).toEqual(["analyze", "select", "compose"]);
    for (const step of GENERATE_STEPS) {
      expect(step.label.length).toBeGreaterThan(10);
    }
  });
});

describe("validateJobAnalysis", () => {
  it("keeps well-formed analyses, trimming every field", () => {
    const result = validateJobAnalysis({
      company: " Acme Corp ",
      position: " Data Scientist ",
      keyResponsibilities: [" Build predictive models ", "Present findings"],
      mustHaveRequirements: ["Python "],
    });

    expect(result.company).toBe("Acme Corp");
    expect(result.position).toBe("Data Scientist");
    expect(result.keyResponsibilities).toEqual(["Build predictive models", "Present findings"]);
    expect(result.mustHaveRequirements).toEqual(["Python"]);
  });

  it("throws when the model returned something other than an object", () => {
    expect(() => validateJobAnalysis(null)).toThrow(/valid job analysis/i);
    expect(() => validateJobAnalysis([1, 2])).toThrow(/valid job analysis/i);
  });

  it("degrades missing or malformed fields to empty values instead of failing the run", () => {
    const result = validateJobAnalysis({ company: 42 });
    expect(result).toEqual({
      company: "",
      position: "",
      keyResponsibilities: [],
      mustHaveRequirements: [],
    });
  });

  it("dedupes case-insensitively and caps responsibilities at six, requirements at eight", () => {
    const result = validateJobAnalysis({
      keyResponsibilities: ["A", "a", "B", "C", "D", "E", "F", "G"],
      mustHaveRequirements: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    });
    expect(result.keyResponsibilities).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(result.mustHaveRequirements).toHaveLength(8);
  });
});

describe("buildJobAnalysisPrompt", () => {
  it("embeds the job description and asks for responsibilities grounded only in it", () => {
    const prompt = buildJobAnalysisPrompt("We need someone to build models.");
    expect(prompt).toContain("We need someone to build models.");
    expect(prompt).toMatch(/ONLY on this job description/i);
    expect(prompt).toContain("keyResponsibilities");
    expect(prompt).toContain("mustHaveRequirements");
  });
});

describe("selectRankedEvidence", () => {
  const prompt = selectRankedEvidence({
    profile,
    workHistory: [{ position: "Product Manager", company: "Beta Inc", description: "- Shipped things" }],
    jobAnalysis,
    instructions: "Full job description text.",
    coverage: null,
  });

  it("presents the extracted responsibilities as the ranking anchor", () => {
    expect(prompt).toContain("Build predictive models on employee data");
    expect(prompt).toContain("MOST APPLICABLE FIRST");
    expect(prompt).toContain('"supports"');
  });

  it("keeps the grounding rules: no invention, no unsupported job-description phrases", () => {
    expect(prompt).toMatch(/never invent employers, dates, tools, metrics/i);
    expect(prompt).toMatch(/never import job-description phrases/i);
  });

  it("carries the work history and job description through", () => {
    expect(prompt).toContain("Beta Inc");
    expect(prompt).toContain("Full job description text.");
  });

  it("keeps degrees and schools out of selectedSkills", () => {
    expect(prompt).toMatch(/never restate a degree or school as a skill/i);
    expect(prompt).toMatch(/never a degree, school, or other education credential/i);
  });
});

describe("validateSelectedResumeEvidence", () => {
  it("throws when the model returned something other than an object", () => {
    expect(() => validateSelectedResumeEvidence(null)).toThrow(/fit selection/i);
    expect(() => validateSelectedResumeEvidence("nope")).toThrow(/fit selection/i);
  });

  it("preserves bullet order and normalizes bullets to { text, supports }", () => {
    const result = validateSelectedResumeEvidence({
      selectedWorkHistory: [
        {
          position: "PM",
          company: "Beta Inc",
          fit: "strong",
          selectedBullets: [
            { text: " Built churn model ", supports: " Build predictive models " },
            "Presented findings to leadership",
            { text: "", supports: "dropped — empty" },
            42,
            { text: "Ran roadmap", supports: 7 },
          ],
        },
      ],
    });

    expect(result.selectedWorkHistory[0].selectedBullets).toEqual([
      { text: "Built churn model", supports: "Build predictive models" },
      { text: "Presented findings to leadership", supports: "" },
      { text: "Ran roadmap", supports: "" },
    ]);
  });

  it("coerces unknown fit tiers to supporting and drops malformed roles", () => {
    const result = validateSelectedResumeEvidence({
      fitSummary: " Fits well. ",
      selectedWorkHistory: [{ position: "PM", fit: "AMAZING" }, "not a role", null],
      selectedSkills: ["Python"],
    });

    expect(result.fitSummary).toBe("Fits well.");
    expect(result.selectedWorkHistory).toHaveLength(1);
    expect(result.selectedWorkHistory[0].fit).toBe("supporting");
    expect(result.selectedSkills).toEqual(["Python"]);
    expect(result.excludedItems).toEqual([]);
  });
});

describe("validateSelectedResumeEvidence education filtering", () => {
  const profileWithEducation = {
    name: "Sam Jones",
    education: [{ school: "Hofstra University", degree: "BBA, Finance & Marketing", year: "2010" }],
  };

  it("drops skills that restate a stored degree or school, even reworded", () => {
    const result = validateSelectedResumeEvidence(
      {
        selectedSkills: [
          "BBA, Finance & Marketing",
          "BBA in Finance & Marketing — Hofstra University",
          "Hofstra University",
          "SQL",
        ],
      },
      profileWithEducation
    );
    expect(result.selectedSkills).toEqual(["SQL"]);
  });

  it("keeps real skills that only share words with a credential", () => {
    const result = validateSelectedResumeEvidence(
      { selectedSkills: ["Marketing", "Finance", "Product Marketing"] },
      profileWithEducation
    );
    expect(result.selectedSkills).toEqual(["Marketing", "Finance", "Product Marketing"]);
  });

  it("matches a single-word credential only exactly", () => {
    const result = validateSelectedResumeEvidence(
      { selectedSkills: ["MBA", "MBA admissions consulting"] },
      { education: [{ school: "", degree: "MBA", year: "2015" }] }
    );
    expect(result.selectedSkills).toEqual(["MBA admissions consulting"]);
  });

  it("passes skills through untouched without stored education or a profile", () => {
    const withEmpty = validateSelectedResumeEvidence({ selectedSkills: ["Python"] }, { education: [] });
    expect(withEmpty.selectedSkills).toEqual(["Python"]);
    const withoutProfile = validateSelectedResumeEvidence({ selectedSkills: ["Python"] });
    expect(withoutProfile.selectedSkills).toEqual(["Python"]);
  });
});

describe("ensureRequiredRolesSelected", () => {
  const requiredItem = {
    id: "w1",
    position: "Analyst",
    company: "Gamma LLC",
    startMonth: "03",
    startYear: "2019",
    endMonth: "",
    endYear: "present",
    description: "- Analyzed retention\n- Automated reporting",
  };
  const coverage = { requiredRoles: [{ item: requiredItem, reason: "current" }] };

  it("appends a dropped mandatory role as timeline-only with bullets from its description", () => {
    const result = ensureRequiredRolesSelected(
      { selectedWorkHistory: [] },
      coverage,
      [requiredItem]
    );

    expect(result.selectedWorkHistory).toHaveLength(1);
    const appended = result.selectedWorkHistory[0];
    expect(appended.fit).toBe("timeline-only");
    expect(appended.selectedBullets).toEqual([
      { text: "Analyzed retention", supports: "" },
      { text: "Automated reporting", supports: "" },
    ]);
  });

  it("splits a paragraph-style description into separate backfill bullets", () => {
    const paragraphItem = {
      id: "w3",
      position: "PM",
      company: "Delta Co",
      startYear: "2016",
      description:
        "Analyzed retention across cohorts. Automated reporting in Python. Presented findings to leadership.",
    };
    const paragraphCoverage = { requiredRoles: [{ item: paragraphItem, reason: "covers-gap" }] };

    const result = ensureRequiredRolesSelected({ selectedWorkHistory: [] }, paragraphCoverage, [paragraphItem]);

    expect(result.selectedWorkHistory[0].selectedBullets.map((bullet) => bullet.text)).toEqual([
      "Analyzed retention across cohorts.",
      "Automated reporting in Python.",
      "Presented findings to leadership.",
    ]);
  });

  it("leaves the selection alone when the required role is already there, even reworded", () => {
    const selected = {
      selectedWorkHistory: [
        { position: "Data Analyst", company: "gamma llc", startYear: "2019", fit: "strong", selectedBullets: [] },
      ],
    };
    const result = ensureRequiredRolesSelected(selected, coverage, [requiredItem]);
    expect(result.selectedWorkHistory).toHaveLength(1);
    expect(result.selectedWorkHistory[0].fit).toBe("strong");
  });

  it("passes through untouched when there is no coverage requirement", () => {
    const evidence = { selectedWorkHistory: [] };
    expect(ensureRequiredRolesSelected(evidence, null, [])).toBe(evidence);
  });
});

describe("composeResume", () => {
  const selectedEvidence = {
    fitSummary: "Strong analytics background.",
    selectedWorkHistory: [
      {
        position: "Product Manager",
        company: "Beta Inc",
        fit: "strong",
        selectedBullets: [{ text: "Built churn model", supports: "Build predictive models on employee data" }],
      },
    ],
    selectedSkills: ["Python"],
  };

  const prompt = composeResume({
    profile,
    selectedEvidence,
    jobAnalysis,
    instructions: "Full job description text.",
    coverage: null,
  });

  it("forbids presenting the target job title as the candidate's identity", () => {
    expect(prompt).toMatch(/NEVER use the target job's title/i);
    expect(prompt).toMatch(/HAS ACTUALLY BEEN/);
    // The summary must argue fit via responsibilities, not a claimed identity.
    expect(prompt).toMatch(/Never open with the target job title/i);
    expect(prompt).toMatch(/argue fit through the job's key responsibilities/i);
  });

  it("instructs the composer to keep the pre-ranked bullet order", () => {
    expect(prompt).toMatch(/KEEP each role's bullets in the given order/i);
    expect(prompt).toMatch(/already ranked most-applicable-first/i);
  });

  it("confines education to its own section", () => {
    expect(prompt).toContain("education appears ONLY under EDUCATION");
    expect(prompt).toMatch(/only when it clearly satisfies an education requirement/i);
  });

  it("passes the job analysis, profile headline, and evidence through", () => {
    expect(prompt).toContain("Build predictive models on employee data");
    expect(prompt).toContain('"Product Manager"');
    expect(prompt).toContain("Built churn model");
    expect(prompt).toContain("Full job description text.");
  });

  it("adds the continuity instruction only when coverage requires roles", () => {
    const withCoverage = composeResume({
      profile,
      selectedEvidence,
      jobAnalysis,
      instructions: "",
      coverage: { requiredRoles: [{ item: { id: "w1" } }] },
    });
    expect(withCoverage).toMatch(/Do not drop roles that cover employment gaps/i);
    expect(prompt).not.toMatch(/Do not drop roles that cover employment gaps/i);
  });
});
