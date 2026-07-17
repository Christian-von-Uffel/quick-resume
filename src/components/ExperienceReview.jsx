import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  CLARITY_REVIEW_STEPS,
  CLARITY_REWRITE_STEPS,
  validateClarityReview,
} from "../lib/clarifyExperience";
import { PROMPTS } from "../lib/prompts";
import {
  newMetricId,
  startClarityReview,
  recordQuestionsPresented,
  recordQuestionAnswered,
  recordSuggestionPresented,
  recordSuggestionAccepted,
  recordSuggestionRejected,
} from "../lib/metrics";
import { PipelineSteps } from "./PipelineSteps";

// How long the prepare step stays visibly active before results land. The
// validate pass itself is sync, so without this beat React never paints it.
const PREPARE_STEP_VISIBLE_MS = 450;

// Inline "clarity review" panel for a single work-history position. On open it asks
// the model which sentences are hard to read; for each it shows a plain question with
// pickable interpretations (plus a free-text "Something else"). When the model also
// suggested job skills, tools, or collaborators the sentence might imply, a second
// multi-select step lets the person confirm which applied (or "None of these") before
// the rewrite is fetched. Accepting replaces the sentence in the description.
export function ExperienceReview({
  position,
  company,
  description,
  reviewSentences,
  proposeRewrite,
  onAcceptSentence,
  onClose,
}) {
  // "loading" | "ready" | "empty" | "error"
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [items, setItems] = useState([]);
  // Index into CLARITY_REVIEW_STEPS while the initial scan runs (-1 = idle).
  // On success this stays at steps.length so the completed checklist remains
  // above the findings (avoids a layout jump from unmounting the list).
  // Kept on failure so the step list can show WHERE the run died.
  const [stepIndex, setStepIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const cancelledRef = useRef(false);
  const panelRef = useRef(null);
  // The clarity_reviews row these questions and suggestions hang off.
  const reviewIdRef = useRef(null);

  // The trigger button lives at the top of a tall position card, so this panel
  // opens below the fold and the review looks like it did nothing. Pull it into
  // view on open ("nearest" no-ops when it's already visible, so a card near the
  // top of the screen doesn't get yanked).
  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    setStepIndex(0);
    setFailed(false);
    // Minted before the call so its cost records against this review, even
    // though the clarity_reviews row itself isn't written until the questions
    // survive validation.
    reviewIdRef.current = newMetricId();

    (async () => {
      try {
        // Step 1: one LLM call flags the hardest-to-read sentences.
        const parsed = await reviewSentences({ position, description, runId: reviewIdRef.current });
        if (cancelledRef.current) return;

        // Step 2: paint the prepare stage before validating. Without flushSync,
        // React batches this with the finish and the user never sees it.
        flushSync(() => {
          setStepIndex(1);
        });
        const found = validateClarityReview(parsed);
        if (cancelledRef.current) return;

        await new Promise((resolve) => setTimeout(resolve, PREPARE_STEP_VISIBLE_MS));
        if (cancelledRef.current) return;

        // Leave the checklist mounted with every step checked — hiding it here
        // would collapse the panel the moment results appear.
        setStepIndex(CLARITY_REVIEW_STEPS.length);

        // Recorded after validation and after the no-options drop, so
        // "presented" counts the questions the person could actually answer.
        startClarityReview({ id: reviewIdRef.current, position, company });
        const questionIds = recordQuestionsPresented(
          { clarityReviewId: reviewIdRef.current },
          found.map((item) => ({
            promptKey: PROMPTS.CLARITY_REVIEW,
            question: item.question,
            options: item.options,
          }))
        );

        setItems(
          found.map((item, index) => ({
            ...item,
            questionId: questionIds[index],
            // per-item runtime state
            choice: null, // selected option text or the custom answer
            usingCustom: false,
            customAnswer: "",
            selectedSkills: [], // confirmed entries from item.skillOptions
            skillsNone: false, // explicitly answered "none of these"
            proposal: "",
            proposalStatus: "idle", // "idle" | "loading" | "ready" | "error"
            proposalError: "",
            resolution: null, // "accepted" | "rejected"
          }))
        );
        setStatus(found.length ? "ready" : "empty");
      } catch (err) {
        if (cancelledRef.current) return;
        // Leave stepIndex where it was so the step list shows which stage failed.
        setFailed(true);
        setError(err instanceof Error ? err.message : "Could not review this description.");
        setStatus("error");
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
    // Reviews a snapshot of the description once per open; the parent remounts this
    // component (keyed by position id) whenever a fresh review is wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateItem = (id, patch) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  };

  // Functional update so rapid toggles never overwrite each other with a stale list.
  const toggleSkill = (id, skill) => {
    setItems((current) =>
      current.map((item) => {
        if (item.id !== id) return item;
        const selectedSkills = item.selectedSkills.includes(skill)
          ? item.selectedSkills.filter((entry) => entry !== skill)
          : [...item.selectedSkills, skill];
        return { ...item, selectedSkills, skillsNone: false };
      })
    );
  };

  const requestProposal = async (item, clarification) => {
    const trimmed = clarification.trim();
    if (!trimmed) return;

    updateItem(item.id, {
      choice: trimmed,
      proposal: "",
      proposalStatus: "loading",
      proposalError: "",
      resolution: null,
    });

    // Asking for a rewrite IS the answer to the question: the person either
    // picked one of the offered interpretations or typed their own.
    const pickedOption = item.options.includes(trimmed);
    recordQuestionAnswered(item.questionId, {
      selectedOptions: pickedOption ? [trimmed] : [],
      answerText: pickedOption ? "" : trimmed,
    });

    try {
      const proposal = await proposeRewrite({
        position,
        sentence: item.sentence,
        clarification: trimmed,
        skills: item.skillsNone ? [] : item.selectedSkills,
        runId: reviewIdRef.current,
      });
      if (cancelledRef.current) return;
      if (!proposal) {
        updateItem(item.id, {
          proposalStatus: "error",
          proposalError: "The model did not return a rewrite. Try another answer.",
        });
        return;
      }
      // Re-answering yields a fresh suggestion row: the earlier one really was
      // shown and really wasn't accepted.
      const suggestionId = recordSuggestionPresented(
        { clarityReviewId: reviewIdRef.current },
        { suggestion: proposal, promptKey: PROMPTS.CLARITY_REWRITE, questionId: item.questionId }
      );
      updateItem(item.id, { proposal, proposalStatus: "ready", suggestionId });
    } catch (err) {
      if (cancelledRef.current) return;
      updateItem(item.id, {
        proposalStatus: "error",
        proposalError: err instanceof Error ? err.message : "Could not propose a rewrite.",
      });
    }
  };

  const handleAccept = (item) => {
    onAcceptSentence(item.sentence, item.proposal);
    updateItem(item.id, { resolution: "accepted" });
    recordSuggestionAccepted(item.suggestionId);
  };

  const handleReject = (item) => {
    updateItem(item.id, { resolution: "rejected" });
    recordSuggestionRejected(item.suggestionId);
  };

  return (
    <div ref={panelRef} className="mt-3 scroll-my-24 rounded-lg border border-blue-500/40 bg-blue-500/5 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-600 dark:text-blue-300">
          Clarity review
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
        >
          Close
        </button>
      </div>

      {stepIndex >= 0 && (
        <PipelineSteps
          steps={CLARITY_REVIEW_STEPS}
          stepIndex={stepIndex}
          failed={failed}
        />
      )}

      {status === "error" && (
        <p className="mt-2 text-sm text-red-400">{error}</p>
      )}

      {status === "empty" && (
        <p className="mt-2 text-sm text-neutral-400">
          Nothing here reads as confusing — this description looks clear.
        </p>
      )}

      {status === "ready" && (
        <div className="mt-3 space-y-4">
          {items.map((item) => {
            // With skill suggestions the rewrite waits for an explicit "Get suggestion"
            // click so the person can confirm skills first; without them, picking an
            // interpretation fetches the rewrite immediately as before.
            const hasSkillOptions = item.skillOptions.length > 0;
            const clarification = item.usingCustom ? item.customAnswer : item.choice ?? "";
            const rewriteStepIndex =
              item.proposalStatus === "loading" || item.proposalStatus === "error"
                ? 0
                : item.proposalStatus === "ready"
                  ? CLARITY_REWRITE_STEPS.length
                  : -1;
            const rewriteFailed = item.proposalStatus === "error";

            return (
            <div
              key={item.id}
              className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3"
            >
              <p className="text-sm text-neutral-300">
                <span className="text-neutral-500">Sentence: </span>
                <span className="italic">“{item.sentence}”</span>
              </p>
              {item.reason && (
                <p className="mt-1 text-xs text-neutral-500">{item.reason}</p>
              )}

              {item.resolution === "accepted" ? (
                <p className="mt-2 text-sm text-emerald-500 dark:text-emerald-400">
                  ✓ Replaced with “{item.proposal}”
                </p>
              ) : item.resolution === "rejected" ? (
                <p className="mt-2 text-sm text-neutral-500">
                  Kept the original sentence.
                </p>
              ) : (
                <>
                  <p className="mt-3 text-sm font-medium text-neutral-200">
                    {item.question}
                  </p>

                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.options.map((option, index) => {
                      const active = !item.usingCustom && item.choice === option.trim();
                      return (
                        <button
                          key={index}
                          type="button"
                          onClick={() => {
                            if (hasSkillOptions) {
                              updateItem(item.id, {
                                usingCustom: false,
                                choice: option.trim(),
                                proposal: "",
                                proposalStatus: "idle",
                                proposalError: "",
                              });
                            } else {
                              updateItem(item.id, { usingCustom: false });
                              requestProposal(item, option);
                            }
                          }}
                          className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                            active
                              ? "border-blue-500 bg-blue-500/20 text-neutral-50"
                              : "border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-50"
                          }`}
                        >
                          {option}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => updateItem(item.id, { usingCustom: true })}
                      className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                        item.usingCustom
                          ? "border-blue-500 bg-blue-500/20 text-neutral-50"
                          : "border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-50"
                      }`}
                    >
                      Something else…
                    </button>
                  </div>

                  {item.usingCustom && (
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        value={item.customAnswer}
                        onChange={(e) => updateItem(item.id, { customAnswer: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            requestProposal(item, item.customAnswer);
                          }
                        }}
                        placeholder="In your own words, what did you mean?"
                        className="flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                      />
                      {!hasSkillOptions && (
                        <button
                          type="button"
                          onClick={() => requestProposal(item, item.customAnswer)}
                          disabled={!item.customAnswer.trim()}
                          className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Get suggestion
                        </button>
                      )}
                    </div>
                  )}

                  {hasSkillOptions && (item.choice !== null || item.usingCustom) && (
                    <>
                      <p className="mt-3 text-sm font-medium text-neutral-200">
                        Were any of these part of this work? Select all that apply.
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {item.skillOptions.map((skill, index) => {
                          const active = item.selectedSkills.includes(skill);
                          return (
                            <button
                              key={index}
                              type="button"
                              onClick={() => toggleSkill(item.id, skill)}
                              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                                active
                                  ? "border-blue-500 bg-blue-500/20 text-neutral-50"
                                  : "border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-50"
                              }`}
                            >
                              {skill}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() =>
                            updateItem(item.id, { selectedSkills: [], skillsNone: true })
                          }
                          className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                            item.skillsNone
                              ? "border-blue-500 bg-blue-500/20 text-neutral-50"
                              : "border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-50"
                          }`}
                        >
                          None of these
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => requestProposal(item, clarification)}
                        disabled={!clarification.trim()}
                        className="mt-3 rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Get suggestion
                      </button>
                    </>
                  )}

                  <PipelineSteps
                    steps={CLARITY_REWRITE_STEPS}
                    stepIndex={rewriteStepIndex}
                    failed={rewriteFailed}
                  />

                  {item.proposalStatus === "error" && (
                    <p className="mt-2 text-sm text-red-400">{item.proposalError}</p>
                  )}

                  {item.proposalStatus === "ready" && (
                    <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900/70 p-3">
                      <p className="text-xs uppercase tracking-widest text-neutral-500">
                        Suggested rewrite
                      </p>
                      <p className="mt-1 text-sm text-neutral-100">{item.proposal}</p>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleAccept(item)}
                          className="rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-500/25 dark:text-emerald-200"
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          onClick={() => handleReject(item)}
                          className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                        >
                          Reject
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
