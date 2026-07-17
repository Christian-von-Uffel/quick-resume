import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FALLBACK_MODEL_OPTIONS, LLM_PROVIDERS } from "../lib/constants";
import {
  callLlm,
  callLlmForJson,
  fetchPreferredLlmProvider,
  fetchProviderModelOptions,
  getDefaultModelForProvider,
  normalizeLlmSettings,
} from "../lib/llm";
import {
  buildClarityReviewPrompt,
  buildClaritySuggestionPrompt,
  cleanSuggestedSentence,
  replaceSentence,
  validateClarityReview,
} from "../lib/clarifyExperience";
import {
  MAX_QA_ROUNDS,
  MAX_COMPOSED_BULLETS,
  MAX_QUESTIONS_PER_ROUND,
  appendDetailToDescription,
  buildComposePrompt,
  buildFollowupQuestionsPrompt,
  buildOpeningQuestionsPrompt,
  cleanEnrichedBullet,
  validateComposedBullets,
  validateFollowupQuestions,
  validateOpeningQuestions,
} from "../lib/enrichExperience";
import {
  MAX_MISSING_EXPERIENCE_ITEMS,
  MISSING_EXPERIENCE_KIND_LABELS,
  buildMissingExperienceReviewPrompt,
  cleanFormattedDetail,
  formatExperienceElaboration,
  validateMissingExperienceReview,
} from "../lib/reviewExperience";
import {
  GENERATE_STEPS,
  buildJobAnalysisPrompt,
  composeResume,
  ensureRequiredRolesSelected,
  selectRankedEvidence,
  validateJobAnalysis,
  validateSelectedResumeEvidence,
} from "../lib/generateResume";
import { normalizeDetailForComparison, normalizeProfile, normalizeWorkHistoryItem } from "../lib/resumeModel";
import { formatMonthSpan, getRoleInterval, summarizeCoverage } from "../lib/workHistoryTimeline";
import { auditValidation, describeDrops } from "../lib/labAudit";
import { newMetricId } from "../lib/metrics";
import {
  CHALLENGER_PLACEHOLDERS,
  CHALLENGER_SEEDS,
  adaptChallengerQuestions,
  formatProfileForPrompt,
  formatWorkHistoryForPrompt,
  renderPromptTemplate,
} from "../lib/promptLab";
import { createClient } from "../lib/supabase/client";
import { EnrichExperience } from "./EnrichExperience";
import { ExperienceReview } from "./ExperienceReview";
import { PipelineSteps } from "./PipelineSteps";

// The prompt lab (served at /app/lab, deliberately unlinked — see
// app/(product)/app/lab/page.jsx). Each of the four smart flows gets an A/B
// bench: column A runs the production prompt, column B a challenger template
// edited right on the page. Both columns run the REAL user flow — the same
// components, validators, and follow-up calls production uses — against the
// person's real saved history, because a prompt that only shines on invented
// input tells you nothing.
//
// Ground rules:
// - Calls carry no promptKey, so their cost lands in llm_calls with prompt_id
//   null and never pollutes per-prompt production metrics. Product metrics
//   (questions/suggestions/…) are inert here because configureMetrics is never
//   called on this route.
// - Accept / Add to description write the updated role description back to the
//   person's work_history row (same as the editor). Generated resumes and gap
//   previews stay display-only.

/* ── Shared bits ───────────────────────────────────────────── */

const FEATURES = [
  { id: "clarity", label: "Clarity review" },
  { id: "expand", label: "Expand experience" },
  { id: "gap", label: "Job gap analysis" },
  { id: "generate", label: "Generate resume" },
];

const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500";

const primaryButtonClass =
  "rounded-lg border border-blue-500/50 bg-blue-500/15 px-3 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-50 dark:text-blue-200";

const secondaryButtonClass =
  "rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50 disabled:cursor-not-allowed disabled:opacity-50";

const chipButtonClass = (active) =>
  `rounded-lg border px-3 py-1.5 text-sm transition-colors ${
    active
      ? "border-blue-500 bg-blue-500/20 text-neutral-50"
      : "border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-50"
  }`;

const truncate = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/* ── Validation audits (real validators, drops made visible) ── */

const questionDedupeKey = (item) =>
  String(item?.question ?? "").replace(/\s+/g, " ").trim().toLowerCase();

function diagnoseQuestion(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return "not a question object — a bare string has no kind or options";
  }
  if (!String(item.question ?? "").trim()) return "no question text";
  return "needs at least 2 answer options for its kind";
}

// Rounds 2+ go through the follow-up validator, which wraps the same question
// normalizer, so one audit covers the opening batch and every later round.
function auditQuestionRound(parsed, round = 1) {
  const validate =
    round === 1
      ? validateOpeningQuestions
      : (value) => validateFollowupQuestions(value, { round }).questions;
  return auditValidation({
    validate,
    wrap: (items) => ({ questions: items, enough: false }),
    rawList: parsed?.questions,
    dedupeKeyOf: questionDedupeKey,
    cap: MAX_QUESTIONS_PER_ROUND,
    diagnose: diagnoseQuestion,
  });
}

function auditClarityReview(parsed) {
  return auditValidation({
    validate: validateClarityReview,
    wrap: (items) => ({ confusingSentences: items }),
    rawList: parsed?.confusingSentences,
    // The clarity validator doesn't dedupe, so every distinct item is its own
    // key — only byte-identical duplicates fold together.
    dedupeKeyOf: (item) => {
      try {
        return JSON.stringify(item) ?? "";
      } catch {
        return "";
      }
    },
    diagnose: (item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return "not an object";
      if (!String(item.sentence ?? "").trim()) return "no sentence to anchor the replacement";
      return "no plain-language interpretations to pick from";
    },
  });
}

function auditGapReview(parsed, workHistory) {
  return auditValidation({
    validate: (value) => validateMissingExperienceReview(value, workHistory),
    wrap: (items) => ({ missingExperienceDetails: items }),
    rawList: parsed?.missingExperienceDetails,
    dedupeKeyOf: (item) => String(item?.skill ?? "").replace(/\s+/g, " ").trim().toLowerCase(),
    cap: MAX_MISSING_EXPERIENCE_ITEMS,
    diagnose: (item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return "not an object";
      if (!String(item.skill ?? "").trim()) return "no skill name";
      // Re-probe with a known-good question: if the item passes with it, the
      // original phrasing is what the validator rejected.
      try {
        const probed = validateMissingExperienceReview(
          { missingExperienceDetails: [{ ...item, question: "Did you do this yourself?" }] },
          workHistory
        );
        if (probed.length === 1) {
          return "question phrasing rejected — \"and\"/\"or\", slashes, or category words like duties, tasks, various";
        }
      } catch {
        // fall through to the generic reason
      }
      return "rejected by the production validator";
    },
  });
}

