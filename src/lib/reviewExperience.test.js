import { describe, it, expect } from "vitest";
import {
  MISSING_EXPERIENCE_KINDS,
  MISSING_EXPERIENCE_KIND_LABELS,
  MAX_MISSING_EXPERIENCE_ITEMS,
  buildMissingExperienceReviewPrompt,
  validateMissingExperienceReview,
  MAX_COVERED_SKILLS,
  validateCoveredSkills,
  buildSkillsChecklist,
  cleanFormattedDetail,
} from "./reviewExperience";

const workHistory = [
  { id: "w1", position: "Senior Product Manager", company: "Beta Inc", description: "- Built churn model" },
  { id: "w2", position: "Business Analyst", company: "Gamma LLC", description: "- Reporting" },
];

describe("buildMissingExperienceReviewPrompt", () => {
  const prompt = buildMissingExperienceReviewPrompt({
    workHistory,
    jobDescription: "Senior Data Scientist. Influence senior stakeholders. Mentor junior team members. FAISS.",
  });

  it("sweeps every kind of experience, not just tools", () => {
    for (const kind of MISSING_EXPERIENCE_KINDS) {
      expect(prompt).toContain(`"${kind}"`);
    }
    expect(prompt).toMatch(/AT MOST a third of your items may be kind "tool"/i);
  });

  it("asks the model to connect gaps to existing roles it names verbatim", () => {
    expect(prompt).toContain("likelyRoles");
    expect(prompt).toMatch(/VERBATIM from the work history/i);
    expect(prompt).toMatch(/PLAUSIBLY involved/i);
    expect(prompt).toMatch(/candidates for the person to confirm, NOT facts/i);
  });

  it("embeds the work history and job description", () => {
    expect(prompt).toContain("Beta Inc");
    expect(prompt).toContain("Influence senior stakeholders");
  });
});

