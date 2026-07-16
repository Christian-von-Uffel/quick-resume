import { useEffect, useState } from "react";
import { CONFLICT_KINDS, DATE_ISSUES, mergedDatesPreview } from "../lib/positionReview";

// Opt-in review for the work-history problems that hurt an imported resume:
// duplicate positions, a promotion whose old title still overlaps, and a single
// role whose dates can't be real. A quiet one-line prompt sits above the
// timeline; clicking it opens a dialog that steps through each one. Duplicates
// merge by picking the right start and end dates (with a live duration preview);
// overlaps and reversed dates offer one-click fixes; "keep both" / "dates are
// correct" dismisses it so it stops being flagged. Concurrent jobs at different
// employers are NOT flagged — the timeline already shows those. Nothing is ever
// forced — the dialog closes at any point.

const KIND_META = {
  [CONFLICT_KINDS.DUPLICATE]: {
    badge: "Possible duplicate",
    badgeClass: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
    explain: (c) =>
      `Same role at ${c.company || "the same company"} with overlapping dates — likely one job entered twice.`,
  },
  [CONFLICT_KINDS.SAME_EMPLOYER_OVERLAP]: {
    badge: "Overlapping roles",
    badgeClass: "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-300",
    explain: (c) =>
      `Two titles at ${c.company || "the same company"} overlap by ${c.overlapLabel}. If one led into the other, pick where the switch happened.`,
  },
  [CONFLICT_KINDS.IMPOSSIBLE_DATES]: {
    badge: "Check these dates",
    badgeClass: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300",
    explain: (c) =>
      c.dateIssue === DATE_ISSUES.REVERSED
        ? "This role's end date comes before its start date — the two were probably swapped on import."
        : "This role starts in the future, which can't be right — likely a typo in the year.",
  },
};

function fuzzyNote(conflict) {
  if (conflict.fuzzy?.title && conflict.fuzzy?.company) {
    return "The title and company spellings differ slightly — probably typos.";
  }
  if (conflict.fuzzy?.title) return "The titles differ by a spelling variation.";
  if (conflict.fuzzy?.company) return "The company spellings differ slightly.";
  return "";
}

/* ── Prompt above the timeline ─────────────────────────────────────────── */

export function PositionReviewPrompt({ conflicts, onOpen }) {
  const count = conflicts?.length ?? 0;
  if (!count) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
      <svg className="h-3.5 w-3.5 shrink-0 text-amber-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h8A1.5 1.5 0 0 1 18 3.5v8a1.5 1.5 0 0 1-1.5 1.5H15v-6A2.5 2.5 0 0 0 12.5 4.5H7v-1Z" />
        <path d="M3.5 6A1.5 1.5 0 0 0 2 7.5v9A1.5 1.5 0 0 0 3.5 18h9a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 12.5 6h-9Z" />
      </svg>
      <p className="min-w-0 flex-1 text-xs text-neutral-600 dark:text-neutral-300">
        {count === 1
          ? "1 thing to check in your work history."
          : `${count} things to check in your work history.`}
      </p>
      <button
        type="button"
        onClick={onOpen}
        className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-200"
      >
        Review
      </button>
    </div>
  );
}

/* ── Dialog building blocks ────────────────────────────────────────────── */

function RoleCard({ role, onEditRole }) {
  return (
    <div className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2">
      <p className="text-sm font-medium text-neutral-200 break-words">{role.name}</p>
      <p className="text-xs text-neutral-500">
        {role.dates}
        {role.duration ? ` · ${role.duration}` : ""}
      </p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="text-[11px] text-neutral-600 dark:text-neutral-500">
          {role.bulletCount === 1 ? "1 bullet point" : `${role.bulletCount} bullet points`}
        </p>
        <button
          type="button"
          onClick={() => onEditRole?.(role.id)}
          className="shrink-0 text-[11px] font-medium text-blue-500 transition-colors hover:text-blue-300 dark:text-blue-400"
        >
          Edit dates
        </button>
      </div>
    </div>
  );
}

