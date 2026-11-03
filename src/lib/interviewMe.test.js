import { describe, it, expect, vi } from "vitest";
import {
  buildInterviewQuestionPrompt,
  checkInterviewQuestion,
  buildInterviewSuggestionsPrompt,
  checkInterviewSuggestions,
  buildInterviewRepairPrompt,
  formatInterviewTranscript,
  askInterviewQuestion,
  suggestFromInterview,
  MAX_EXAMPLES,
} from "./interviewMe";

// A real interview, from the role-play that shaped this flow.
const CHATTREPORT = {
  position: "Founder",
  company: "ChattReport",
  tenure: "3 months",
  description:
    "Built Chattanooga's most comprehensive events calendar, pulling in events from over 250 sources, posting on average over 150 events per week. Grown the newsletter to over hundreds of subscribers with less than a 1% unsubscribe rate.",
  transcript: [
    {
      context: "Your description says ChattReport pulls events from over 250 sources.",
      question: "How do you collect all those events?",
      answer:
        "a combo of setting up scrapers and creating processes to ingest instagram posts. at first it was by hand. hours and hours per week.",
    },
    {
      context: "You went from hours of manual work each week to scrapers.",
      question: "Roughly how many hours a week did it take by hand, and how many does it take now?",
      answer: "8-10 hours a week down to 2ish",
    },
    {
      context: "Your description says the newsletter has over hundreds of subscribers.",
      question: "About how many subscribers does it have today?",
      answer: "150",
    },
    {
      context: "You said growth was mostly word of mouth.",
      question: "Besides Instagram, where else did you share ChattReport?",
      answer: "",
      skipped: true,
    },
    {
      context: "Your description mentions a low unsubscribe rate.",
      question: "How many people have unsubscribed?",
      answer: "only 1/151 so far. about 5k saw our last instagram post.",
    },
  ],
};

describe("formatInterviewTranscript", () => {
  it("keeps skipped turns so the model moves on instead of re-asking", () => {
    const text = formatInterviewTranscript(CHATTREPORT.transcript);
    expect(text).toContain("Q: Besides Instagram, where else did you share ChattReport?\nA: (skipped)");
    expect(text).toContain("A: 150");
  });
});

describe("buildInterviewQuestionPrompt", () => {
  it("gives the model the title, company, time in role, description, and conversation", () => {
    const prompt = buildInterviewQuestionPrompt(CHATTREPORT);
    expect(prompt).toContain('job as "Founder" at ChattReport');
    expect(prompt).toContain("Time in the role: about 3 months");
    expect(prompt).toContain("over 250 sources");
    expect(prompt).toContain("A: 8-10 hours a week down to 2ish");
  });

  it("marks the first question when nothing has been asked yet", () => {
    const prompt = buildInterviewQuestionPrompt({ position: "Founder", transcript: [] });
    expect(prompt).toContain("(this is the first question)");
    expect(prompt).toContain("(nothing written yet)");
  });
});

describe("checkInterviewQuestion", () => {
  const good = {
    heard: "So collecting events went from 8–10 hours a week to about 2.",
    context: "You said ChattReport also reads Instagram posts.",
    question: "How does a flyer image become a calendar listing?",
    examples: ["I type it in", "Software reads the image", "A mix of both"],
  };

  it("passes a turn in the format", () => {
    const { turn, problems } = checkInterviewQuestion(good, { transcript: CHATTREPORT.transcript });
    expect(problems).toEqual([]);
    expect(turn).toEqual(good);
  });

  it("flags two questions joined together", () => {
    // The first role-play opener: one turn asking two things.
    const { problems } = checkInterviewQuestion({
      ...good,
      question: "What do you do Monday to Sunday? How do you get 150 events posted?",
    });
    expect(problems.join(" ")).toMatch(/exactly one question/);
  });

  it("flags a question with no context pointing back to what they said", () => {
    const { problems } = checkInterviewQuestion({ ...good, context: "  " });
    expect(problems.join(" ")).toMatch(/"context" is empty/);
  });

  it("flags a question already asked", () => {
    const { problems } = checkInterviewQuestion(
      { ...good, question: "About how many subscribers does it have today?" },
      { transcript: CHATTREPORT.transcript }
    );
    expect(problems.join(" ")).toMatch(/already asked/);
  });

  it("dedupes and caps examples, and flags too few", () => {
    const many = checkInterviewQuestion({
      ...good,
      examples: ["A", "a", "B", "C", "D", "E"],
    });
    expect(many.turn.examples).toEqual(["A", "B", "C", "D"].slice(0, MAX_EXAMPLES));

    const few = checkInterviewQuestion({ ...good, examples: ["Only one"] });
    expect(few.problems.join(" ")).toMatch(/"examples" needs/);
  });

  it("returns no turn when there is no question at all", () => {
    expect(checkInterviewQuestion(null).turn).toBeNull();
    expect(checkInterviewQuestion({ context: "x" }).turn).toBeNull();
  });
});

describe("buildInterviewSuggestionsPrompt", () => {
  it("frames suggestions as business problems and carries the interview", () => {
    const prompt = buildInterviewSuggestionsPrompt(CHATTREPORT);
    expect(prompt).toContain('"problem"');
    expect(prompt).toContain('"left_out"');
    expect(prompt).toContain("A: only 1/151 so far");
  });
});

