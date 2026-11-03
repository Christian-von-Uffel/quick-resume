import { useEffect, useId, useRef, useState } from "react";

// A textarea that offers one suggested answer as ghost text inside the field,
// the way an editor offers a completion: Tab (or the button, for touch) takes
// it, typing anything else replaces it, Escape hides it. The suggestion only
// shows while the field is empty, so it never competes with what the person
// has written, and accepting it puts the text in the field like any other
// typing — the caller sees a normal onChange with the string.
export function SuggestedTextarea({
  value,
  onChange,
  suggestion = "",
  placeholder,
  rows = 3,
  className = "",
  onSuggestionShown,
  onAcceptSuggestion,
  ...rest
}) {
  const [dismissed, setDismissed] = useState(false);
  const hintId = useId();
  // The suggestion string last reported as shown, so a re-render (or clearing
  // the field and seeing it again) doesn't count as a second presentation.
  const shownRef = useRef("");

  useEffect(() => {
    setDismissed(false);
  }, [suggestion]);

  const showGhost = Boolean(suggestion) && !value && !dismissed;

  useEffect(() => {
    if (!showGhost || shownRef.current === suggestion) return;
    shownRef.current = suggestion;
    onSuggestionShown?.(suggestion);
  }, [showGhost, suggestion, onSuggestionShown]);

  const accept = () => {
    onChange(suggestion);
    onAcceptSuggestion?.(suggestion);
  };

  const handleKeyDown = (event) => {
    if (!showGhost) return;
    if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      accept();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
    }
  };

  return (
    <div>
      <div className="relative">
        <textarea
          {...rest}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={rows}
          placeholder={showGhost ? "" : placeholder}
          aria-describedby={showGhost ? hintId : undefined}
          className={`w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 ${className}`}
        />
        {showGhost && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-sm text-neutral-500"
          >
            {suggestion}
            <kbd className="ml-1.5 hidden rounded border border-neutral-700 px-1 font-mono text-[10px] text-neutral-500 [@media(hover:hover)]:inline">
              Tab
            </kbd>
          </div>
        )}
      </div>
      {showGhost && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <p id={hintId} className="sr-only">
            Suggested answer: {suggestion}. Press Tab to use it, or type your own.
          </p>
          <button
            type="button"
            onClick={accept}
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-200"
          >
            Use suggestion
          </button>
          <span className="text-xs text-neutral-500">or type your own answer</span>
        </div>
      )}
    </div>
  );
}
