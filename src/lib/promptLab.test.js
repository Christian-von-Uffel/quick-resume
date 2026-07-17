import { describe, it, expect } from "vitest";
import {
  CHALLENGER_PLACEHOLDERS,
  CHALLENGER_SEEDS,
  adaptChallengerQuestions,
  formatProfileForPrompt,
  formatWorkHistoryForPrompt,
  renderPromptTemplate,
} from "./promptLab";
import { validateOpeningQuestions } from "./enrichExperience";
import { validateMissingExperienceReview } from "./reviewExperience";
import { validateClarityReview } from "./clarifyExperience";

const exampleSchemaOf = (seed) =>
  seed.match(/<ExampleSchema>\s*([\s\S]*?)\s*<\/ExampleSchema>/)?.[1] ?? "";

describe("renderPromptTemplate", () => {
  it("substitutes placeholders with their values", () => {
    const text = renderPromptTemplate("<JobTitle>$jobTitle</JobTitle>", { jobTitle: "Line Cook" });
    expect(text).toBe("<JobTitle>Line Cook</JobTitle>");
  });

  it("replaces longer placeholder names before shorter prefixes of them", () => {
    const text = renderPromptTemplate("$jobTitle / $job", { job: "JD", jobTitle: "Cook" });
    expect(text).toBe("Cook / JD");
  });

  it("keeps dollar signs inside values literal", () => {
    const text = renderPromptTemplate("<D>$details</D>", { details: "Raised $2m ($& and $$)" });
    expect(text).toBe("<D>Raised $2m ($& and $$)</D>");
  });

  it("leaves unknown placeholders visible instead of blanking them", () => {
    const text = renderPromptTemplate("$jobTitle $typoedName", { jobTitle: "Cook" });
    expect(text).toBe("Cook $typoedName");
  });

  it("renders missing values as empty strings", () => {
    const text = renderPromptTemplate("[$company]", { company: undefined });
    expect(text).toBe("[]");
  });
});

describe("prompt variable formatting", () => {
  it("formats work history as readable role blocks", () => {
    const text = formatWorkHistoryForPrompt([
      {
        position: "Data Scientist",
        company: "Beta Inc",
        startMonth: "03",
        startYear: "2019",
        endYear: "present",
        description: "- Built churn models",
      },
    ]);
    expect(text).toContain("Data Scientist at Beta Inc (March 2019 — Present)");
    expect(text).toContain("- Built churn models");
  });

  it("says so when there is no work history", () => {
    expect(formatWorkHistoryForPrompt([])).toBe("(no work history saved)");
  });

  it("formats a profile with contact and education lines", () => {
    const text = formatProfileForPrompt({
      name: "Sam Doe",
      headline: "Analyst",
      email: "sam@example.com",
      education: [{ degree: "BBA", school: "Hofstra", year: "2015" }],
    });
    expect(text).toContain("Name: Sam Doe");
    expect(text).toContain("Contact: sam@example.com");
    expect(text).toContain("- BBA — Hofstra — 2015");
  });
});

describe("adaptChallengerQuestions", () => {
  it("wraps bare strings as yes/no questions", () => {
    const adapted = adaptChallengerQuestions({ questions: ["Did you work the line?"] });
    expect(adapted.questions).toEqual([{ kind: "yes_no", question: "Did you work the line?" }]);
  });

  it("gives kind-less, option-less objects the yes/no kind", () => {
    const adapted = adaptChallengerQuestions({ questions: [{ question: "Did anyone report to you?" }] });
    expect(adapted.questions[0].kind).toBe("yes_no");
  });

  it("leaves richer questions untouched", () => {
    const rich = { kind: "multi_select", question: "Who do you work with?", options: ["Customers", "Engineers"] };
    const adapted = adaptChallengerQuestions({ questions: [rich] });
    expect(adapted.questions[0]).toBe(rich);
  });

  it("passes non-question shapes through unchanged", () => {
    expect(adaptChallengerQuestions(null)).toBe(null);
    const noList = { bullets: ["x"] };
    expect(adaptChallengerQuestions(noList)).toBe(noList);
  });
});

/* The behaviors the lab's variant wiring depends on, verified against the REAL
   production validators (originally probed in __lab_probe.test.js). */
describe("challenger output through production validators", () => {
  it("adapted plain-string questions survive validateOpeningQuestions as Yes/No questions", () => {
    const schema = JSON.parse(exampleSchemaOf(CHALLENGER_SEEDS.expand));
    const kept = validateOpeningQuestions(adaptChallengerQuestions(schema));
    expect(kept).toHaveLength(3);
    expect(kept.every((question) => question.kind === "yes_no")).toBe(true);
    expect(kept.every((question) => question.options.join("/") === "Yes/No")).toBe(true);
  });

  it("natural yes/no phrasings would be dropped by the production GAP validator", () => {
    // This is WHY the challenger column validates through the questions shape:
    // the gap validator's broad-phrase gate rejects wording like "or", which
    // interview-style yes/no questions use constantly.
    const workHistory = [{ id: "w1", position: "Data Scientist", company: "Beta Inc" }];
    const kept = validateMissingExperienceReview(
      {
        missingExperienceDetails: [
          { skill: "Mentoring", question: "Did you mentor or coach anyone at Beta Inc?" },
          { skill: "Exec comms", question: "At Beta Inc, did you present to executives, yes or no?" },
        ],
      },
      workHistory
    );
    expect(kept).toHaveLength(0);
  });

  it("the {questions: [...]} shape scores a structural zero on the production gap validator", () => {
    const schema = JSON.parse(exampleSchemaOf(CHALLENGER_SEEDS.gap));
    expect(validateMissingExperienceReview(schema, [])).toEqual([]);
  });

  it("the clarity seed's example schema survives the production clarity validator", () => {
    const schema = JSON.parse(exampleSchemaOf(CHALLENGER_SEEDS.clarity));
    const kept = validateClarityReview(schema);
    expect(kept).toHaveLength(1);
    expect(kept[0].options.length).toBeGreaterThanOrEqual(2);
  });
});

describe("challenger seeds", () => {
  it("only use placeholders the lab declares (and fills) for their feature", () => {
    for (const [feature, seed] of Object.entries(CHALLENGER_SEEDS)) {
      const declared = new Set((CHALLENGER_PLACEHOLDERS[feature] ?? []).map(([token]) => token));
      const used = seed.match(/\$[a-zA-Z]+/g) ?? [];
      expect(used.length).toBeGreaterThan(0);
      for (const token of used) {
        expect(declared, `${feature} seed uses undeclared ${token}`).toContain(token);
      }
    }
  });

  it("gap and expand example schemas are valid JSON", () => {
    for (const feature of ["gap", "expand"]) {
      const parsed = JSON.parse(exampleSchemaOf(CHALLENGER_SEEDS[feature]));
      expect(Array.isArray(parsed.questions)).toBe(true);
      expect(parsed.questions).toHaveLength(3);
    }
  });
});