// Two-lane strip showing where the pair sits in time and where it collides —
// "overlapping" explained at a glance instead of by arithmetic.
function OverlapBar({ a, b }) {
  if (!a.dated || !b.dated) return null;
  const min = Math.min(a.start, b.start);
  const max = Math.max(a.end, b.end);
  const span = Math.max(1, max - min + 1);
  const pos = (index) => ((index - min) / span) * 100;
  const widthOf = (role) => Math.max(1.5, ((role.end - role.start + 1) / span) * 100);
  const overlapStart = Math.max(a.start, b.start);
  const overlapEnd = Math.min(a.end, b.end);
  const hasOverlap = overlapEnd >= overlapStart;

  return (
    <div aria-hidden="true">
      <div className="relative h-[26px]">
        <div
          className="absolute top-[1px] h-[10px] rounded-sm bg-blue-500/80"
          style={{ left: `${pos(a.start)}%`, width: `${widthOf(a)}%` }}
        />
        <div
          className="absolute top-[15px] h-[10px] rounded-sm bg-violet-500/80"
          style={{ left: `${pos(b.start)}%`, width: `${widthOf(b)}%` }}
        />
        {hasOverlap && (
          <div
            className="absolute top-0 h-full rounded-sm border border-dashed border-amber-500/80"
            style={{
              left: `${pos(overlapStart)}%`,
              width: `${Math.max(1.5, ((overlapEnd - overlapStart + 1) / span) * 100)}%`,
            }}
          />
        )}
      </div>
      <p className="mt-0.5 text-right text-[10px] text-neutral-600 dark:text-neutral-500">dashed = shared months</p>
    </div>
  );
}

