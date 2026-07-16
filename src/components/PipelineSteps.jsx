// Live progress for a multi-stage pipeline run: done steps get a check, the
// active step pulses (or shows where the run died on failure), pending steps
// stay dim. stepIndex is -1 when idle, which renders nothing.
export function PipelineSteps({ steps, stepIndex, failed }) {
  if (stepIndex < 0) return null;
  return (
    <ol className="mt-3 space-y-1.5 text-sm" aria-live="polite">
      {steps.map((step, index) => {
        const isDone = index < stepIndex;
        const isActive = index === stepIndex;
        const failedHere = isActive && failed;
        return (
          <li
            key={step.id}
            className={`flex items-center gap-2 ${
              failedHere
                ? "text-red-400"
                : isActive
                  ? "text-amber-700 dark:text-amber-200"
                  : isDone
                    ? "text-neutral-400"
                    : "text-neutral-600"
            }`}
          >
            <span aria-hidden="true" className="w-4 text-center">
              {failedHere ? "✕" : isDone ? "✓" : isActive ? <span className="inline-block animate-pulse">●</span> : "○"}
            </span>
            {step.label}
            {isActive && !failed ? "…" : ""}
          </li>
        );
      })}
    </ol>
  );
}
