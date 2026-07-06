import { describe, it, expect } from "vitest";
import {
  validateClarityReview,
  replaceSentence,
  cleanSuggestedSentence,
  buildClaritySuggestionPrompt,
} from "./clarifyExperience";

describe("validateClarityReview", () => {
  it("keeps well-formed items and assigns stable ids", () => {
    const parsed = {
      confusingSentences: [
        {
          sentence: "Drove cross-functional synergy across the org.",
          reason: "Vague buzzwords.",
          question: 'What do you mean by "cross-functional synergy"?',
          options: ["Coordinated engineering and design", "Ran weekly standups"],
        },
      ],
    };

    const result = validateClarityReview(parsed);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("clarify-0");
    expect(result[0].options).toHaveLength(2);
    expect(result[0].skillOptions).toEqual([]);
  });

  it("normalizes skillOptions: trims, dedupes case-insensitively, caps at six", () => {
    const parsed = {
      confusingSentences: [
        {
          sentence: "Conducted comprehensive primary user research.",
          options: ["Interviewed users directly"],
          skillOptions: [
            " User interviews ",
            "user interviews",
            "Figma",
            "",
            42,
            "Surveys",
            "Usability testing",
            "Collaborated with engineering",
            "Collaborated with design",
            "Miro",
            "Notion",
          ],
        },
      ],
    };

    const result = validateClarityReview(parsed);
    expect(result[0].skillOptions).toEqual([
      "User interviews",
      "Figma",
      "Surveys",
      "Usability testing",
      "Collaborated with engineering",
      "Collaborated with design",
    ]);
  });

  it("drops items with no usable sentence or no options", () => {
    const parsed = {
      confusingSentences: [
        { sentence: "   ", options: ["something"] },
        { sentence: "Owned the thing.", options: [] },
        { sentence: "Managed stuff.", options: ["Led a team of five", "", "  "] },
      ],
    };

    const result = validateClarityReview(parsed);
    expect(result).toHaveLength(1);
    expect(result[0].sentence).toBe("Managed stuff.");
    expect(result[0].options).toEqual(["Led a team of five"]);
  });

  it("caps options at three and falls back to a default question", () => {
    const parsed = {
      confusingSentences: [
        {
          sentence: "Handled logistics.",
          options: ["a", "b", "c", "d"],
        },
      ],
    };

    const result = validateClarityReview(parsed);
    expect(result[0].options).toEqual(["a", "b", "c"]);
    expect(result[0].question).toBe('What do you mean by "Handled logistics."?');
  });

  it("throws when the payload is not an object", () => {
    expect(() => validateClarityReview(null)).toThrow();
    expect(() => validateClarityReview([])).toThrow();
  });
});

describe("buildClaritySuggestionPrompt", () => {
  it("includes confirmed skills as facts when provided", () => {
    const prompt = buildClaritySuggestionPrompt({
      position: "Product Manager",
      sentence: "Conducted comprehensive primary user research.",
      clarification: "Interviewed users directly to understand their needs.",
      skills: [" User interviews ", "Figma", "", "Collaborated with engineering"],
    });

    expect(prompt).toContain("<confirmed_skills_and_tools>");
    expect(prompt).toContain("- User interviews");
    expect(prompt).toContain("- Figma");
    expect(prompt).toContain("- Collaborated with engineering");
    expect(prompt).toContain("treat those as facts");
  });

  it("omits the skills block when no skills are confirmed", () => {
    const withoutSkills = buildClaritySuggestionPrompt({
      position: "Product Manager",
      sentence: "Conducted comprehensive primary user research.",
      clarification: "Interviewed users directly.",
    });
    const withEmptySkills = buildClaritySuggestionPrompt({
      position: "Product Manager",
      sentence: "Conducted comprehensive primary user research.",
      clarification: "Interviewed users directly.",
      skills: ["  ", ""],
    });

    expect(withoutSkills).not.toContain("<confirmed_skills_and_tools>");
    expect(withEmptySkills).not.toContain("<confirmed_skills_and_tools>");
  });
});

describe("replaceSentence", () => {
  it("replaces an exact substring match", () => {
    const description = "Led the team.\nDrove synergy across the org.\nShipped v2.";
    const { description: next, replaced } = replaceSentence(
      description,
      "Drove synergy across the org.",
      "Coordinated the engineering and design teams."
    );

    expect(replaced).toBe(true);
    expect(next).toBe(
      "Led the team.\nCoordinated the engineering and design teams.\nShipped v2."
    );
  });

  it("matches a bulleted line ignoring the marker and preserves the prefix", () => {
    const description = "- Led the team.\n- Drove synergy across the org.";
    const { description: next, replaced } = replaceSentence(
      description,
      "Drove synergy across the org.",
      "Coordinated engineering and design."
    );

    expect(replaced).toBe(true);
    expect(next).toBe("- Led the team.\n- Coordinated engineering and design.");
  });

  it("cleans a bullet marker off the proposed replacement", () => {
    const { description: next } = replaceSentence(
      "Owned the roadmap.",
      "Owned the roadmap.",
      "- Set the product roadmap for the year."
    );

    expect(next).toBe("Set the product roadmap for the year.");
  });

  it("returns replaced=false and the original text when nothing matches", () => {
    const description = "Led the team.";
    const { description: next, replaced } = replaceSentence(
      description,
      "Some sentence that is not present.",
      "A rewrite."
    );

    expect(replaced).toBe(false);
    expect(next).toBe(description);
  });

  it("does nothing when the replacement is empty", () => {
    const { replaced } = replaceSentence("Led the team.", "Led the team.", "   ");
    expect(replaced).toBe(false);
  });
});

describe("cleanSuggestedSentence", () => {
  it("strips fences, bullets, and wrapping quotes", () => {
    expect(cleanSuggestedSentence('- "Shipped the release."')).toBe(
      "Shipped the release."
    );
  });
});