function DateChoiceFieldset({ legend, options, value, onChange, name }) {
  if (options.length < 2) return null;
  return (
    <fieldset className="min-w-0 rounded-lg border border-neutral-800 px-3 pb-2 pt-1">
      <legend className="px-1 text-[11px] uppercase tracking-wider text-neutral-500">{legend}</legend>
      {options.map((option) => (
        <label key={option.id} className="flex cursor-pointer items-center gap-2 py-1 text-sm text-neutral-300">
          <input
            type="radio"
            name={name}
            checked={value === option.id}
            onChange={() => onChange(option.id)}
            className="h-3.5 w-3.5 border-neutral-600 bg-neutral-900 text-blue-500 focus:ring-blue-500/40"
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

// Strip a leading bullet marker so a wording reads cleanly in the chooser.
function cleanWording(raw) {
  return String(raw ?? "").replace(/^\s*[-•*]\s*/, "").trim();
}

// One repeated-bullet decision: keep the surviving copy's wording, the other
// copy's wording, or both. The more recent copy's option carries a "newer" tag
// so the recency-based default is legible; a tie shows no tag.
function BulletChoice({ choice, recentSide, value, onChange }) {
  const options = [
    { id: "survivor", text: cleanWording(choice.survivorWording), newer: recentSide === "survivor" },
    { id: "removed", text: cleanWording(choice.removedWording), newer: recentSide === "removed" },
    { id: "both", text: "Keep both — they're different points", muted: true },
  ];
  return (
    <fieldset className="min-w-0 rounded-lg border border-neutral-800 px-3 pb-2 pt-1">
      {options.map((option) => (
        <label key={option.id} className="flex cursor-pointer items-start gap-2 py-1 text-sm">
          <input
            type="radio"
            name={`bullet-${choice.id}`}
            checked={value === option.id}
            onChange={() => onChange(option.id)}
            className="mt-1 h-3.5 w-3.5 shrink-0 border-neutral-600 bg-neutral-900 text-blue-500 focus:ring-blue-500/40"
          />
          <span className={`min-w-0 break-words ${option.muted ? "text-neutral-500 italic" : "text-neutral-300"}`}>
            {option.text}
            {option.newer && (
              <span className="ml-1.5 rounded-full border border-blue-500/40 bg-blue-500/10 px-1.5 py-px text-[10px] not-italic text-blue-600 dark:text-blue-300">
                newer
              </span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/* ── The dialog ────────────────────────────────────────────────────────── */

export function PositionReviewDialog({
  conflicts,
  onClose,
  onApplyMerge,
  onApplyFix,
  onKeepBoth,
  onEditRole,
}) {
  const total = conflicts?.length ?? 0;
  const [index, setIndex] = useState(0);
  // Selections keyed by conflict id, so moving between steps keeps choices.
  const [datePicks, setDatePicks] = useState({});
  const [fixPicks, setFixPicks] = useState({});
  // Per-bullet wording picks: { [conflictId]: { [choiceId]: "survivor"|"removed"|"both" } }.
  const [bulletPicks, setBulletPicks] = useState({});

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const clamped = Math.min(index, Math.max(0, total - 1));
  const conflict = total > 0 ? conflicts[clamped] : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => onClose?.()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Review positions"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-neutral-700 bg-neutral-950 p-5 shadow-2xl shadow-black/50"
      >
        {!conflict ? (
          <div className="text-center">
            <p className="text-lg font-semibold text-neutral-50">All positions reviewed</p>
            <p className="mt-1 text-sm text-neutral-400">
              Your timeline has no duplicate or conflicting dates left to look at.
            </p>
            <button
              type="button"
              autoFocus
              onClick={() => onClose?.()}
              className="mt-5 rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
            >
              Done
            </button>
          </div>
        ) : (
          <ConflictStep
            key={conflict.id}
            conflict={conflict}
            position={clamped + 1}
            total={total}
            canGoBack={clamped > 0}
            onBack={() => setIndex(Math.max(0, clamped - 1))}
            onSkip={() => (clamped >= total - 1 ? onClose?.() : setIndex(clamped + 1))}
            onClose={onClose}
            datePick={datePicks[conflict.id]}
            onDatePick={(pick) =>
              setDatePicks((current) => ({ ...current, [conflict.id]: pick }))
            }
            fixPick={fixPicks[conflict.id]}
            onFixPick={(pick) => setFixPicks((current) => ({ ...current, [conflict.id]: pick }))}
            bulletPick={bulletPicks[conflict.id]}
            onBulletPick={(choiceId, pick) =>
              setBulletPicks((current) => ({
                ...current,
                [conflict.id]: { ...(current[conflict.id] ?? {}), [choiceId]: pick },
              }))
            }
            onApplyMerge={onApplyMerge}
            onApplyFix={onApplyFix}
            onKeepBoth={onKeepBoth}
            onEditRole={onEditRole}
          />
        )}
      </div>
    </div>
  );
}

function ConflictStep({
  conflict,
  position,
  total,
  canGoBack,
  onBack,
  onSkip,
  onClose,
  datePick,
  onDatePick,
  fixPick,
  onFixPick,
  bulletPick,
  onBulletPick,
  onApplyMerge,
  onApplyFix,
  onKeepBoth,
  onEditRole,
}) {
  const meta = KIND_META[conflict.kind] ?? KIND_META[CONFLICT_KINDS.DUPLICATE];
  const isDuplicate = conflict.kind === CONFLICT_KINDS.DUPLICATE;
  const note = fuzzyNote(conflict);

  const plan = conflict.merge;
  const startId = datePick?.startId ?? plan?.defaultStartId;
  const endId = datePick?.endId ?? plan?.defaultEndId;
  const preview = plan ? mergedDatesPreview(plan, startId, endId) : null;
  const bulletPicks = bulletPick ?? {};

  const selectedFix = fixPick ?? conflict.fixes[0]?.id ?? "keep-both";

  return (
    <>
      <div className="flex items-center gap-2">
        {canGoBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Previous conflict"
            className="rounded-md px-1 py-0.5 text-neutral-500 transition-colors hover:text-neutral-200"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 0 1-.02 1.06L8.832 10l3.938 3.71a.75.75 0 1 1-1.04 1.08l-4.5-4.25a.75.75 0 0 1 0-1.08l4.5-4.25a.75.75 0 0 1 1.06.02Z" clipRule="evenodd" />
            </svg>
          </button>
        )}
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.badgeClass}`}>
          {meta.badge}
        </span>
        <span className="flex-1 text-xs text-neutral-500">
          {position} of {total}
        </span>
        <button
          type="button"
          onClick={onSkip}
          className="rounded-md px-2 py-1 text-xs font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={() => onClose?.()}
          aria-label="Close review"
          className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      </div>

      <p className="mt-2 text-sm text-neutral-400">
        {meta.explain(conflict)}
        {note ? ` ${note}` : ""}
      </p>

      <div className={`mt-3 grid gap-2 ${conflict.b ? "sm:grid-cols-2" : ""}`}>
        <RoleCard role={conflict.a} onEditRole={onEditRole} />
        {conflict.b && <RoleCard role={conflict.b} onEditRole={onEditRole} />}
      </div>

      {conflict.b && (
        <div className="mt-2">
          <OverlapBar a={conflict.a} b={conflict.b} />
        </div>
      )}

      {isDuplicate ? (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <DateChoiceFieldset
              legend="Start date"
              name={`start-${conflict.id}`}
              options={plan.startOptions}
              value={startId}
              onChange={(id) => onDatePick({ startId: id, endId })}
            />
            <DateChoiceFieldset
              legend="End date"
              name={`end-${conflict.id}`}
              options={plan.endOptions}
              value={endId}
              onChange={(id) => onDatePick({ startId, endId: id })}
            />
          </div>

          {plan.bulletChoices?.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] uppercase tracking-wider text-neutral-500">
                {plan.bulletChoices.length === 1
                  ? "1 bullet looks repeated — keep which wording?"
                  : `${plan.bulletChoices.length} bullets look repeated — keep which wording?`}
              </p>
              <div className="space-y-2">
                {plan.bulletChoices.map((choice) => (
                  <BulletChoice
                    key={choice.id}
                    choice={choice}
                    recentSide={plan.recentSide}
                    value={bulletPicks[choice.id] ?? choice.defaultChoice}
                    onChange={(pick) => onBulletPick(choice.id, pick)}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg bg-neutral-900/60 px-3 py-2">
            <span className="text-xs text-neutral-500">Merged:</span>
            <span className="text-sm font-medium text-neutral-200">
              {preview.dates}
              {preview.duration ? ` · ${preview.duration}` : ""}
            </span>
            <span className="ml-auto text-[11px] text-neutral-500">
              {plan.bulletCount === 1 ? "1 bullet point" : `${plan.bulletCount} bullet points`}
              {plan.addedBulletCount > 0 ? ` (${plan.addedBulletCount} recovered)` : ""}
            </span>
          </div>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => onKeepBoth?.(conflict)}
              className="rounded-lg border border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
            >
              Keep both — separate positions
            </button>
            <button
              type="button"
              onClick={() => onApplyMerge?.(conflict, { startId, endId, bulletPicks })}
              className="rounded-lg border border-blue-500/50 bg-blue-500/15 px-3 py-2 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-500/25 dark:text-blue-300"
            >
              Merge into one
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-3 space-y-1.5">
            {conflict.fixes.map((fix) => (
              <label
                key={fix.id}
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                  selectedFix === fix.id
                    ? "border-blue-500/50 bg-blue-500/10"
                    : "border-neutral-800 hover:border-neutral-600"
                }`}
              >
                <input
                  type="radio"
                  name={`fix-${conflict.id}`}
                  checked={selectedFix === fix.id}
                  onChange={() => onFixPick(fix.id)}
                  className="mt-0.5 h-3.5 w-3.5 border-neutral-600 bg-neutral-900 text-blue-500 focus:ring-blue-500/40"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-neutral-200">{fix.label}</span>
                  <span className="block text-xs text-neutral-500">
                    {fix.after.dates}
                    {fix.after.duration ? ` · ${fix.after.duration}` : ""}
                    <span className="text-neutral-600"> (was {fix.before.dates})</span>
                  </span>
                </span>
              </label>
            ))}
            <label
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                selectedFix === "keep-both"
                  ? "border-blue-500/50 bg-blue-500/10"
                  : "border-neutral-800 hover:border-neutral-600"
              }`}
            >
              <input
                type="radio"
                name={`fix-${conflict.id}`}
                checked={selectedFix === "keep-both"}
                onChange={() => onFixPick("keep-both")}
                className="mt-0.5 h-3.5 w-3.5 border-neutral-600 bg-neutral-900 text-blue-500 focus:ring-blue-500/40"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-neutral-200">{conflict.keepBothLabel}</span>
                <span className="block text-xs text-neutral-500">
                  Nothing changes; it won&rsquo;t be flagged again.
                </span>
              </span>
            </label>
          </div>

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => {
                if (selectedFix === "keep-both") {
                  onKeepBoth?.(conflict);
                } else {
                  const fix = conflict.fixes.find((f) => f.id === selectedFix);
                  if (fix) onApplyFix?.(conflict, fix);
                }
              }}
              className="rounded-lg border border-blue-500/50 bg-blue-500/15 px-3 py-2 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-500/25 dark:text-blue-300"
            >
              Apply
            </button>
          </div>
        </>
      )}
    </>
  );
}