describe("checkInterviewSuggestions", () => {
  it("passes bullets whose numbers all came from the person, including 5k as 5,000 and derived percentages", () => {
    const { suggestions, problems } = checkInterviewSuggestions(
      {
        suggestions: [
          {
            problem: "Cut manual data entry",
            bullet:
              "Replaced 8–10 hours a week of copying events by hand with web scrapers and an Instagram import, cutting the work to about 2 hours (about 80% less).",
          },
          {
            problem: "Grew an audience with no ad spend",
            bullet: "Grew to 150 subscribers in 3 months with 1 unsubscribe out of 151, and one post reached about 5,000 people.",
          },
        ],
        left_out: ["Newsletter open rate, since it's unknown."],
      },
      CHATTREPORT
    );
    expect(problems).toEqual([]);
    expect(suggestions.every((entry) => entry.grounded)).toBe(true);
  });

  it("flags a number the person never gave", () => {
    const { suggestions, problems } = checkInterviewSuggestions(
      {
        suggestions: [
          { problem: "Grew an audience", bullet: "Grew the newsletter to 500 subscribers in 3 months." },
        ],
      },
      CHATTREPORT
    );
    expect(problems.join(" ")).toMatch(/uses 500, which the person never said/);
    expect(suggestions[0].grounded).toBe(false);
  });

  it("flags first-person openings and missing problem labels", () => {
    const { problems } = checkInterviewSuggestions(
      { suggestions: [{ problem: "", bullet: "I built the scrapers myself." }] },
      CHATTREPORT
    );
    expect(problems.join(" ")).toMatch(/past-tense verb/);
    expect(problems.join(" ")).toMatch(/Add a "problem" label/);
  });

  it("drops a suggestion that repeats the current description", () => {
    const { suggestions, problems } = checkInterviewSuggestions(
      {
        suggestions: [
          {
            problem: "Built a calendar",
            bullet: "Grown the newsletter to over hundreds of subscribers with less than a 1% unsubscribe rate.",
          },
        ],
      },
      CHATTREPORT
    );
    expect(suggestions).toEqual([]);
    expect(problems.join(" ")).toMatch(/"suggestions" is empty/);
  });
});

describe("askInterviewQuestion", () => {
  it("sends one repair carrying the problems and the original prompt, then uses the fixed turn", async () => {
    const callJson = vi
      .fn()
      .mockResolvedValueOnce({ heard: "", context: "", question: "What tools? Which ones?", examples: [] })
      .mockResolvedValueOnce({
        heard: "",
        context: "You said you set up scrapers.",
        question: "What did you build the scrapers with?",
        examples: ["Python", "JavaScript", "A paid tool"],
      });

    const turn = await askInterviewQuestion(callJson, CHATTREPORT);

    expect(turn.question).toBe("What did you build the scrapers with?");
    expect(callJson).toHaveBeenCalledTimes(2);
    const [repairPrompt, repairMeta] = callJson.mock.calls[1];
    expect(repairPrompt).toContain("<fix_these>");
    expect(repairPrompt).toContain("exactly one question");
    expect(repairMeta.repairOf).toBe(callJson.mock.calls[0][0]);
  });

  it("skips the repair when the first answer is in the format", async () => {
    const callJson = vi.fn().mockResolvedValue({
      heard: "",
      context: "Your description says 250 sources.",
      question: "How do you find new sources?",
      examples: ["Instagram", "Venue websites"],
    });
    await askInterviewQuestion(callJson, CHATTREPORT);
    expect(callJson).toHaveBeenCalledTimes(1);
  });

  it("keeps the first answer when the repair call fails", async () => {
    const callJson = vi
      .fn()
      .mockResolvedValueOnce({ heard: "", context: "", question: "How do you find new sources?", examples: ["A", "B"] })
      .mockRejectedValueOnce(new Error("upstream"));
    const turn = await askInterviewQuestion(callJson, CHATTREPORT);
    expect(turn.question).toBe("How do you find new sources?");
  });

  it("throws when neither call produced a question", async () => {
    const callJson = vi.fn().mockResolvedValue({});
    await expect(askInterviewQuestion(callJson, CHATTREPORT)).rejects.toThrow(/next question/);
  });
});

describe("suggestFromInterview", () => {
  it("drops suggestions still carrying an invented number after the repair", async () => {
    const invented = {
      suggestions: [
        { problem: "Grew an audience", bullet: "Grew the newsletter to 500 subscribers." },
        { problem: "Cut manual data entry", bullet: "Cut weekly event collection from 8–10 hours to about 2." },
      ],
      left_out: [],
    };
    const callJson = vi.fn().mockResolvedValue(invented);

    const result = await suggestFromInterview(callJson, CHATTREPORT);

    expect(callJson).toHaveBeenCalledTimes(2);
    expect(result.suggestions).toEqual([
      { problem: "Cut manual data entry", bullet: "Cut weekly event collection from 8–10 hours to about 2." },
    ]);
  });
});

describe("buildInterviewRepairPrompt", () => {
  it("appends the previous answer and the list of fixes to the original prompt", () => {
    const prompt = buildInterviewRepairPrompt("ORIGINAL", { question: "x" }, ["Fix A", "Fix B"]);
    expect(prompt.startsWith("ORIGINAL")).toBe(true);
    expect(prompt).toContain('"question": "x"');
    expect(prompt).toContain("- Fix A\n- Fix B");
  });
});
