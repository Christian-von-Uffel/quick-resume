import { useEffect, useRef, useState } from "react";
import { MAX_QA_ROUNDS } from "../lib/enrichExperience";
import { PROMPTS } from "../lib/prompts";
import {
  newMetricId,
  startExperienceExpansion,
  recordExpansionRounds,
  recordQuestionsPresented,
  recordQuestionAnswered,
  recordQuestionSkipped,
  recordSuggestionPresented,
  recordSuggestionAccepted,
  recordSuggestionRejected,
} from "../lib/metrics";

const chipClass = (active) =>
  `rounded-lg border px-3 py-1.5 text-sm transition-colors ${
    active
      ? "border-violet-500 bg-violet-500/20 text-neutral-50"
      : "border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-50"
  }`;

// Attach the per-question runtime answer state a fresh round of questions needs.
const withRuntimeState = (questions) =>
  questions.map((question) => ({
    ...question,
    choice: null, // single-select / yes-no answer
    choices: [], // multi-select answers
    usingCustom: false,
    customAnswer: "",
    skipped: false,
  }));

// Turn a round's answered questions into transcript entries { question, answer }.
// Skipped and unanswered questions drop out; multi-select answers join with commas.
const collectAnswers = (questions) =>
  questions
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

// Inline "Expand experience" panel for a single work-history position. Rather than
// guessing what job postings for the title demand, it runs a short, adaptive
// interview: a couple of dead-simple grounded questions about what the person
// actually does, then follow-up rounds that branch off their own answers, then a
// compose step that turns the whole transcript into a few plainspoken bullets the
// person can add to the description.
export function EnrichExperience({
  position,
  company,
  description,
  tenureLabel,
  loadOpening,
  loadFollowups,
  composeBullets,
  onAcceptBullet,
  onClose,
}) {
  // "loading" | "answering" | "review" | "error"
  const [status, setStatus] = useState("loading");
  // Which async step is (or was) running: "opening" | "followups" | "compose".
  // Drives the loading copy and what a "Try again" retries.
  const [loadingKind, setLoadingKind] = useState("opening");
  const [round, setRound] = useState(1); // 1 = opening, 2..MAX_QA_ROUNDS = follow-ups
  const [questions, setQuestions] = useState([]); // this round's questions
  const [transcript, setTranscript] = useState([]); // accumulated { question, answer }
  const [bullets, setBullets] = useState([]); // [{ text, resolution: null|"accepted"|"rejected" }]
  const [error, setError] = useState("");

  const cancelledRef = useRef(false);
  const panelRef = useRef(null);
  // Holds a thunk that re-runs the last async step with its exact arguments, so
  // "Try again" always retries what actually failed (right transcript and round).
  const retryRef = useRef(null);
  // The experience_expansions row this interview's questions and bullets hang
  // off, and the questions.id for each question on screen this round.
  const expansionIdRef = useRef(null);
  const questionIdsRef = useRef({});

  // The trigger button lives at the top of a tall position card, so this panel
  // opens below the fold. Pull it into view on open ("nearest" no-ops when it's
  // already visible, so a card near the top of the screen isn't yanked).
  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  // Run the opening batch once on open. The parent remounts this component (keyed
  // by position id) whenever a fresh interview is wanted, so this snapshots the
  // description at open time.
  useEffect(() => {
    cancelledRef.current = false;
    // Minted before the first call so every round's cost records against this
    // interview; the row itself waits until there are questions to show.
    expansionIdRef.current = newMetricId();
    runOpening();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One row per question on screen, keyed by question id so answering or
  // skipping can find it later.
  const rememberQuestions = (found, roundNumber, promptKey) => {
    const ids = recordQuestionsPresented(
      { experienceExpansionId: expansionIdRef.current },
      found.map((question) => ({
        promptKey,
        question: question.question,
        options: question.options ?? [],
        round: roundNumber,
      }))
    );
    questionIdsRef.current = Object.fromEntries(
      found.map((question, index) => [question.id, ids[index]])
    );
  };

  const runOpening = async () => {
    retryRef.current = runOpening;
    setStatus("loading");
    setLoadingKind("opening");
    setError("");
    try {
      const found = await loadOpening({
        position,
        company,
        description,
        tenureLabel,
        runId: expansionIdRef.current,
      });
      if (cancelledRef.current) return;
      if (!found.length) {
        setError("Couldn't come up with questions for this role. Try again.");
        setStatus("error");
        return;
      }
      startExperienceExpansion({ id: expansionIdRef.current, position, company });
      rememberQuestions(found, 1, PROMPTS.EXPANSION_OPENING);
      setQuestions(withRuntimeState(found));
      setRound(1);
      setStatus("answering");
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : "Could not start the questions.");
      setStatus("error");
    }
  };

  const runFollowups = async (currentTranscript, nextRound) => {
    retryRef.current = () => runFollowups(currentTranscript, nextRound);
    setStatus("loading");
    setLoadingKind("followups");
    setError("");
    try {
      const result = await loadFollowups({
        position,
        company,
        description,
        tenureLabel,
        transcript: currentTranscript,
        round: nextRound,
        runId: expansionIdRef.current,
      });
      if (cancelledRef.current) return;
      // Model says it knows enough, or the batch came back empty — write it up.
      if (result.enough || !result.questions.length) {
        runCompose(currentTranscript);
        return;
      }
      rememberQuestions(result.questions, nextRound, PROMPTS.EXPANSION_FOLLOWUP);
      setQuestions(withRuntimeState(result.questions));
      setRound(nextRound);
      setStatus("answering");
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : "Could not come up with more questions.");
      setStatus("error");
    }
  };

  const runCompose = async (finalTranscript) => {
    retryRef.current = () => runCompose(finalTranscript);
    setStatus("loading");
    setLoadingKind("compose");
    setError("");
    try {
      const composed = await composeBullets({
        position,
        company,
        description,
        tenureLabel,
        transcript: finalTranscript,
        runId: expansionIdRef.current,
      });
      if (cancelledRef.current) return;
      if (!composed.length) {
        setError("Couldn't write anything from those answers. Answer a bit more, then try again.");
        setStatus("error");
        return;
      }
      // Reaching the write-up is where the interview ends, so this is where the
      // round count is final.
      recordExpansionRounds(expansionIdRef.current, round);
      setBullets(
        composed.map((text) => ({
          text,
          resolution: null,
          suggestionId: recordSuggestionPresented(
            { experienceExpansionId: expansionIdRef.current },
            { suggestion: text, promptKey: PROMPTS.EXPANSION_COMPOSE }
          ),
        }))
      );
      setStatus("review");
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : "Could not write up your answers.");
      setStatus("error");
    }
  };

  const retry = () => {
    retryRef.current?.();
  };

  const updateQuestion = (questionId, patch) => {
    setQuestions((current) =>
      current.map((question) =>
        question.id === questionId ? { ...question, ...patch } : question
      )
    );
  };

  // Functional update so rapid toggles never overwrite each other with a stale list.
  const toggleQuestionChoice = (questionId, option) => {
    setQuestions((current) =>
      current.map((question) => {
        if (question.id !== questionId) return question;
        const choices = question.choices.includes(option)
          ? question.choices.filter((entry) => entry !== option)
          : [...question.choices, option];
        return { ...question, choices, skipped: false, usingCustom: false };
      })
    );
  };

  const answeredThisRound = collectAnswers(questions);
  const sessionHasAnswer = transcript.length > 0 || answeredThisRound.length > 0;

  // Settle this round's questions before they leave the screen. Mirrors
  // collectAnswers: a question left untouched gets no timestamp at all, which
  // is what distinguishes "ignored" from "explicitly skipped".
  const recordRoundOutcomes = () => {
    for (const question of questions) {
      const id = questionIdsRef.current[question.id];
      if (!id) continue;
      if (question.skipped) {
        recordQuestionSkipped(id);
      } else if (question.usingCustom && question.customAnswer.trim()) {
        recordQuestionAnswered(id, { answerText: question.customAnswer.trim() });
      } else if (question.multiSelect && question.choices.length) {
        recordQuestionAnswered(id, { selectedOptions: question.choices });
      } else if (!question.multiSelect && question.choice) {
        recordQuestionAnswered(id, { selectedOptions: [question.choice] });
      }
    }
  };

  const handleContinue = () => {
    if (!answeredThisRound.length) return;
    recordRoundOutcomes();
    const nextTranscript = [...transcript, ...answeredThisRound];
    setTranscript(nextTranscript);
    if (round >= MAX_QA_ROUNDS) {
      runCompose(nextTranscript);
    } else {
      runFollowups(nextTranscript, round + 1);
    }
  };

  const handleWriteUpNow = () => {
    recordRoundOutcomes();
    const nextTranscript = answeredThisRound.length
      ? [...transcript, ...answeredThisRound]
      : transcript;
    setTranscript(nextTranscript);
    runCompose(nextTranscript);
  };

  const handleAskMore = () => {
    runFollowups(transcript, Math.min(round + 1, MAX_QA_ROUNDS));
  };

  const handleAcceptBullet = (index) => {
    onAcceptBullet(bullets[index].text);
    recordSuggestionAccepted(bullets[index].suggestionId);
    setBullets((current) =>
      current.map((bullet, i) => (i === index ? { ...bullet, resolution: "accepted" } : bullet))
    );
  };

  const handleRejectBullet = (index) => {
    recordSuggestionRejected(bullets[index].suggestionId);
    setBullets((current) =>
      current.map((bullet, i) => (i === index ? { ...bullet, resolution: "rejected" } : bullet))
    );
  };

  const loadingCopy =
    loadingKind === "opening"
      ? "Reviewing your current experience details…"
      : loadingKind === "followups"
        ? "Creating followup questions…"
        : "Writing this up from your answers…";

  const allBulletsResolved =
    bullets.length > 0 && bullets.every((bullet) => bullet.resolution);
  const anyAccepted = bullets.some((bullet) => bullet.resolution === "accepted");

  return (
    <div
      ref={panelRef}
      className="mt-3 scroll-my-24 rounded-lg border border-violet-500/40 bg-violet-500/5 p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-300">
          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M15.98 1.804a1 1 0 0 0-1.96 0l-.24 1.192a1 1 0 0 1-.784.785l-1.192.238a1 1 0 0 0 0 1.962l1.192.238a1 1 0 0 1 .785.785l.238 1.192a1 1 0 0 0 1.962 0l.238-1.192a1 1 0 0 1 .785-.785l1.192-.238a1 1 0 0 0 0-1.962l-1.192-.238a1 1 0 0 1-.785-.785l-.238-1.192ZM6.949 5.684a1 1 0 0 0-1.898 0l-.683 2.051a1 1 0 0 1-.633.633l-2.051.683a1 1 0 0 0 0 1.898l2.051.684a1 1 0 0 1 .633.632l.683 2.051a1 1 0 0 0 1.898 0l.683-2.051a1 1 0 0 1 .633-.633l2.051-.683a1 1 0 0 0 0-1.898l-2.051-.683a1 1 0 0 1-.633-.633L6.95 5.684ZM13.949 13.684a1 1 0 0 0-1.898 0l-.184.551a1 1 0 0 1-.632.633l-.551.183a1 1 0 0 0 0 1.898l.551.183a1 1 0 0 1 .633.633l.183.551a1 1 0 0 0 1.898 0l.184-.551a1 1 0 0 1 .632-.633l.551-.183a1 1 0 0 0 0-1.898l-.551-.184a1 1 0 0 1-.633-.632l-.183-.551Z" clipRule="evenodd" />
          </svg>
          Expand experience
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
        >
          Close
        </button>
      </div>

      {status === "loading" && (
        <p className="mt-2 animate-pulse text-sm text-neutral-400">{loadingCopy}</p>
      )}

      {status === "error" && (
        <div className="mt-2">
          <p className="text-sm text-red-400">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-3 rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800"
          >
            Try again
          </button>
        </div>
      )}

      {status === "answering" && (
        <>
          <div className="mt-3 space-y-4">
            {questions.map((question) => (
              <div key={question.id}>
                <p className="text-sm font-medium text-neutral-200">
                  {question.question}
                  {question.multiSelect && (
                    <span className="ml-1.5 text-xs font-normal text-neutral-500">
                      Select all that apply.
                    </span>
                  )}
                </p>
                {question.helper && (
                  <p className="mt-0.5 text-xs text-neutral-500">{question.helper}</p>
                )}
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
                            ? toggleQuestionChoice(question.id, option)
                            : updateQuestion(question.id, {
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
                      updateQuestion(question.id, { usingCustom: true, skipped: false })
                    }
                    className={chipClass(question.usingCustom)}
                  >
                    Something else…
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateQuestion(question.id, {
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
                      updateQuestion(question.id, { customAnswer: e.target.value })
                    }
                    placeholder="In your own words..."
                    className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
                  />
                )}
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleContinue}
              disabled={!answeredThisRound.length}
              className="rounded-lg border border-violet-500/50 bg-violet-500/15 px-3 py-2 text-sm font-medium text-violet-700 transition-colors hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-50 dark:text-violet-200"
            >
              {round >= MAX_QA_ROUNDS ? "Write it up" : "Continue"}
            </button>
            <button
              type="button"
              onClick={handleWriteUpNow}
              disabled={!sessionHasAnswer}
              className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Write it up now
            </button>
          </div>
        </>
      )}

      {status === "review" && (
        <div className="mt-3 space-y-3">
          <p className="text-sm font-medium text-neutral-200">
            Here's what I heard — add what fits.
          </p>

          {bullets.map((bullet, index) =>
            bullet.resolution === "accepted" ? (
              <p key={index} className="text-sm text-emerald-500 dark:text-emerald-400">
                ✓ Added “{bullet.text}”
              </p>
            ) : bullet.resolution === "rejected" ? (
              <p key={index} className="text-sm text-neutral-500">
                Skipped “{bullet.text}”
              </p>
            ) : (
              <div
                key={index}
                className="rounded-lg border border-neutral-800 bg-neutral-900/70 p-3"
              >
                <p className="text-xs uppercase tracking-widest text-neutral-500">
                  Suggested detail
                </p>
                <p className="mt-1 text-sm text-neutral-100">{bullet.text}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleAcceptBullet(index)}
                    className="rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-500/25 dark:text-emerald-200"
                  >
                    Add to description
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRejectBullet(index)}
                    className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                  >
                    Skip
                  </button>
                </div>
              </div>
            )
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {round < MAX_QA_ROUNDS && (
              <button
                type="button"
                onClick={handleAskMore}
                className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
              >
                Ask me a bit more
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
            >
              {allBulletsResolved ? (anyAccepted ? "Done" : "Close") : "Close"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
