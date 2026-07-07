import { useEffect, useRef, useState } from "react";
import { MAX_ENRICH_AREAS_PER_ROUND } from "../lib/enrichExperience";

const chipClass = (active) =>
  `rounded-lg border px-3 py-1.5 text-sm transition-colors ${
    active
      ? "border-violet-500 bg-violet-500/20 text-neutral-50"
      : "border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-50"
  }`;

// Inline "add details" panel for a single work-history position. On open it asks
// the model which responsibilities job postings for this title usually require
// (minus what the description already shows) and offers them as chips. For each
// confirmed area a short set of click-to-answer questions (specifics, scale,
// outcome, ownership, tools) feeds one composed bullet the person can accept,
// which appends to the description.
export function EnrichExperience({
  position,
  company,
  description,
  tenureLabel,
  loadAreas,
  loadQuestions,
  composeBullet,
  onAcceptBullet,
  onClose,
}) {
  // "areas-loading" | "areas" | "areas-empty" | "questions-loading" | "questions" | "error"
  const [step, setStep] = useState("areas-loading");
  const [error, setError] = useState("");
  const [areas, setAreas] = useState([]);
  const [selectedAreaIds, setSelectedAreaIds] = useState([]);
  const [areaItems, setAreaItems] = useState([]);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    (async () => {
      try {
        const found = await loadAreas({ position, company, description, tenureLabel });
        if (cancelledRef.current) return;
        setAreas(found);
        setStep(found.length ? "areas" : "areas-empty");
      } catch (err) {
        if (cancelledRef.current) return;
        setError(err instanceof Error ? err.message : "Could not look up responsibilities for this role.");
        setStep("error");
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
    // Enriches a snapshot of the description once per open; the parent remounts
    // this component (keyed by position id) whenever a fresh round is wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleArea = (areaId) => {
    setSelectedAreaIds((current) => {
      if (current.includes(areaId)) return current.filter((id) => id !== areaId);
      if (current.length >= MAX_ENRICH_AREAS_PER_ROUND) return current;
      return [...current, areaId];
    });
  };

  const handleContinue = async () => {
    const chosen = areas.filter((entry) => selectedAreaIds.includes(entry.id));
    if (!chosen.length) return;

    setStep("questions-loading");
    try {
      const grouped = await loadQuestions({
        position,
        company,
        description,
        areas: chosen.map((entry) => entry.area),
      });
      if (cancelledRef.current) return;
      if (!grouped.length) {
        setError("The model did not return usable questions. Try again.");
        setStep("error");
        return;
      }
      setAreaItems(
        grouped.map((group) => ({
          ...group,
          questions: group.questions.map((question) => ({
            ...question,
            // per-question runtime state
            choice: null, // single-select answer
            choices: [], // multi-select answers (tools)
            usingCustom: false,
            customAnswer: "",
            skipped: false,
          })),
          // per-area runtime state
          proposal: "",
          proposalStatus: "idle", // "idle" | "loading" | "ready" | "error"
          proposalError: "",
          resolution: null, // "accepted" | "rejected"
        }))
      );
      setStep("questions");
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : "Could not build questions for those areas.");
      setStep("error");
    }
  };

  const updateArea = (area, patch) => {
    setAreaItems((current) =>
      current.map((item) => (item.area === area ? { ...item, ...patch } : item))
    );
  };

  const updateQuestion = (area, questionId, patch) => {
    setAreaItems((current) =>
      current.map((item) => {
        if (item.area !== area) return item;
        return {
          ...item,
          questions: item.questions.map((question) =>
            question.id === questionId ? { ...question, ...patch } : question
          ),
        };
      })
    );
  };

  // Functional update so rapid toggles never overwrite each other with a stale list.
  const toggleQuestionChoice = (area, questionId, option) => {
    setAreaItems((current) =>
      current.map((item) => {
        if (item.area !== area) return item;
        return {
          ...item,
          questions: item.questions.map((question) => {
            if (question.id !== questionId) return question;
            const choices = question.choices.includes(option)
              ? question.choices.filter((entry) => entry !== option)
              : [...question.choices, option];
            return { ...question, choices, skipped: false, usingCustom: false };
          }),
        };
      })
    );
  };

  const collectAnswers = (item) =>
    item.questions
      .map((question) => {
        if (question.skipped) return null;
        if (question.usingCustom && question.customAnswer.trim()) {
          return { question: question.question, answer: question.customAnswer.trim() };
        }
        if (question.multiSelect && question.choices.length) {
          return { question: question.question, answer: question.choices.join(", ") };
        }
        if (!question.multiSelect && question.choice) {
          return { question: question.question, answer: question.choice };
        }
        return null;
      })
      .filter(Boolean);

  const handleCompose = async (item) => {
    const answers = collectAnswers(item);
    if (!answers.length) return;

    updateArea(item.area, {
      proposal: "",
      proposalStatus: "loading",
      proposalError: "",
      resolution: null,
    });

    try {
      const proposal = await composeBullet({ position, area: item.area, answers });
      if (cancelledRef.current) return;
      if (!proposal) {
        updateArea(item.area, {
          proposalStatus: "error",
          proposalError: "The model did not return a detail. Try adjusting your answers.",
        });
        return;
      }
      updateArea(item.area, { proposal, proposalStatus: "ready" });
    } catch (err) {
      if (cancelledRef.current) return;
      updateArea(item.area, {
        proposalStatus: "error",
        proposalError: err instanceof Error ? err.message : "Could not write a detail.",
      });
    }
  };

  const handleAccept = (item) => {
    onAcceptBullet(item.proposal);
    updateArea(item.area, { resolution: "accepted" });
  };

  const handleReject = (item) => {
    updateArea(item.area, { resolution: "rejected" });
  };

  return (
    <div className="mt-3 rounded-lg border border-violet-500/40 bg-violet-500/5 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-300">
          Add details
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
        >
          Close
        </button>
      </div>

      {step === "areas-loading" && (
        <p className="mt-2 text-sm text-neutral-400">
          Looking up what jobs with this title usually involve...
        </p>
      )}

      {step === "error" && <p className="mt-2 text-sm text-red-400">{error}</p>}

      {step === "areas-empty" && (
        <p className="mt-2 text-sm text-neutral-400">
          Nothing to add — this description already covers what postings for this title ask for.
        </p>
      )}

      {step === "areas" && (
        <>
          <p className="mt-3 text-sm font-medium text-neutral-200">
            Jobs titled “{position?.trim() || "this role"}” usually include these responsibilities.
            Which were part of your role{company?.trim() ? ` at ${company.trim()}` : ""}?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {areas.map((entry) => {
              const active = selectedAreaIds.includes(entry.id);
              const atCap = !active && selectedAreaIds.length >= MAX_ENRICH_AREAS_PER_ROUND;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => toggleArea(entry.id)}
                  disabled={atCap}
                  title={entry.whyEmployersAsk || undefined}
                  className={`${chipClass(active)} disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  {entry.area}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            Pick up to {MAX_ENRICH_AREAS_PER_ROUND} at a time. Hover a chip to see why employers ask
            about it.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleContinue}
              disabled={!selectedAreaIds.length}
              className="rounded-lg border border-violet-500/50 bg-violet-500/15 px-3 py-2 text-sm font-medium text-violet-700 transition-colors hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-50 dark:text-violet-200"
            >
              Continue
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
            >
              None of these apply
            </button>
          </div>
        </>
      )}

      {step === "questions-loading" && (
        <p className="mt-2 text-sm text-neutral-400">
          Writing a few quick questions about that work...
        </p>
      )}

      {step === "questions" && (
        <div className="mt-3 space-y-4">
          {areaItems.map((item) => {
            const answerCount = collectAnswers(item).length;

            return (
              <div
                key={item.area}
                className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3"
              >
                <p className="text-sm font-semibold text-neutral-200">{item.area}</p>

                {item.resolution === "accepted" ? (
                  <p className="mt-2 text-sm text-emerald-500 dark:text-emerald-400">
                    ✓ Added “{item.proposal}”
                  </p>
                ) : item.resolution === "rejected" ? (
                  <p className="mt-2 text-sm text-neutral-500">Skipped this detail.</p>
                ) : (
                  <>
                    <div className="mt-2 space-y-3">
                      {item.questions.map((question) => (
                        <div key={question.id}>
                          <p className="text-sm font-medium text-neutral-200">
                            {question.question}
                            {question.multiSelect && (
                              <span className="ml-1.5 text-xs font-normal text-neutral-500">
                                Select all that apply.
                              </span>
                            )}
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-2">
                            {question.options.map((option, index) => {
                              const active = question.multiSelect
                                ? question.choices.includes(option)
                                : !question.usingCustom && question.choice === option;
                              return (
                                <button
                                  key={index}
                                  type="button"
                                  onClick={() =>
                                    question.multiSelect
                                      ? toggleQuestionChoice(item.area, question.id, option)
                                      : updateQuestion(item.area, question.id, {
                                          choice: option,
                                          usingCustom: false,
                                          skipped: false,
                                        })
                                  }
                                  className={chipClass(active)}
                                >
                                  {option}
                                </button>
                              );
                            })}
                            <button
                              type="button"
                              onClick={() =>
                                updateQuestion(item.area, question.id, {
                                  usingCustom: true,
                                  skipped: false,
                                })
                              }
                              className={chipClass(question.usingCustom)}
                            >
                              Something else…
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                updateQuestion(item.area, question.id, {
                                  skipped: true,
                                  usingCustom: false,
                                  choice: null,
                                  choices: [],
                                })
                              }
                              className={chipClass(question.skipped)}
                            >
                              Skip
                            </button>
                          </div>
                          {question.usingCustom && (
                            <input
                              type="text"
                              value={question.customAnswer}
                              onChange={(e) =>
                                updateQuestion(item.area, question.id, {
                                  customAnswer: e.target.value,
                                })
                              }
                              placeholder="In your own words..."
                              className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                            />
                          )}
                        </div>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleCompose(item)}
                      disabled={!answerCount || item.proposalStatus === "loading"}
                      className="mt-3 rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Write this detail
                    </button>

                    {item.proposalStatus === "loading" && (
                      <p className="mt-2 text-sm text-neutral-400">
                        Writing a detail from your answers...
                      </p>
                    )}

                    {item.proposalStatus === "error" && (
                      <p className="mt-2 text-sm text-red-400">{item.proposalError}</p>
                    )}

                    {item.proposalStatus === "ready" && (
                      <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900/70 p-3">
                        <p className="text-xs uppercase tracking-widest text-neutral-500">
                          Suggested detail
                        </p>
                        <p className="mt-1 text-sm text-neutral-100">{item.proposal}</p>
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleAccept(item)}
                            className="rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-500/25 dark:text-emerald-200"
                          >
                            Add to description
                          </button>
                          <button
                            type="button"
                            onClick={() => handleReject(item)}
                            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                          >
                            Skip
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
