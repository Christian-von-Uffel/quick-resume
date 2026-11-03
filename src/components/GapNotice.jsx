import { useRef, useState } from "react";
import { formatGapRange, formatMonthSpan } from "../lib/workHistoryTimeline";

// How far (px) a gap row has to be dragged left before letting go dismisses it.
const SWIPE_DISMISS_PX = 80;

function DismissButton({ onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="shrink-0 rounded-md p-1 text-amber-700/70 transition-colors hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-200/70 dark:hover:text-amber-100"
    >
      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
      </svg>
    </button>
  );
}

// The card at the top of the position list naming the longest gap and when it
// happened, so nothing gets left off by accident. Dismissing it dismisses that
// gap, which also removes its row from the list.
export function LongestGapBanner({ gap, onAdd, onDismiss }) {
  if (!gap) return null;
  return (
    <div role="note" className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-100">
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          Longest gap: {formatMonthSpan(gap.months)}, {formatGapRange(gap)}
        </p>
        <p className="mt-0.5 text-amber-800/80 dark:text-amber-100/80">
          Freelance work, school, caregiving or a career break all count.
        </p>
        <button
          type="button"
          onClick={onAdd}
          className="mt-2 font-medium text-amber-800 underline-offset-2 hover:underline dark:text-amber-100"
        >
          Add what you did →
        </button>
      </div>
      <DismissButton onClick={onDismiss} label="Hide this gap" />
    </div>
  );
}

// A one-line gap marker between two positions. Swipe left to dismiss it (or use
// the ×, which also covers mouse and keyboard); tap "Add" to fill it.
export function GapRow({ gap, onAdd, onDismiss }) {
  const [dragX, setDragX] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const drag = useRef(null);

  const handlePointerDown = (event) => {
    if (event.pointerType === "mouse" || event.target.closest("button")) return;
    drag.current = { x: event.clientX, y: event.clientY, horizontal: null, id: event.pointerId };
  };

  const handlePointerMove = (event) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    // Decide once whether this is a swipe or a scroll, then stick with it.
    if (state.horizontal == null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      state.horizontal = Math.abs(dx) > Math.abs(dy);
      if (state.horizontal) {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Capture is a nicety; the swipe still works without it.
        }
      }
    }
    if (state.horizontal) setDragX(Math.min(0, dx));
  };

  const handlePointerEnd = () => {
    const state = drag.current;
    drag.current = null;
    if (!state?.horizontal) return;
    if (dragX <= -SWIPE_DISMISS_PX) {
      setLeaving(true);
    } else {
      setDragX(0);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg">
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onTransitionEnd={() => leaving && onDismiss()}
        style={{
          transform: `translateX(${leaving ? "-110%" : `${dragX}px`})`,
          opacity: leaving ? 0 : 1 + dragX / 300,
          transition: drag.current?.horizontal ? "none" : "transform 200ms ease, opacity 200ms ease",
          touchAction: "pan-y",
        }}
        className="flex items-center gap-2 rounded-lg border border-dashed border-amber-500/50 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
      >
        <span className="min-w-0 flex-1">
          Gap · {formatMonthSpan(gap.months)} · {formatGapRange(gap)}
        </span>
        <button
          type="button"
          onClick={onAdd}
          className="shrink-0 rounded-md px-2 py-1 font-medium transition-colors hover:bg-amber-500/20"
        >
          + Add
        </button>
        <DismissButton onClick={onDismiss} label="Hide this gap" />
      </div>
    </div>
  );
}