function auditComposedBullets(parsed) {
  return auditValidation({
    validate: validateComposedBullets,
    wrap: (items) => ({ bullets: items }),
    rawList: parsed?.bullets,
    dedupeKeyOf: (item) =>
      normalizeDetailForComparison(cleanEnrichedBullet(typeof item === "string" ? item : "")),
    cap: MAX_COMPOSED_BULLETS,
    diagnose: () => "empty after cleanup",
  });
}

/* ── Per-column call inspector ─────────────────────────────── */

function useCallLog() {
  const [calls, setCalls] = useState([]);
  const counterRef = useRef(0);
  const log = useCallback((entry) => {
    counterRef.current += 1;
    const id = counterRef.current;
    setCalls((current) => [...current, { id, ...entry }]);
  }, []);
  const reset = useCallback(() => {
    counterRef.current = 0;
    setCalls([]);
  }, []);
  return { calls, log, reset };
}

const rejectedItemLabel = (item) => {
  const text = item?.question ?? item?.sentence ?? item?.skill ?? item;
  return typeof text === "string" ? text : JSON.stringify(text);
};

// Every model call a column made, newest last: the exact prompt sent, the raw
// response, and what the production validator dropped from it. This is the
// half a prompt comparison usually can't see — a challenger whose output gets
// rejected looks identical to one that found nothing to say.
function CallLog({ calls }) {
  if (!calls.length) return null;
  return (
    <div className="mt-3 space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
        Model calls
      </p>
      {calls.map((call) => (
        <details key={call.id} className="rounded-lg border border-neutral-800 bg-neutral-950/50">
          <summary className="cursor-pointer px-3 py-2 text-xs text-neutral-400 transition-colors hover:text-neutral-200">
            <span className="font-medium text-neutral-300">{call.label}</span>
            {call.dropSummary ? (
              <span className="ml-2 text-amber-700 dark:text-amber-300">{call.dropSummary}</span>
            ) : null}
          </summary>
          <div className="space-y-2 border-t border-neutral-800 px-3 py-2">
            {call.rejected?.length > 0 && (
              <div>
                <p className="text-xs uppercase tracking-widest text-amber-700 dark:text-amber-300">
                  Dropped by validation
                </p>
                <ul className="mt-1 space-y-1 text-xs text-neutral-400">
                  {call.rejected.map((entry, index) => (
                    <li key={index}>
                      “{truncate(rejectedItemLabel(entry.item), 90)}”
                      {entry.reason ? <span className="text-neutral-500"> — {entry.reason}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs uppercase tracking-widest text-neutral-500">Prompt sent</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-900 p-2 text-xs text-neutral-300">
              {call.prompt}
            </pre>
            <p className="text-xs uppercase tracking-widest text-neutral-500">Raw response</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-900 p-2 text-xs text-neutral-300">
              {typeof call.response === "string"
                ? call.response
                : JSON.stringify(call.response, null, 2)}
            </pre>
          </div>
        </details>
      ))}
    </div>
  );
}

/* ── Small layout pieces ───────────────────────────────────── */

function VariantColumn({ badge, title, note, action, children }) {
  const badgeClass =
    badge === "A"
      ? "border-blue-500/50 bg-blue-500/15 text-blue-700 dark:text-blue-300"
      : "border-violet-500/50 bg-violet-500/15 text-violet-700 dark:text-violet-300";
  return (
    <div className="min-w-0 rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-neutral-200">
          <span className={`rounded-md border px-1.5 py-0.5 text-xs font-bold ${badgeClass}`}>
            {badge}
          </span>
          {title}
        </p>
        {action}
      </div>
      {note ? <p className="mt-1 text-xs text-neutral-500">{note}</p> : null}
      {children}
    </div>
  );
}

function ResultBlock({ label, text }) {
  return (
    <div className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
      <p className="text-xs font-semibold uppercase tracking-widest text-emerald-600 dark:text-emerald-300">
        {label}
      </p>
      <pre className="mt-1 whitespace-pre-wrap font-sans text-sm text-neutral-200">{text}</pre>
    </div>
  );
}

function ChallengerEditor({ feature, value, onChange }) {
  const placeholders = CHALLENGER_PLACEHOLDERS[feature] ?? [];
  return (
    <div className="mt-4 rounded-xl border border-violet-500/40 bg-violet-500/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-300">
          Challenger prompt (column B)
        </p>
        <button
          type="button"
          onClick={() => onChange(CHALLENGER_SEEDS[feature])}
          className="rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
        >
          Reset to seed
        </button>
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={12}
        spellCheck={false}
        aria-label={`Challenger prompt for ${feature}`}
        className={`${inputClass} mt-2 font-mono text-xs leading-relaxed`}
      />
      <p className="mt-2 text-xs text-neutral-500">
        Placeholders filled at run time:{" "}
        {placeholders.map(([token, meaning], index) => (
          <span key={token}>
            {index > 0 ? " · " : ""}
            <code className="rounded bg-neutral-800 px-1 py-0.5 text-neutral-300">{token}</code>{" "}
            {meaning}
          </span>
        ))}
      </p>
    </div>
  );
}

function ProductionPromptPreview({ label = "View the production prompt with the current inputs", build }) {
  return (
    <details className="mt-2 rounded-lg border border-neutral-800">
      <summary className="cursor-pointer px-3 py-2 text-xs text-neutral-500 transition-colors hover:text-neutral-300">
        {label}
      </summary>
      <PreviewBody build={build} />
    </details>
  );
}

// The prompt string is only built on click, so typing in the inputs doesn't
// re-render a 5,000-character prompt nobody is reading. Rendering again picks
// up whatever the inputs say now.
function PreviewBody({ build }) {
  const [text, setText] = useState(null);
  return (
    <div className="border-t border-neutral-800 px-3 py-2">
      <button type="button" onClick={() => setText(build())} className={secondaryButtonClass}>
        {text === null ? "Render prompt" : "Re-render with current inputs"}
      </button>
      {text !== null ? (
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-xs text-neutral-400">
          {text}
        </pre>
      ) : null}
    </div>
  );
}

function CopyButton({ text, label = "Copy markdown" }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef(null);
  useEffect(() => () => clearTimeout(timeoutRef.current), []);
  return (
    <button
      type="button"
      className="rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          clearTimeout(timeoutRef.current);
          timeoutRef.current = setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

/* ── Minimal markdown preview ──────────────────────────────────
   Just enough rendering for the resume format the compose prompt mandates
   (#/##/### headings, bullets, ---, **bold**) to make two generations
   comparable at a glance. The Raw tab is the ground truth. */

function renderInline(text) {
  return String(text)
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, index) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
        <strong key={index} className="font-semibold text-neutral-100">
          {part.slice(2, -2)}
        </strong>
      ) : (
        part
      )
    );
}

function MarkdownPreview({ markdown }) {
  const blocks = [];
  const lines = String(markdown ?? "").split("\n");
  let bullets = null;

  const flushBullets = (key) => {
    if (!bullets) return;
    blocks.push(
      <ul key={`ul-${key}`} className="list-disc space-y-1 pl-5 text-sm text-neutral-300">
        {bullets.map((line, index) => (
          <li key={index}>{renderInline(line)}</li>
        ))}
      </ul>
    );
    bullets = null;
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (/^[-*]\s+/.test(line)) {
      (bullets ??= []).push(line.replace(/^[-*]\s+/, ""));
      return;
    }
    flushBullets(index);
    if (!line) return;
    if (line === "---") {
      blocks.push(<hr key={index} className="my-3 border-neutral-800" />);
    } else if (line.startsWith("# ")) {
      blocks.push(
        <h1 key={index} className="text-xl font-bold text-neutral-100">
          {renderInline(line.slice(2))}
        </h1>
      );
    } else if (line.startsWith("## ")) {
      blocks.push(
        <h2 key={index} className="mt-4 text-sm font-bold uppercase tracking-widest text-neutral-200">
          {renderInline(line.slice(3))}
        </h2>
      );
    } else if (line.startsWith("### ")) {
      blocks.push(
        <h3 key={index} className="mt-3 text-sm font-semibold text-neutral-100">
          {renderInline(line.slice(4))}
        </h3>
      );
    } else {
      blocks.push(
        <p key={index} className="mt-1 text-sm text-neutral-300">
          {renderInline(line)}
        </p>
      );
    }
  });
  flushBullets("end");

  return <div className="space-y-1">{blocks}</div>;
}

/* ── Model settings ────────────────────────────────────────── */

function useLabLlmSettings() {
  const [settings, setSettings] = useState(() => normalizeLlmSettings());
  const [optionsByProvider, setOptionsByProvider] = useState({});

  // Land on the first provider the server has a key for, unless the person
  // already picked one. Same rule as the editor (src/App.jsx).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { preferred } = await fetchPreferredLlmProvider();
        if (cancelled || !preferred) return;
        setSettings((current) =>
          current.provider !== "gemini"
            ? current
            : { provider: preferred, model: getDefaultModelForProvider(preferred) }
        );
      } catch {
        // Keep the bundled default; a missing key surfaces on the first run.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live model list for the selected provider, fetched once per provider.
  useEffect(() => {
    const provider = settings.provider;
    if (optionsByProvider[provider]) return;
    let cancelled = false;
    (async () => {
      try {
        const { options } = await fetchProviderModelOptions(provider);
        if (cancelled || !options.length) return;
        setOptionsByProvider((current) => ({ ...current, [provider]: options }));
      } catch {
        // The bundled fallback list keeps the picker usable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.provider, optionsByProvider]);

  const options =
    optionsByProvider[settings.provider] ?? FALLBACK_MODEL_OPTIONS[settings.provider] ?? [];

  const setProvider = (provider) =>
    setSettings({
      provider,
      model: getDefaultModelForProvider(provider, optionsByProvider),
    });
  const setModel = (model) => setSettings((current) => ({ ...current, model }));

  return { settings, options, setProvider, setModel };
}

function ModelPicker({ settings, options, setProvider, setModel }) {
  const hasCurrent = options.some(([id]) => id === settings.model);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={settings.provider}
        onChange={(event) => setProvider(event.target.value)}
        aria-label="Model provider"
        className={`${inputClass} w-auto`}
      >
        {LLM_PROVIDERS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <select
        value={settings.model}
        onChange={(event) => setModel(event.target.value)}
        aria-label="Model"
        className={`${inputClass} w-auto`}
      >
        {!hasCurrent && <option value={settings.model}>{settings.model}</option>}
        {options.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ── Run-signal plumbing ───────────────────────────────────────
   The "Run A", "Run B", and "Run both" buttons live with the shared inputs,
   above the two columns; each column reacts to signals aimed at it. The
   last-handled guard makes the effect idempotent, so dev StrictMode's
   double-invoke can't fire a paid model call twice. */

function useRunSignal(runSignal, variantKey, start) {
  const handledRef = useRef(0);
  useEffect(() => {
    if (!runSignal || runSignal.n === handledRef.current) return;
    if (runSignal.target !== "both" && runSignal.target !== variantKey) return;
    handledRef.current = runSignal.n;
    start();
    // `start` is recreated every render by design — the signal counter is the
    // trigger, and the handled guard keeps the effect idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSignal]);
}

function RunButtons({ onRun, disabled, disabledReason, running = false }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onRun("A")}
        disabled={disabled || running}
        className={primaryButtonClass}
      >
        Run A
      </button>
      <button
        type="button"
        onClick={() => onRun("B")}
        disabled={disabled || running}
        className="rounded-lg border border-violet-500/50 bg-violet-500/15 px-3 py-2 text-sm font-medium text-violet-700 transition-colors hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-50 dark:text-violet-200"
      >
        Run B
      </button>
      <button
        type="button"
        onClick={() => onRun("both")}
        disabled={disabled || running}
        className={secondaryButtonClass}
      >
        Run both
      </button>
      {disabled && disabledReason ? (
        <span className="text-xs text-neutral-500">{disabledReason}</span>
      ) : null}
    </div>
  );
}

/* ── Position-based inputs (clarity + expand) ──────────────── */

function PositionInputs({ idPrefix, workHistory, positionId, onPositionChange, description, onDescriptionChange }) {
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={`${idPrefix}-position`} className="text-xs font-medium uppercase tracking-widest text-neutral-500">
          Position
        </label>
        <select
          id={`${idPrefix}-position`}
          value={positionId}
          onChange={(event) => onPositionChange(event.target.value)}
          className={`${inputClass} mt-1`}
        >
          {workHistory.map((item) => (
            <option key={item.id} value={item.id}>
              {[item.position || "Untitled role", item.company].filter(Boolean).join(" — ")}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-description`} className="text-xs font-medium uppercase tracking-widest text-neutral-500">
          Experience details (seeded from the saved position — edit freely; Accept / Add saves back to your profile)
        </label>
        <textarea
          id={`${idPrefix}-description`}
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          rows={6}
          className={`${inputClass} mt-1`}
        />
      </div>
    </div>
  );
}

// Shared state for the two position-based benches: which saved role is under
// test plus an editable copy of its description.
function usePositionInput(workHistory) {
  const [positionId, setPositionId] = useState(workHistory[0]?.id ?? "");
  const selected = workHistory.find((item) => item.id === positionId) ?? workHistory[0] ?? null;
  const [description, setDescription] = useState(selected?.description ?? "");

  const changePosition = (id) => {
    setPositionId(id);
    const item = workHistory.find((entry) => entry.id === id);
    setDescription(item?.description ?? "");
  };

  const interval = selected ? getRoleInterval(selected) : null;
  const tenureLabel = interval?.dated ? formatMonthSpan(interval.end - interval.start + 1) : "";

  return { selected, positionId, changePosition, description, setDescription, tenureLabel };
}

/* ── Clarity review bench ──────────────────────────────────── */

function ClarityFlowColumn({
  variantKey,
  isChallenger,
  template,
  settings,
  workId,
  position,
  company,
  description,
  runSignal,
  onSaveDescription,
}) {
  const { calls, log, reset } = useCallLog();
  const [run, setRun] = useState(null); // { nonce, description }
  const [resultDescription, setResultDescription] = useState("");
  const resultDescriptionRef = useRef("");
  const runIdRef = useRef(null);

  const start = () => {
    reset();
    runIdRef.current = newMetricId();
    resultDescriptionRef.current = description;
    setResultDescription(description);
    setRun((current) => ({ nonce: (current?.nonce ?? 0) + 1, description }));
  };
  useRunSignal(runSignal, variantKey, start);

  const reviewSentences = async ({ position: pos, description: desc }) => {
    const prompt = isChallenger
      ? renderPromptTemplate(template, { jobTitle: pos, company, experienceDetails: desc })
      : buildClarityReviewPrompt({ position: pos, description: desc });
    const parsed = await callLlmForJson(settings, prompt, null, { runId: runIdRef.current });
    const audit = auditClarityReview(parsed);
    log({
      label: "Find confusing sentences",
      prompt,
      response: parsed,
      dropSummary: describeDrops(audit),
      rejected: audit.rejected,
    });
    return parsed;
  };

  const proposeRewrite = async ({ position: pos, sentence, clarification, skills }) => {
    const prompt = buildClaritySuggestionPrompt({ position: pos, sentence, clarification, skills });
    const text = await callLlm(settings, prompt, null, { runId: runIdRef.current });
    log({ label: `Rewrite “${truncate(sentence, 44)}”`, prompt, response: text });
    return cleanSuggestedSentence(text);
  };

  const handleAcceptSentence = (original, replacement) => {
    const { description: next, replaced } = replaceSentence(
      resultDescriptionRef.current,
      original,
      replacement
    );
    resultDescriptionRef.current = next;
    setResultDescription(next);
    if (replaced && workId) {
      onSaveDescription?.(workId, next, "Sentence updated.");
    } else if (!replaced) {
      onSaveDescription?.(workId, next, "Could not find that sentence to replace.", {
        skipWrite: true,
      });
    }
  };

  return (
    <VariantColumn
      badge={variantKey}
      title={isChallenger ? "Challenger" : "Production"}
      note={
        isChallenger
          ? "Finds sentences with the challenger prompt; rewrites still use the production prompt."
          : "The exact flow shipped in the editor."
      }
    >
      {run ? (
        <ExperienceReview
          key={run.nonce}
          position={position}
          company={company}
          description={run.description}
          reviewSentences={reviewSentences}
          proposeRewrite={proposeRewrite}
          onAcceptSentence={handleAcceptSentence}
          onClose={() => setRun(null)}
        />
      ) : (
        <p className="mt-3 text-sm text-neutral-500">Not running. Use the Run buttons above.</p>
      )}
      {resultDescription && resultDescription !== (run?.description ?? description) ? (
        <ResultBlock label="Description after accepted rewrites" text={resultDescription} />
      ) : null}
      <CallLog calls={calls} />
    </VariantColumn>
  );
}

function ClarityLab({ workHistory, settings, onSaveDescription }) {
  const input = usePositionInput(workHistory);
  const [template, setTemplate] = useState(CHALLENGER_SEEDS.clarity);
  const [runSignal, setRunSignal] = useState(null);

  const disabled = !input.selected || !input.description.trim();
  const columnProps = {
    template,
    settings,
    workId: input.selected?.id ?? "",
    position: input.selected?.position ?? "",
    company: input.selected?.company ?? "",
    description: input.description,
    runSignal,
    onSaveDescription: (workId, nextDescription, message, options) => {
      onSaveDescription?.(workId, nextDescription, message, options);
      if (!options?.skipWrite && workId === input.positionId) {
        input.setDescription(nextDescription);
      }
    },
  };

  return (
    <div>
      <PositionInputs
        idPrefix="clarity"
        workHistory={workHistory}
        positionId={input.positionId}
        onPositionChange={input.changePosition}
        description={input.description}
        onDescriptionChange={input.setDescription}
      />
      <ProductionPromptPreview
        build={() =>
          buildClarityReviewPrompt({
            position: input.selected?.position ?? "",
            description: input.description,
          })
        }
      />
      <ChallengerEditor feature="clarity" value={template} onChange={setTemplate} />
      <RunButtons
        onRun={(target) => setRunSignal((current) => ({ n: (current?.n ?? 0) + 1, target }))}
        disabled={disabled}
        disabledReason="Pick a position with a description first."
      />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ClarityFlowColumn variantKey="A" isChallenger={false} {...columnProps} />
        <ClarityFlowColumn variantKey="B" isChallenger {...columnProps} />
      </div>
    </div>
  );
}

/* ── Expand experience bench ───────────────────────────────── */

function ExpandFlowColumn({
  variantKey,
  isChallenger,
  template,
  settings,
  workId,
  position,
  company,
  description,
  tenureLabel,
  runSignal,
  onSaveDescription,
}) {
  const { calls, log, reset } = useCallLog();
  const [run, setRun] = useState(null);
  const [resultDescription, setResultDescription] = useState("");
  const resultDescriptionRef = useRef("");
  const runIdRef = useRef(null);

  const start = () => {
    reset();
    runIdRef.current = newMetricId();
    resultDescriptionRef.current = description;
    setResultDescription(description);
    setRun((current) => ({ nonce: (current?.nonce ?? 0) + 1, description }));
  };
  useRunSignal(runSignal, variantKey, start);

  const loadOpening = async ({ position: pos, company: co, description: desc, tenureLabel: tenure }) => {
    const prompt = isChallenger
      ? renderPromptTemplate(template, {
          jobTitle: pos,
          company: co ?? "",
          experienceDetails: desc,
          tenure: tenure ?? "",
        })
      : buildOpeningQuestionsPrompt({ position: pos, company: co, description: desc, tenure });
    const parsed = await callLlmForJson(settings, prompt, null, { runId: runIdRef.current });
    const adapted = isChallenger ? adaptChallengerQuestions(parsed) : parsed;
    const audit = auditQuestionRound(adapted, 1);
    log({
      label: "Opening questions",
      prompt,
      response: parsed,
      dropSummary: describeDrops(audit),
      rejected: audit.rejected,
    });
    return audit.kept;
  };

  const loadFollowups = async ({
    position: pos,
    company: co,
    description: desc,
    tenureLabel: tenure,
    transcript,
    round,
  }) => {
    const prompt = buildFollowupQuestionsPrompt({
      position: pos,
      company: co,
      description: desc,
      tenure,
      transcript,
      round,
      maxRounds: MAX_QA_ROUNDS,
    });
    const parsed = await callLlmForJson(settings, prompt, null, { runId: runIdRef.current });
    const audit = auditQuestionRound(parsed, round);
    log({
      label: `Follow-up questions (round ${round})`,
      prompt,
      response: parsed,
      dropSummary: describeDrops(audit),
      rejected: audit.rejected,
    });
    return validateFollowupQuestions(parsed, { round });
  };

  const composeBullets = async ({
    position: pos,
    company: co,
    description: desc,
    tenureLabel: tenure,
    transcript,
  }) => {
    const prompt = buildComposePrompt({
      position: pos,
      company: co,
      description: desc,
      tenure,
      transcript,
    });
    const parsed = await callLlmForJson(settings, prompt, null, { runId: runIdRef.current });
    const audit = auditComposedBullets(parsed);
    log({
      label: "Compose bullets",
      prompt,
      response: parsed,
      dropSummary: describeDrops(audit),
      rejected: audit.rejected,
    });
    return audit.kept;
  };

  const handleAcceptBullet = (bullet) => {
    const { description: next, appended } = appendDetailToDescription(
      resultDescriptionRef.current,
      bullet
    );
    resultDescriptionRef.current = next;
    setResultDescription(next);
    if (appended && workId) {
      onSaveDescription?.(workId, next, "Detail added to the description.");
    } else if (!appended) {
      onSaveDescription?.(workId, next, "That detail is already in the description.", {
        skipWrite: true,
      });
    }
  };

  return (
    <VariantColumn
      badge={variantKey}
      title={isChallenger ? "Challenger" : "Production"}
      note={
        isChallenger
          ? "Opens with the challenger prompt; follow-up rounds and the write-up still use the production prompts."
          : "The exact flow shipped in the editor."
      }
    >
      {run ? (
        <EnrichExperience
          key={run.nonce}
          position={position}
          company={company}
          description={run.description}
          tenureLabel={tenureLabel}
          loadOpening={loadOpening}
          loadFollowups={loadFollowups}
          composeBullets={composeBullets}
          onAcceptBullet={handleAcceptBullet}
          onClose={() => setRun(null)}
        />
      ) : (
        <p className="mt-3 text-sm text-neutral-500">Not running. Use the Run buttons above.</p>
      )}
      {resultDescription && resultDescription !== (run?.description ?? description) ? (
        <ResultBlock label="Description after accepted bullets" text={resultDescription} />
      ) : null}
      <CallLog calls={calls} />
    </VariantColumn>
  );
}

function ExpandLab({ workHistory, settings, onSaveDescription }) {
  const input = usePositionInput(workHistory);
  const [template, setTemplate] = useState(CHALLENGER_SEEDS.expand);
  const [runSignal, setRunSignal] = useState(null);

  const disabled = !input.selected;
  const columnProps = {
    template,
    settings,
    workId: input.selected?.id ?? "",
    position: input.selected?.position ?? "",
    company: input.selected?.company ?? "",
    description: input.description,
    tenureLabel: input.tenureLabel,
    runSignal,
    onSaveDescription: (workId, nextDescription, message, options) => {
      onSaveDescription?.(workId, nextDescription, message, options);
      if (!options?.skipWrite && workId === input.positionId) {
        input.setDescription(nextDescription);
      }
    },
  };

  return (
    <div>
      <PositionInputs
        idPrefix="expand"
        workHistory={workHistory}
        positionId={input.positionId}
        onPositionChange={input.changePosition}
        description={input.description}
        onDescriptionChange={input.setDescription}
      />
      <ProductionPromptPreview
        build={() =>
          buildOpeningQuestionsPrompt({
            position: input.selected?.position ?? "",
            company: input.selected?.company ?? "",
            description: input.description,
            tenure: input.tenureLabel,
          })
        }
      />
      <ChallengerEditor feature="expand" value={template} onChange={setTemplate} />
      <RunButtons
        onRun={(target) => setRunSignal((current) => ({ n: (current?.n ?? 0) + 1, target }))}
        disabled={disabled}
        disabledReason="Add a work-history position first."
      />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ExpandFlowColumn variantKey="A" isChallenger={false} {...columnProps} />
        <ExpandFlowColumn variantKey="B" isChallenger {...columnProps} />
      </div>
    </div>
  );
}

/* ── Job gap analysis bench ────────────────────────────────── */

function GapQuestionCard({ item, settings, runId, log, onPatch }) {
  const answerYes = () => onPatch({ answer: "yes" });
  const answerNo = () => onPatch({ answer: "no", formatted: "", formatStatus: "idle" });

  const formatAnswer = async (answerText) => {
    onPatch({ formatStatus: "loading", formatError: "" });
    try {
      const prompt = formatExperienceElaboration({ question: item.question, answer: answerText });
      const text = await callLlm(settings, prompt, null, { runId });
      log({ label: `Format detail “${truncate(item.question, 44)}”`, prompt, response: text });
      onPatch({ formatted: cleanFormattedDetail(text) || answerText, formatStatus: "ready" });
    } catch (error) {
      onPatch({
        formatStatus: "error",
        formatError: error instanceof Error ? error.message : "Could not format the answer.",
      });
    }
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-3">
      {item.skill ? (
        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
          {item.skill}
          {item.kind ? (
            <span className="ml-2 font-normal normal-case tracking-normal text-neutral-600">
              {MISSING_EXPERIENCE_KIND_LABELS[item.kind] ?? item.kind}
            </span>
          ) : null}
        </p>
      ) : null}
      <p className="mt-1 text-sm font-medium text-neutral-200">{item.question}</p>
      {item.whyItMatters ? <p className="mt-1 text-xs text-neutral-500">{item.whyItMatters}</p> : null}
      {item.likelyRoles?.length ? (
        <p className="mt-1 text-xs text-neutral-500">
          Likely where: {item.likelyRoles.map((role) => role.label).join(" · ")}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={answerYes} className={chipButtonClass(item.answer === "yes")}>
          Yes
        </button>
        <button type="button" onClick={answerNo} className={chipButtonClass(item.answer === "no")}>
          No
        </button>
      </div>

      {item.answer === "no" ? (
        <p className="mt-2 text-xs text-neutral-500">Dismissed — nothing gets written for this gap.</p>
      ) : null}

      {item.answer === "yes" ? (
        <div className="mt-2">
          <textarea
            value={item.elaboration}
            onChange={(event) => onPatch({ elaboration: event.target.value })}
            rows={2}
            placeholder={item.answerPlaceholder || "Yes, I ..."}
            aria-label={`Elaboration for ${truncate(item.question, 60)}`}
            className={inputClass}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => formatAnswer(item.elaboration.trim())}
              disabled={!item.elaboration.trim() || item.formatStatus === "loading"}
              className={secondaryButtonClass}
            >
              {item.formatStatus === "loading" ? "Writing…" : "Write it as a resume detail"}
            </button>
            {item.plainspokenDetail ? (
              <button
                type="button"
                onClick={() => onPatch({ formatted: item.plainspokenDetail, formatStatus: "ready" })}
                className={secondaryButtonClass}
              >
                Use suggested detail
              </button>
            ) : null}
          </div>
          {item.formatStatus === "error" ? (
            <p className="mt-2 text-sm text-red-400">{item.formatError}</p>
          ) : null}
          {item.formatStatus === "ready" && item.formatted ? (
            <ResultBlock label="Detail this would add to the role" text={item.formatted} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function GapColumn({ variantKey, isChallenger, template, settings, workHistory, jobDescription, runSignal }) {
  const { calls, log, reset } = useCallLog();
  const [status, setStatus] = useState("idle"); // idle|loading|ready|empty|error
  const [error, setError] = useState("");
  const [items, setItems] = useState([]);
  const runIdRef = useRef(null);
  const nonceRef = useRef(0);

  const start = async () => {
    const nonce = ++nonceRef.current;
    reset();
    setItems([]);
    setError("");
    setStatus("loading");
    runIdRef.current = newMetricId();
    try {
      let details;
      if (isChallenger) {
        const prompt = renderPromptTemplate(template, {
          workHistory: formatWorkHistoryForPrompt(workHistory),
          jobDescription,
        });
        const parsed = await callLlmForJson(settings, prompt, null, { runId: runIdRef.current });
        const adapted = adaptChallengerQuestions(parsed);
        const audit = auditQuestionRound(adapted, 1);
        log({
          label: "Find gap questions",
          prompt,
          response: parsed,
          dropSummary: describeDrops(audit),
          rejected: audit.rejected,
        });
        details = audit.kept.map((question, index) => ({
          id: `lab-gap-${index}`,
          question: question.question,
        }));
      } else {
        const prompt = buildMissingExperienceReviewPrompt({ workHistory, jobDescription });
        const parsed = await callLlmForJson(settings, prompt, null, { runId: runIdRef.current });
        const audit = auditGapReview(parsed, workHistory);
        log({
          label: "Find gap questions",
          prompt,
          response: parsed,
          dropSummary: describeDrops(audit),
          rejected: audit.rejected,
        });
        details = audit.kept;
      }
      if (nonce !== nonceRef.current) return;
      setItems(
        details.map((detail) => ({
          ...detail,
          answer: null,
          elaboration: "",
          formatted: "",
          formatStatus: "idle",
          formatError: "",
        }))
      );
      setStatus(details.length ? "ready" : "empty");
    } catch (err) {
      if (nonce !== nonceRef.current) return;
      setError(err instanceof Error ? err.message : "The gap review failed.");
      setStatus("error");
    }
  };
  useRunSignal(runSignal, variantKey, start);

  const patchItem = (id, patch) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  return (
    <VariantColumn
      badge={variantKey}
      title={isChallenger ? "Challenger" : "Production"}
      note={
        isChallenger
          ? "Questions from the challenger prompt; answers are written up with the production prompt."
          : "The exact flow shipped on the Generate tab."
      }
    >
      {status === "idle" ? (
        <p className="mt-3 text-sm text-neutral-500">Not running. Use the Run buttons above.</p>
      ) : null}
      {status === "loading" ? (
        <p className="mt-3 animate-pulse text-sm text-neutral-400">
          Reading the job description against the work history…
        </p>
      ) : null}
      {status === "error" ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
      {status === "empty" ? (
        <p className="mt-3 text-sm text-neutral-400">
          No usable questions came back. Open the call log below to see what the model returned.
        </p>
      ) : null}
      {status === "ready" ? (
        <div className="mt-3 space-y-3">
          {items.map((item) => (
            <GapQuestionCard
              key={item.id}
              item={item}
              settings={settings}
              runId={runIdRef.current}
              log={log}
              onPatch={(patch) => patchItem(item.id, patch)}
            />
          ))}
        </div>
      ) : null}
      <CallLog calls={calls} />
    </VariantColumn>
  );
}

function GapLab({ workHistory, settings }) {
  const [jobDescription, setJobDescription] = useState("");
  const [template, setTemplate] = useState(CHALLENGER_SEEDS.gap);
  const [runSignal, setRunSignal] = useState(null);

  const disabled = !jobDescription.trim();
  const columnProps = { template, settings, workHistory, jobDescription, runSignal };

  return (
    <div>
      <label htmlFor="gap-job-description" className="text-xs font-medium uppercase tracking-widest text-neutral-500">
        Job description
      </label>
      <textarea
        id="gap-job-description"
        value={jobDescription}
        onChange={(event) => setJobDescription(event.target.value)}
        rows={8}
        placeholder="Paste the job description to compare your saved history against."
        className={`${inputClass} mt-1`}
      />
      <ProductionPromptPreview
        build={() => buildMissingExperienceReviewPrompt({ workHistory, jobDescription })}
      />
      <ChallengerEditor feature="gap" value={template} onChange={setTemplate} />
      <RunButtons
        onRun={(target) => setRunSignal((current) => ({ n: (current?.n ?? 0) + 1, target }))}
        disabled={disabled}
        disabledReason="Paste a job description first."
      />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <GapColumn variantKey="A" isChallenger={false} {...columnProps} />
        <GapColumn variantKey="B" isChallenger {...columnProps} />
      </div>
    </div>
  );
}

/* ── Generate resume bench ─────────────────────────────────── */

function GenerateColumn({
  variantKey,
  isChallenger,
  template,
  settings,
  profile,
  workHistory,
  jobDescription,
  runSignal,
}) {
  const { calls, log, reset } = useCallLog();
  const [state, setState] = useState({ status: "idle", stepIndex: -1, failed: false, markdown: "", error: "" });
  const [view, setView] = useState("preview"); // preview | raw
  const nonceRef = useRef(0);

  const start = async () => {
    const nonce = ++nonceRef.current;
    reset();
    const runId = newMetricId();
    setState({ status: "loading", stepIndex: isChallenger ? -1 : 0, failed: false, markdown: "", error: "" });
    const stillCurrent = () => nonce === nonceRef.current;

    try {
      let text;
      if (isChallenger) {
        const prompt = renderPromptTemplate(template, {
          profile: formatProfileForPrompt(profile),
          workHistory: formatWorkHistoryForPrompt(workHistory),
          jobDescription,
        });
        text = await callLlm(settings, prompt, null, { runId });
        if (!stillCurrent()) return;
        log({ label: "Compose the resume (single call)", prompt, response: text });
      } else {
        // The exact three-step production pipeline from src/App.jsx, minus the
        // parts that save resumes and record product metrics.
        const analysisPrompt = buildJobAnalysisPrompt(jobDescription);
        const analysisRaw = await callLlmForJson(settings, analysisPrompt, null, { runId });
        if (!stillCurrent()) return;
        log({ label: "1 · Analyze the job", prompt: analysisPrompt, response: analysisRaw });
        const jobAnalysis = validateJobAnalysis(analysisRaw);
        const coverage = summarizeCoverage(workHistory);

        setState((current) => ({ ...current, stepIndex: 1 }));
        const evidencePrompt = selectRankedEvidence({
          profile,
          workHistory,
          jobAnalysis,
          instructions: jobDescription,
          coverage,
        });
        const evidenceRaw = await callLlmForJson(settings, evidencePrompt, null, { runId });
        if (!stillCurrent()) return;
        log({ label: "2 · Select and rank evidence", prompt: evidencePrompt, response: evidenceRaw });
        const selectedEvidence = ensureRequiredRolesSelected(
          validateSelectedResumeEvidence(evidenceRaw, profile),
          coverage,
          workHistory
        );

        setState((current) => ({ ...current, stepIndex: 2 }));
        const composePrompt = composeResume({
          profile,
          selectedEvidence,
          jobAnalysis,
          instructions: jobDescription,
          coverage,
        });
        text = await callLlm(settings, composePrompt, null, { runId });
        if (!stillCurrent()) return;
        log({ label: "3 · Compose the resume", prompt: composePrompt, response: text });
      }

      const markdown = text
        .replace(/^```(?:markdown)?\s*/i, "")
        .replace(/```$/i, "")
        .trim();
      setState({ status: "ready", stepIndex: -1, failed: false, markdown, error: "" });
    } catch (error) {
      if (!stillCurrent()) return;
      setState((current) => ({
        ...current,
        status: "error",
        failed: true,
        error: error instanceof Error ? error.message : "Generation failed.",
      }));
    }
  };
  useRunSignal(runSignal, variantKey, start);

  return (
    <VariantColumn
      badge={variantKey}
      title={isChallenger ? "Challenger" : "Production"}
      note={
        isChallenger
          ? "One model call straight from the challenger prompt."
          : "The three-step pipeline shipped on the Generate tab."
      }
      action={
        state.markdown ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setView("preview")}
              className={chipButtonClass(view === "preview")}
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => setView("raw")}
              className={chipButtonClass(view === "raw")}
            >
              Markdown
            </button>
            <CopyButton text={state.markdown} />
          </div>
        ) : null
      }
    >
      {state.status === "idle" ? (
        <p className="mt-3 text-sm text-neutral-500">Not running. Use the Run buttons above.</p>
      ) : null}
      {!isChallenger && state.stepIndex >= 0 ? (
        <PipelineSteps steps={GENERATE_STEPS} stepIndex={state.stepIndex} failed={state.failed} />
      ) : null}
      {isChallenger && state.status === "loading" ? (
        <p className="mt-3 animate-pulse text-sm text-neutral-400">Writing the resume…</p>
      ) : null}
      {state.status === "error" ? <p className="mt-3 text-sm text-red-400">{state.error}</p> : null}
      {state.markdown ? (
        <div className="mt-3 max-h-[70vh] overflow-auto rounded-lg border border-neutral-800 bg-neutral-950/60 p-4">
          {view === "preview" ? (
            <MarkdownPreview markdown={state.markdown} />
          ) : (
            <pre className="whitespace-pre-wrap text-xs text-neutral-300">{state.markdown}</pre>
          )}
        </div>
      ) : null}
      <CallLog calls={calls} />
    </VariantColumn>
  );
}

function GenerateLab({ profile, workHistory, settings }) {
  const [jobDescription, setJobDescription] = useState("");
  const [template, setTemplate] = useState(CHALLENGER_SEEDS.generate);
  const [runSignal, setRunSignal] = useState(null);

  const columnProps = { template, settings, profile, workHistory, jobDescription, runSignal };

  return (
    <div>
      <label
        htmlFor="generate-job-description"
        className="text-xs font-medium uppercase tracking-widest text-neutral-500"
      >
        Job description
      </label>
      <textarea
        id="generate-job-description"
        value={jobDescription}
        onChange={(event) => setJobDescription(event.target.value)}
        rows={8}
        placeholder="Paste the job description to tailor both resumes to. Leave empty for a general resume."
        className={`${inputClass} mt-1`}
      />
      <ProductionPromptPreview
        label="View production step 1 prompt (steps 2–3 depend on step 1's output — see the call log after a run)"
        build={() => buildJobAnalysisPrompt(jobDescription)}
      />
      <ChallengerEditor feature="generate" value={template} onChange={setTemplate} />
      <RunButtons
        onRun={(target) => setRunSignal((current) => ({ n: (current?.n ?? 0) + 1, target }))}
        disabled={false}
      />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <GenerateColumn variantKey="A" isChallenger={false} {...columnProps} />
        <GenerateColumn variantKey="B" isChallenger {...columnProps} />
      </div>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────── */

export default function PromptLab({ initialData = null }) {
  const profile = useMemo(() => normalizeProfile(initialData?.profile), [initialData]);
  const [workHistory, setWorkHistory] = useState(() =>
    (initialData?.workHistory ?? []).map(normalizeWorkHistoryItem)
  );
  const llm = useLabLlmSettings();
  const [activeFeature, setActiveFeature] = useState("clarity");
  const [saveToast, setSaveToast] = useState("");
  const saveToastTimeoutRef = useRef(null);
  const supabaseRef = useRef(null);

  const getSupabase = () => {
    if (!supabaseRef.current) supabaseRef.current = createClient();
    return supabaseRef.current;
  };

  const showSaveToast = useCallback((message) => {
    setSaveToast(message);
    if (saveToastTimeoutRef.current) clearTimeout(saveToastTimeoutRef.current);
    saveToastTimeoutRef.current = setTimeout(() => {
      setSaveToast("");
      saveToastTimeoutRef.current = null;
    }, 3000);
  }, []);

  // Accept / Add write the working description straight back onto the selected
  // work_history row. Targeted update (not a full sync) so we never touch
  // resumes or regenerate row ids the way the editor's delete-and-reinsert does.
  const handleSaveDescription = useCallback(
    async (workId, nextDescription, message, options = {}) => {
      if (!workId) return;
      if (options.skipWrite) {
        showSaveToast(message);
        return;
      }

      setWorkHistory((current) =>
        current.map((item) =>
          item.id === workId
            ? normalizeWorkHistoryItem({ ...item, description: nextDescription })
            : item
        )
      );

      try {
        const { data, error } = await getSupabase()
          .from("work_history")
          .update({ description: nextDescription })
          .eq("id", workId)
          .select("id");
        if (error) throw error;
        if (!data?.length) throw new Error("That position is no longer in your saved history.");
        showSaveToast(message);
      } catch (error) {
        console.error("Lab save failed:", error);
        showSaveToast("Couldn't save to your profile. Try again from the editor if it keeps failing.");
      }
    },
    [showSaveToast]
  );

  return (
    <div className="min-h-screen text-neutral-200">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-neutral-100">Prompt lab</h1>
            <p className="mt-1 max-w-xl text-sm text-neutral-500">
              A/B bench for the four smart flows, run against your real saved history with the
              real product components and validators. Calls bill like normal usage. Accept and Add
              to description save back to your work history; generated resumes stay display-only,
              and product metrics are not recorded. This page is unlinked — it exists only at
              /app/lab.
            </p>
          </div>
          <ModelPicker
            settings={llm.settings}
            options={llm.options}
            setProvider={llm.setProvider}
            setModel={llm.setModel}
          />
        </div>

        {workHistory.length === 0 ? (
          <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-200">
            No saved work history yet. The benches run on your real data — add positions in the
            editor first for meaningful comparisons.
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2">
          {FEATURES.map((feature) => (
            <button
              key={feature.id}
              type="button"
              onClick={() => setActiveFeature(feature.id)}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                activeFeature === feature.id
                  ? "border-blue-500 bg-blue-500/20 text-neutral-50"
                  : "border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-50"
              }`}
            >
              {feature.label}
            </button>
          ))}
        </div>

        {/* Panels stay mounted so switching tabs never discards a run. */}
        <div className="mt-5">
          <section className={activeFeature === "clarity" ? "" : "hidden"}>
            <ClarityLab
              workHistory={workHistory}
              settings={llm.settings}
              onSaveDescription={handleSaveDescription}
            />
          </section>
          <section className={activeFeature === "expand" ? "" : "hidden"}>
            <ExpandLab
              workHistory={workHistory}
              settings={llm.settings}
              onSaveDescription={handleSaveDescription}
            />
          </section>
          <section className={activeFeature === "gap" ? "" : "hidden"}>
            <GapLab workHistory={workHistory} settings={llm.settings} />
          </section>
          <section className={activeFeature === "generate" ? "" : "hidden"}>
            <GenerateLab profile={profile} workHistory={workHistory} settings={llm.settings} />
          </section>
        </div>
      </div>

      {saveToast ? (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 max-w-sm -translate-x-1/2 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm text-neutral-100 shadow-lg"
        >
          {saveToast}
        </div>
      ) : null}
    </div>
  );
}
