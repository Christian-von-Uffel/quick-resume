import { useEffect, useRef, useState } from "react";
import { INTERVIEW_INTRO } from "../lib/interviewMe";
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

const chipClass =
  "rounded-lg border border-neutral-700 px-3 py-1.5 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50";

const secondaryButtonClass =
  "rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50 disabled:cursor-not-allowed disabled:opacity-50";

// What the prompts read back: finished turns only, in order.
const toTranscript = (turns) =>
  turns.map(({ context, question, answer, skipped }) => ({ context, question, answer, skipped }));

// Inline "Interview me" panel for a single work-history position. A plain,
// one-question-at-a-time conversation: each question restates what the person
// just said and points to why it's being asked, with sample answers to tap.
// Wrap up turns the conversation into suggestions framed as business problems
// this person has solved, each one kept or skipped individually.
export function EnrichExperience({
  position,
  company,
  description,
  tenureLabel,
  askQuestion,
  suggest,
  onAcceptBullet,
  onClose,
}) {
  // "loading" | "asking" | "review" | "error"
  const [status, setStatus] = useState("loading");
  // Which async step is (or was) running: "question" | "suggestions".
  const [loadingKind, setLoadingKind] = useState("question");
  const [turns, setTurns] = useState([]); // finished { heard, context, question, examples, answer, skipped }
  const [current, setCurrent] = useState(null); // the question on screen
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState([]); // [{ problem, bullet, resolution, suggestionId }]
  const [leftOut, setLeftOut] = useState([]);
  const [error, setError] = useState("");

  const cancelledRef = useRef(false);
  const panelRef = useRef(null);
  const currentRef = useRef(null);
  // Bullets kept so far, so a later wrap-up (after "Keep interviewing") sees
  // them as already written and doesn't suggest them again.
  const keptRef = useRef([]);
  // Re-runs the last async step with its exact arguments, so "Try again"
  // retries what actually failed.
  const retryRef = useRef(null);
  // The experience_expansions row this interview hangs off; created once the
  // first question is ready to show.
  const expansionIdRef = useRef(null);
  const expansionStartedRef = useRef(false);

  // The trigger button lives at the top of a tall position card, so this panel
  // opens below the fold. "nearest" no-ops when it's already visible.
  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  // Keep each new question in view as the thread grows.
  useEffect(() => {
    if (current) currentRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [current]);

  // The parent remounts this component (keyed by position id) for a fresh
  // interview, so this snapshots the description at open time.
  useEffect(() => {
    cancelledRef.current = false;
    // Minted before the first call so every turn's cost records against it.
    expansionIdRef.current = newMetricId();
    runQuestion([]);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runQuestion = async (finishedTurns) => {
    retryRef.current = () => runQuestion(finishedTurns);
    setStatus("loading");
    setLoadingKind("question");
    setError("");
    try {
      let promptId = null;
      const turn = await askQuestion({
        position,
        company,
        description,
        tenureLabel,
        transcript: toTranscript(finishedTurns),
        runId: expansionIdRef.current,
        onPromptId: (id) => {
          promptId = id;
        },
      });
      if (cancelledRef.current) return;
      if (!expansionStartedRef.current) {
        expansionStartedRef.current = true;
        startExperienceExpansion({ id: expansionIdRef.current, position, company, promptId });
      }
      const [metricId] = recordQuestionsPresented(
        { experienceExpansionId: expansionIdRef.current },
        [{ promptId, question: turn.question, options: turn.examples, round: finishedTurns.length + 1 }]
      );
      setCurrent({ ...turn, metricId });
      setDraft("");
      setStatus("asking");
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : "Couldn't come up with the next question.");
      setStatus("error");
    }
  };

  const runSuggestions = async (finishedTurns) => {
    retryRef.current = () => runSuggestions(finishedTurns);
    setStatus("loading");
    setLoadingKind("suggestions");
    setError("");
    try {
      let promptId = null;
      const result = await suggest({
        position,
        company,
        description: [description, ...keptRef.current].filter((text) => text?.trim()).join("\n"),
        tenureLabel,
        transcript: toTranscript(finishedTurns),
        runId: expansionIdRef.current,
        onPromptId: (id) => {
          promptId = id;
        },
      });
      if (cancelledRef.current) return;
      recordExpansionRounds(expansionIdRef.current, finishedTurns.length);
      setSuggestions(
        result.suggestions.map((entry) => ({
          ...entry,
          resolution: null,
          suggestionId: recordSuggestionPresented(
            { experienceExpansionId: expansionIdRef.current },
            { suggestion: entry.bullet, promptId }
          ),
        }))
      );
      setLeftOut(result.leftOut);
      setStatus("review");
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : "Couldn't write suggestions from your answers.");
      setStatus("error");
    }
  };

  // Settle the question on screen and return the finished thread.
  const finishCurrent = ({ answer = "", skipped = false, fromExample = false }) => {
    if (!current) return turns;
    if (skipped) {
      recordQuestionSkipped(current.metricId);
    } else {
      recordQuestionAnswered(
        current.metricId,
        fromExample ? { selectedOptions: [answer] } : { answerText: answer }
      );
    }
    const { metricId: _metricId, ...turn } = current;
    const next = [...turns, { ...turn, answer, skipped }];
    setTurns(next);
    setCurrent(null);
    setDraft("");
    return next;
  };

  const answeredCount = turns.filter((turn) => !turn.skipped).length;
  const canWrapUp = answeredCount > 0 || Boolean(draft.trim());

  const handleSend = (text, fromExample = false) => {
    const answer = text.trim();
    if (!answer) return;
    runQuestion(finishCurrent({ answer, fromExample }));
  };

  const handleSkip = () => {
    runQuestion(finishCurrent({ skipped: true }));
  };

  // A typed-but-unsent answer counts; an untouched question is left unanswered.
  const handleWrapUp = () => {
    if (!canWrapUp) return;
    const finished = draft.trim() ? finishCurrent({ answer: draft.trim() }) : turns;
    setCurrent(null);
    runSuggestions(finished);
  };

  const handleKeepInterviewing = () => {
    runQuestion(turns);
  };

  const resolveSuggestion = (index, resolution) => {
    const entry = suggestions[index];
    if (resolution === "accepted") {
      onAcceptBullet(entry.bullet);
      keptRef.current = [...keptRef.current, entry.bullet];
      recordSuggestionAccepted(entry.suggestionId);
    } else {
      recordSuggestionRejected(entry.suggestionId);
    }
    setSuggestions((list) => list.map((item, i) => (i === index ? { ...item, resolution } : item)));
  };

  const loadingCopy =
    loadingKind === "question"
      ? turns.length
        ? "Thinking of the next question…"
        : "Reading your work experience…"
      : "Writing suggestions from your answers…";

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
          Interview me
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
        >
          Close
        </button>
      </div>

      <p className="mt-2 text-sm text-neutral-400">{INTERVIEW_INTRO}</p>

      {turns.length > 0 && (
        <ol className="mt-3 space-y-3 border-l border-neutral-800 pl-3">
          {turns.map((turn, index) => (
            <li key={index} className="text-sm">
              <p className="text-neutral-400">{turn.question}</p>
              <p className={`mt-0.5 ${turn.skipped ? "italic text-neutral-500" : "text-neutral-200"}`}>
                {turn.skipped ? "Skipped" : turn.answer}
              </p>
            </li>
          ))}
        </ol>
      )}

      {status === "loading" && (
        <p className="mt-3 animate-pulse text-sm text-neutral-400">{loadingCopy}</p>
      )}

      {status === "error" && (
        <div className="mt-3">
          <p className="text-sm text-red-400">{error}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => retryRef.current?.()} className={secondaryButtonClass}>
              Try again
            </button>
            {loadingKind === "question" && answeredCount > 0 && (
              <button type="button" onClick={() => runSuggestions(turns)} className={secondaryButtonClass}>
                Wrap up
              </button>
            )}
            {loadingKind === "suggestions" && (
              <button type="button" onClick={handleKeepInterviewing} className={secondaryButtonClass}>
                Keep interviewing
              </button>
            )}
          </div>
        </div>
      )}

      {status === "asking" && current && (
        <div ref={currentRef} className="mt-4 scroll-my-24 space-y-2">
          {current.heard && <p className="text-sm text-neutral-400">{current.heard}</p>}
          {current.context && <p className="text-sm text-neutral-300">{current.context}</p>}
          <p className="text-base font-semibold text-neutral-100">{current.question}</p>

          {current.examples.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {current.examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => handleSend(example, true)}
                  className={chipClass}
                >
                  {example}
                </button>
              ))}
            </div>
          )}

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend(draft);
              }
            }}
            rows={2}
            placeholder="Or answer in your own words…"
            className="w-full resize-none rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
          />

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleSend(draft)}
              disabled={!draft.trim()}
              className="rounded-lg border border-violet-500/50 bg-violet-500/15 px-3 py-2 text-sm font-medium text-violet-700 transition-colors hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-50 dark:text-violet-200"
            >
              Send
            </button>
            <button type="button" onClick={handleSkip} className={secondaryButtonClass}>
              Skip
            </button>
            <button
              type="button"
              onClick={handleWrapUp}
              disabled={!canWrapUp}
              title={canWrapUp ? "Get suggestions from your answers." : "Answer at least one question first."}
              className={`${secondaryButtonClass} ml-auto`}
            >
              Wrap up
            </button>
          </div>
        </div>
      )}

      {status === "review" && (
        <div className="mt-4 space-y-3">
          <p className="text-sm font-medium text-neutral-200">
            Here's what we'd add. Keep what fits.
          </p>

          {suggestions.map((entry, index) =>
            entry.resolution === "accepted" ? (
              <p key={index} className="text-sm text-emerald-500 dark:text-emerald-400">
                ✓ Added “{entry.bullet}”
              </p>
            ) : entry.resolution === "rejected" ? (
              <p key={index} className="text-sm text-neutral-500">
                Skipped “{entry.bullet}”
              </p>
            ) : (
              <div key={index} className="rounded-lg border border-neutral-800 bg-neutral-900/70 p-3">
                {entry.problem && (
                  <p className="text-xs font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-300">
                    {entry.problem}
                  </p>
                )}
                <p className="mt-1 text-sm text-neutral-100">{entry.bullet}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => resolveSuggestion(index, "accepted")}
                    className="rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-500/25 dark:text-emerald-200"
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    onClick={() => resolveSuggestion(index, "rejected")}
                    className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
                  >
                    Skip
                  </button>
                </div>
              </div>
            )
          )}

          {leftOut.length > 0 && (
            <div className="rounded-lg border border-neutral-800 p-3">
              <p className="text-xs uppercase tracking-widest text-neutral-500">Left out on purpose</p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-neutral-400">
                {leftOut.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" onClick={handleKeepInterviewing} className={secondaryButtonClass}>
              Keep interviewing
            </button>
            <button type="button" onClick={onClose} className={secondaryButtonClass}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