describe("validateMissingExperienceReview", () => {
  it("throws when the model returned something other than an object", () => {
    expect(() => validateMissingExperienceReview(null, workHistory)).toThrow(/missing experience/i);
    expect(() => validateMissingExperienceReview([], workHistory)).toThrow(/missing experience/i);
  });

  it("keeps well-formed items with stable ids and resolved likely roles", () => {
    const result = validateMissingExperienceReview(
      {
        missingExperienceDetails: [
          {
            skill: "Executive communication",
            kind: "communication",
            whyItMatters: "The posting stresses influencing senior stakeholders.",
            question: "When you built churn models at Beta Inc, did you present the results to executives?",
            likelyRoles: [
              { position: "Senior Product Manager", company: "Beta Inc", why: "Model work implies readouts." },
            ],
            plainspokenDetail: "Presented model results to senior leadership.",
            answerPlaceholder: "Yes, I presented quarterly model results to our VP.",
          },
        ],
      },
      workHistory
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("missing-0");
    expect(result[0].kind).toBe("communication");
    expect(result[0].likelyRoles).toEqual([
      { workId: "w1", label: "Senior Product Manager at Beta Inc", why: "Model work implies readouts." },
    ]);
  });

  it("accepts broad-competency questions while rejecting bundled ones", () => {
    const result = validateMissingExperienceReview(
      {
        missingExperienceDetails: [
          { skill: "Mentoring", question: "Have you mentored junior teammates?" },
          { skill: "Ambiguity", question: "Have you turned a vague request into a concrete project plan?" },
          { skill: "Bundled", question: "Do you have experience with SQL and Python?" },
          { skill: "Either", question: "Did you use FAISS or Chroma?" },
          { skill: "Catch-all", question: "Did you handle various stakeholder tasks?" },
        ],
      },
      workHistory
    );

    expect(result.map((detail) => detail.skill)).toEqual(["Mentoring", "Ambiguity"]);
  });

  it("coerces unknown kinds to responsibility and fills placeholder fallbacks", () => {
    const result = validateMissingExperienceReview(
      { missingExperienceDetails: [{ skill: "RAG architectures", kind: "buzzword" }] },
      workHistory
    );

    expect(result[0].kind).toBe("responsibility");
    expect(result[0].question).toBe("Do you have experience with RAG architectures?");
    expect(result[0].plainspokenDetail).toBe("Experience with RAG architectures.");
    expect(result[0].answerPlaceholder).toMatch(/^Yes, I /);
    expect(result[0].likelyRoles).toEqual([]);
  });

  it("drops likely roles that do not match any stored work item", () => {
    const result = validateMissingExperienceReview(
      {
        missingExperienceDetails: [
          {
            skill: "People analytics",
            question: "Have you analyzed workforce data?",
            likelyRoles: [
              { position: "Imaginary Director", company: "Nowhere Corp", why: "hallucinated" },
              { position: "business analyst", company: "GAMMA LLC", why: "case-insensitive match" },
            ],
          },
        ],
      },
      workHistory
    );

    expect(result[0].likelyRoles).toEqual([
      { workId: "w2", label: "Business Analyst at Gamma LLC", why: "case-insensitive match" },
    ]);
  });

  it("adds a question mark when the model forgot one", () => {
    const result = validateMissingExperienceReview(
      { missingExperienceDetails: [{ skill: "SQL", question: "Have you written SQL against a data warehouse." }] },
      workHistory
    );
    expect(result[0].question).toBe("Have you written SQL against a data warehouse?");
  });

  it("dedupes skills case-insensitively and caps the list", () => {
    const details = Array.from({ length: 20 }, (_, i) => ({
      skill: i < 2 ? "SQL" : `Skill ${i}`,
      question: `Have you used skill ${i}?`,
    }));
    details[1].skill = "sql";

    const result = validateMissingExperienceReview({ missingExperienceDetails: details }, workHistory);
    expect(result).toHaveLength(MAX_MISSING_EXPERIENCE_ITEMS);
    expect(result.filter((d) => d.skill.toLowerCase() === "sql")).toHaveLength(1);
  });
});

describe("kind labels", () => {
  it("provides a badge label for every kind", () => {
    for (const kind of MISSING_EXPERIENCE_KINDS) {
      expect(MISSING_EXPERIENCE_KIND_LABELS[kind]).toBeTruthy();
    }
  });
});

describe("cleanFormattedDetail", () => {
  it("strips fences, bullets, quotes, and collapses lines", () => {
    expect(cleanFormattedDetail('```\n- "Presented results\nto execs"\n```')).toBe("Presented results to execs");
    expect(cleanFormattedDetail(null)).toBe("");
  });
});

describe("coveredSkills in the gap review", () => {
  it("asks for what the history already shows alongside the gaps", () => {
    const prompt = buildMissingExperienceReviewPrompt({ workHistory, jobDescription: "SQL. Mentoring." });
    expect(prompt).toContain('"coveredSkills"');
    expect(prompt).toMatch(/a stored detail shows outright/i);
    expect(prompt).toContain(`Up to ${MAX_COVERED_SKILLS} items`);
  });

  it("keeps covered skills whose evidence resolves to a stored role", () => {
    const result = validateCoveredSkills(
      {
        coveredSkills: [
          {
            skill: "Churn modelling",
            kind: "method",
            evidence: [
              { position: "senior product manager", company: "Beta Inc", detail: "Built churn model" },
              { position: "Imaginary Director", company: "Nowhere Corp", detail: "hallucinated" },
            ],
          },
        ],
      },
      workHistory
    );

    expect(result).toEqual([
      {
        id: "covered-0",
        skill: "Churn modelling",
        kind: "method",
        evidence: [{ workId: "w1", label: "Senior Product Manager at Beta Inc", detail: "Built churn model" }],
      },
    ]);
  });

  it("drops a check mark that points at nothing in the stored history", () => {
    const result = validateCoveredSkills(
      {
        coveredSkills: [
          { skill: "SQL", evidence: [] },
          { skill: "Python", evidence: [{ position: "Wizard", company: "Hogwarts", detail: "spells" }] },
          { skill: "Reporting", evidence: [{ position: "Business Analyst", company: "Gamma LLC", detail: "Reporting" }] },
        ],
      },
      workHistory
    );

    expect(result.map((item) => item.skill)).toEqual(["Reporting"]);
    expect(result[0].kind).toBe("responsibility");
  });

  it("dedupes case-insensitively, caps the list, and tolerates a missing key", () => {
    const evidence = [{ position: "Business Analyst", company: "Gamma LLC" }];
    const many = Array.from({ length: MAX_COVERED_SKILLS + 3 }, (_, i) => ({ skill: `Skill ${i}`, evidence }));
    const result = validateCoveredSkills(
      { coveredSkills: [{ skill: "sql", evidence }, { skill: "SQL", evidence }, ...many] },
      workHistory
    );

    expect(result).toHaveLength(MAX_COVERED_SKILLS);
    expect(result.filter((item) => item.skill.toLowerCase() === "sql")).toHaveLength(1);
    expect(validateCoveredSkills({ missingExperienceDetails: [] }, workHistory)).toEqual([]);
    expect(validateCoveredSkills(null, workHistory)).toEqual([]);
  });
});

describe("buildSkillsChecklist", () => {
  const covered = [
    { skill: "SQL", kind: "tool", evidence: [{ workId: "w2", label: "Business Analyst at Gamma LLC", detail: "Reporting" }] },
    { skill: "Mentoring", kind: "leadership", evidence: [] },
  ];
  const gaps = [
    { skill: "BigQuery", kind: "tool" },
    { skill: "Jira", kind: "tool" },
    { skill: "Confluence", kind: "tool" },
    { skill: "mentoring", kind: "leadership" },
  ];

  it("lists covered skills first, then the gap questions in their asked order", () => {
    const { items } = buildSkillsChecklist({ covered, gaps });
    expect(items.map((item) => [item.skill, item.status])).toEqual([
      ["SQL", "covered"],
      ["BigQuery", "open"],
      ["Jira", "open"],
      ["Confluence", "open"],
      ["mentoring", "open"],
    ]);
    expect(items[0].evidence[0].label).toBe("Business Analyst at Gamma LLC");
  });

  it("leads each group with explicitly named tools, keeping the rest in order", () => {
    const { items } = buildSkillsChecklist({
      covered: [
        { skill: "Experimentation", kind: "method" },
        { skill: "Stakeholder reporting", kind: "communication" },
        { skill: "SQL", kind: "tool" },
        { skill: "Python", kind: "tool" },
      ],
      gaps: [
        { skill: "Mentoring", kind: "leadership" },
        { skill: "Ambiguity", kind: "approach" },
        { skill: "Confluence", kind: "tool" },
        { skill: "Jira", kind: "tool" },
      ],
    });
    expect(items.map((item) => item.skill)).toEqual([
      "SQL",
      "Python",
      "Experimentation",
      "Stakeholder reporting",
      "Confluence",
      "Jira",
      "Mentoring",
      "Ambiguity",
    ]);
  });

  it("lets a question override a covered claim about the same skill", () => {
    const { items } = buildSkillsChecklist({ covered, gaps });
    expect(items.filter((item) => item.skill.toLowerCase() === "mentoring")).toHaveLength(1);
    expect(items.find((item) => item.skill === "mentoring").status).toBe("open");
  });

  it("reflects the person's answers with saved winning over confirmed and dismissed", () => {
    const { items, counts } = buildSkillsChecklist({
      covered,
      gaps,
      confirmedSkills: ["BigQuery", "Jira"],
      dismissedSkills: ["Jira", "Confluence"],
      savedSkills: ["Jira"],
    });
    expect(Object.fromEntries(items.map((item) => [item.skill, item.status]))).toEqual({
      SQL: "covered",
      BigQuery: "confirmed",
      Jira: "added",
      Confluence: "dismissed",
      mentoring: "open",
    });
    expect(counts).toEqual({ covered: 1, added: 1, confirmed: 1, dismissed: 1, open: 1 });
  });

  it("is empty when there is nothing to show", () => {
    expect(buildSkillsChecklist()).toEqual({
      items: [],
      counts: { covered: 0, added: 0, confirmed: 0, dismissed: 0, open: 0 },
    });
  });
});
