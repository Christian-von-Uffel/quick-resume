import { describe, it, expect } from "vitest";
import {
  buildOpeningQuestionsPrompt,
  validateOpeningQuestions,
  buildFollowupQuestionsPrompt,
  validateFollowupQuestions,
  buildComposePrompt,
  validateComposedBullets,
  MAX_QA_ROUNDS,
  appendDetailToDescription,
  isSparseDescription,
} from "./enrichExperience";

describe("validateOpeningQuestions", () => {
  it("keeps well-formed questions, assigns round-1 ids, and mirrors multiSelect from kind", () => {
    const parsed = {
      questions: [
        {
          kind: "single_select",
          question: "What do you spend most of your time doing?",
          options: ["Writing code", "Talking to customers"],
        },
        {
          kind: "multi_select",
          question: "Which of these are also part of your week?",
          options: ["Hiring", "Reviewing code", "Demos"],
        },
      ],
    };

    const result = validateOpeningQuestions(parsed);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("q-1-0");
    expect(result[0].multiSelect).toBe(false);
    expect(result[1].id).toBe("q-1-1");
    expect(result[1].multiSelect).toBe(true);
  });

  it("forces yes_no options to Yes/No and single-select regardless of what the model sent", () => {
    const parsed = {
      questions: [
        {
          kind: "yes_no",
          question: "Do you manage anyone?",
          options: ["Absolutely", "Not really", "Sometimes"],
        },
      ],
    };

    const [question] = validateOpeningQuestions(parsed);
    expect(question.kind).toBe("yes_no");
    expect(question.options).toEqual(["Yes", "No"]);
    expect(question.multiSelect).toBe(false);
  });

  it("defaults an unknown or blank kind to single_select", () => {
    const parsed = {
      questions: [
        { kind: "dropdown", question: "What do you build?", options: ["Apps", "APIs"] },
        { question: "Where do you focus?", options: ["Frontend", "Backend"] },
      ],
    };

    const result = validateOpeningQuestions(parsed);
    expect(result[0].kind).toBe("single_select");
    expect(result[1].kind).toBe("single_select");
  });

  it("trims, collapses whitespace, dedupes options case-insensitively, and caps options at six", () => {
    const parsed = {
      questions: [
        {
          kind: "multi_select",
          question: "  Which   things  do you do? ",
          options: [
            " Writing code ",
            "writing code",
            "Reviewing",
            "Planning",
            "Demos",
            "Hiring",
            "Mentoring",
            "Firefighting",
          ],
        },
      ],
    };

    const [question] = validateOpeningQuestions(parsed);
    expect(question.question).toBe("Which things do you do?");
    expect(question.options).toEqual([
      "Writing code",
      "Reviewing",
      "Planning",
      "Demos",
      "Hiring",
      "Mentoring",
    ]);
  });

  it("drops single/multi questions with fewer than two usable options", () => {
    const parsed = {
      questions: [
        { kind: "single_select", question: "Only one?", options: ["a", "", "  ", "A"] },
        { kind: "single_select", question: "Two?", options: ["a", "b"] },
      ],
    };

    const result = validateOpeningQuestions(parsed);
    expect(result).toHaveLength(1);
    expect(result[0].question).toBe("Two?");
  });

  it("dedupes questions by text and caps the round at three questions", () => {
    const parsed = {
      questions: [
        { kind: "single_select", question: "What do you do?", options: ["a", "b"] },
        { kind: "single_select", question: "what do you do?", options: ["c", "d"] },
        { kind: "single_select", question: "Who for?", options: ["a", "b"] },
        { kind: "single_select", question: "How often?", options: ["a", "b"] },
        { kind: "single_select", question: "With whom?", options: ["a", "b"] },
      ],
    };

    const result = validateOpeningQuestions(parsed);
    expect(result).toHaveLength(3);
    expect(result.map((q) => q.question)).toEqual(["What do you do?", "Who for?", "How often?"]);
  });

  it("throws when the payload is not a plain object", () => {
    expect(() => validateOpeningQuestions(null)).toThrow();
    expect(() => validateOpeningQuestions([])).toThrow();
  });
});

describe("validateFollowupQuestions", () => {
  it("returns questions with round-scoped ids when the model asks more", () => {
    const parsed = {
      enough: false,
      questions: [
        { kind: "single_select", question: "Which side are you on?", options: ["Front", "Back"] },
        { kind: "multi_select", question: "Who counts on it?", options: ["Customers", "Peers"] },
      ],
    };

    const result = validateFollowupQuestions(parsed, { round: 3 });
    expect(result.enough).toBe(false);
    expect(result.questions.map((q) => q.id)).toEqual(["q-3-0", "q-3-1"]);
  });

  it("returns { enough: true, questions: [] } when the model signals it has enough", () => {
    const result = validateFollowupQuestions({ enough: true, questions: [] }, { round: 2 });
    expect(result).toEqual({ enough: true, questions: [] });
  });

  it("coerces an all-dropped batch to enough:true regardless of the model flag", () => {
    const parsed = {
      enough: false,
      questions: [{ kind: "single_select", question: "", options: [] }],
    };

    expect(validateFollowupQuestions(parsed, { round: 2 })).toEqual({
      enough: true,
      questions: [],
    });
  });

  it("throws when the payload is not a plain object", () => {
    expect(() => validateFollowupQuestions(null, { round: 2 })).toThrow();
    expect(() => validateFollowupQuestions([], { round: 2 })).toThrow();
  });
});

