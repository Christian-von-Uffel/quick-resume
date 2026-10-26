import { MISSING_EXPERIENCE_KIND_LABELS } from "../lib/reviewExperience";

// The row of check marks and question marks above the gap questions: one chip
// per thing the job asks for, green when the person's own record (or their
// answer) shows it, orange while it's still a question. Chips enter one after
// another and each check draws itself in, so the person watches the job get
// ticked off against their history instead of reading a static list. Pass a
// fresh `runKey` for each review so the sequence replays; a chip whose status
// changes replays its own icon.

const CHIP_STAGGER_MS = 70;

const STATUS_STYLES = {
  covered: {
    chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    icon: "text-emerald-600 dark:text-emerald-300",
    title: "Shown in your work history",
  },
  added: {
    chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    icon: "text-emerald-600 dark:text-emerald-300",
    title: "Added to your work history",
  },
  confirmed: {
    chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    icon: "text-emerald-600 dark:text-emerald-300",
    title: "You confirmed this — pick a role below to save it",
  },
  open: {
    chip: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
    icon: "text-amber-600 dark:text-amber-300",
    title: "Still a question — answer it below",
  },
  dismissed: {
    chip: "border-neutral-800 bg-neutral-900/40 text-neutral-500 line-through decoration-neutral-600",
    icon: "text-neutral-500",
    title: "Not this time",
  },
};

function StatusIcon({ status }) {
  if (status === "open") {
    return (
      <svg viewBox="0 0 16 16" className="skill-icon-pop h-3.5 w-3.5" aria-hidden="true">
        <path
          d="M5.6 6.2a2.4 2.4 0 1 1 3.4 2.2c-.7.35-1 .8-1 1.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx="8" cy="12.6" r="1" fill="currentColor" />
      </svg>
    );
  }
  if (status === "dismissed") {
    return (
      <svg viewBox="0 0 16 16" className="skill-icon-pop h-3.5 w-3.5" aria-hidden="true">
        <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className="skill-icon-pop h-3.5 w-3.5" aria-hidden="true">
      <path
        className="skill-check-draw"
        d="M3.5 8.5l3 3 6-6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const STATUS_WORDS = {
  covered: "shown in your history",
  added: "added",
  confirmed: "confirmed",
  open: "to confirm",
  dismissed: "skipped",
};

// "7 shown in your history · 3 to confirm · 1 skipped" — only the non-zero parts.
export function describeSkillCounts(counts) {
  return ["covered", "added", "confirmed", "open", "dismissed"]
    .filter((status) => counts?.[status] > 0)
    .map((status) => `${counts[status]} ${STATUS_WORDS[status]}`)
    .join(" · ");
}

export function SkillsChecklist({ items, counts, runKey }) {
  if (!items?.length) return null;
  const summary = describeSkillCounts(counts);

  return (
    <div key={runKey} className="mt-4" data-testid="skills-checklist">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-xs font-medium uppercase tracking-widest text-neutral-500">
          What this job asks for
        </h3>
        {summary && (
          <p className="skill-chip-enter text-xs text-neutral-500" style={{ animationDelay: `${items.length * CHIP_STAGGER_MS}ms` }}>
            {summary}
          </p>
        )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-1.5" aria-live="polite">
        {items.map((item, index) => {
          const style = STATUS_STYLES[item.status] ?? STATUS_STYLES.open;
          const kindLabel = MISSING_EXPERIENCE_KIND_LABELS[item.kind] ?? "";
          const evidence = (item.evidence ?? [])
            .map((entry) => (entry.detail ? `${entry.label}: ${entry.detail}` : entry.label))
            .join("\n");
          const title = [style.title, kindLabel, evidence].filter(Boolean).join("\n");
          return (
            <li
              key={item.key}
              title={title}
              data-status={item.status}
              className={`skill-chip-enter inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${style.chip}`}
              style={{ animationDelay: `${index * CHIP_STAGGER_MS}ms` }}
            >
              <span key={item.status} className={`inline-flex ${style.icon}`} style={{ animationDelay: `${index * CHIP_STAGGER_MS + 120}ms` }}>
                <StatusIcon status={item.status} />
              </span>
              <span className="sr-only">{style.title}: </span>
              {item.skill}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