describe("validateComposedBullets", () => {
  it("cleans, dedupes, and caps composed bullets", () => {
    const parsed = {
      bullets: [
        '- "Built the product full-stack, owning the database schema."',
        "Built the product full-stack, owning the database schema.",
        "Ran customer demos and wrote the product specs.",
        "Handled deploys and monitoring for the team.",
        "One bullet too many that should be dropped.",
      ],
    };

    const result = validateComposedBullets(parsed);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("Built the product full-stack, owning the database schema.");
    expect(result).toContain("Ran customer demos and wrote the product specs.");
  });

  it("drops empty bullets", () => {
    const result = validateComposedBullets({ bullets: ["   ", "Shipped the release."] });
    expect(result).toEqual(["Shipped the release."]);
  });

  it("throws when the payload is not a plain object", () => {
    expect(() => validateComposedBullets(null)).toThrow();
    expect(() => validateComposedBullets([])).toThrow();
  });
});

describe("buildOpeningQuestionsPrompt", () => {
  it("includes the tenure block and company only when given", () => {
    const withTenure = buildOpeningQuestionsPrompt({
      position: "Technical Founder",
      company: "UseStackWise",
      description: "Built stuff.",
      tenure: "2 yrs",
    });
    const withoutTenure = buildOpeningQuestionsPrompt({
      position: "Technical Founder",
      description: "Built stuff.",
    });

    expect(withTenure).toContain("<tenure>");
    expect(withTenure).toContain("About 2 yrs in the role.");
    expect(withTenure).toContain("at UseStackWise");
    expect(withoutTenure).not.toContain("<tenure>");
  });

  it("marks an empty description and keeps the grounding + anti-wordslop guardrails", () => {
    const prompt = buildOpeningQuestionsPrompt({ position: "Technical Founder", description: "  " });
    expect(prompt).toContain("(they haven't written anything yet)");
    expect(prompt).toContain("What do you spend most of your time on?");
    expect(prompt).toContain("How many people work at the company?");
    expect(prompt).toContain("Do you manage other people, or do the work yourself?");
    expect(prompt).toContain("FORBIDDEN");
    expect(prompt).toContain("Stakeholder management");
  });
});

describe("buildFollowupQuestionsPrompt", () => {
  it("renders each transcript entry as a Q/A pair and skips incomplete ones", () => {
    const prompt = buildFollowupQuestionsPrompt({
      position: "Technical Founder",
      description: "Built stuff.",
      transcript: [
        { question: "What do you spend most time on?", answer: "Writing code" },
        { question: "Who for?", answer: "" },
        { question: "", answer: "orphaned" },
      ],
      round: 2,
      maxRounds: MAX_QA_ROUNDS,
    });

    expect(prompt).toContain("Q: What do you spend most time on?\nA: Writing code");
    expect(prompt).not.toContain("orphaned");
    expect(prompt).not.toContain("Who for?");
    expect(prompt).toContain(`round 2 of at most ${MAX_QA_ROUNDS}`);
    expect(prompt).toContain("ask more in a later round");
  });

  it("requires the problems and collaborators questions before it may stop", () => {
    const prompt = buildFollowupQuestionsPrompt({
      position: "Technical Founder",
      description: "Built stuff.",
      transcript: [{ question: "What do you spend most time on?", answer: "Writing code" }],
      round: 2,
      maxRounds: MAX_QA_ROUNDS,
    });

    expect(prompt).toContain("must cover ALL THREE of these before you set \"enough\" to true");
    expect(prompt).toContain("Which problems do you work on?");
    expect(prompt).toContain("Who do you work with?");
  });

  it("switches to the prefer-stop wording on the final round", () => {
    const prompt = buildFollowupQuestionsPrompt({
      position: "Technical Founder",
      description: "Built stuff.",
      transcript: [{ question: "What do you do?", answer: "Code" }],
      round: MAX_QA_ROUNDS,
      maxRounds: MAX_QA_ROUNDS,
    });

    expect(prompt).toContain("This is the FINAL round.");
    expect(prompt).not.toContain("ask more in a later round");
  });
});

describe("buildComposePrompt", () => {
  it("includes the transcript, the banned-words guardrail, and what's already written", () => {
    const prompt = buildComposePrompt({
      position: "Technical Founder",
      description: "Built the MVP.",
      transcript: [{ question: "What do you spend most time on?", answer: "Writing code" }],
    });

    expect(prompt).toContain("Q: What do you spend most time on?\nA: Writing code");
    expect(prompt).toContain("Banned words:");
    expect(prompt).toContain("<already_written>");
    expect(prompt).toContain("Built the MVP.");
  });

  it("marks an empty transcript", () => {
    const prompt = buildComposePrompt({ position: "Technical Founder", transcript: [] });
    expect(prompt).toContain("(no answers were given)");
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
