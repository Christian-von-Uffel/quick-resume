import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildTimeline,
  assignLaneGroups,
  summarizeCoverage,
  monthIndexToLabel,
  monthIndexToParts,
  formatMonthSpan,
  recencyPosition,
} from "../lib/workHistoryTimeline";

// Distinct block colors, cycled by chronological order. Chosen to stay legible
// with white text in both light and dark mode.
const ROLE_COLORS = [
  "#2563eb", // blue
  "#0d9488", // teal
  "#7c3aed", // violet
  "#c2410c", // orange
  "#0891b2", // cyan
  "#4d7c0f", // olive
  "#be185d", // pink
  "#4338ca", // indigo
];

const LANE_HEIGHT = 20; // minimum height of a single stacked lane
const LANE_GAP = 3; // vertical gap between stacked overlapping roles
const CLOSE_DELAY_MS = 140;

function yearOf(monthIndex) {
  return Math.floor(monthIndex / 12);
}

// Build year-boundary ticks, then thin them by on-screen position so the axis
// never crowds — important for the recency scale, where old years bunch up.
function buildAxisTicks(domainStart, domainEnd, scalePos) {
  const ticks = [];
  for (let year = yearOf(domainStart); year <= yearOf(domainEnd); year += 1) {
    ticks.push(year * 12);
  }
  ticks.push(domainEnd);
  const positioned = ticks
    .map((index) => ({ index, pos: scalePos(index), year: yearOf(index) }))
    .sort((a, b) => a.pos - b.pos);

  const kept = [];
  for (const tick of positioned) {
    const last = kept[kept.length - 1];
    if (!last || tick.pos - last.pos >= 6.5) kept.push(tick);
  }
  // De-dupe repeated year labels that survived thinning.
  return kept.filter((tick, i) => i === 0 || tick.year !== kept[i - 1].year);
}

export function WorkHistoryTimeline({ workHistory, now = new Date(), onSelectRole, onAddPosition }) {
  const [active, setActive] = useState(null);
  const [ctaVisible, setCtaVisible] = useState(false);
  const [scaleMode, setScaleMode] = useState("recency"); // "recency" | "linear"
  const closeTimer = useRef(null);
  const rootRef = useRef(null);

  const openPopup = (data) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setCtaVisible(false);
    setActive(data);
  };
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setActive(null), CLOSE_DELAY_MS);
  };
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };

  useEffect(() => () => cancelClose(), []);

  // Dismiss a tapped-open popup on outside tap or Escape (mainly for touch).
  useEffect(() => {
    if (!active) return;
    const onDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setActive(null);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setActive(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [active]);

  const model = useMemo(() => {
    const timeline = buildTimeline(workHistory, now);
    if (timeline.domainStart == null) return null;
    const { placed, maxGroupLanes } = assignLaneGroups(timeline.dated);
    const coverage = summarizeCoverage(workHistory, now);
    return { timeline, placed, maxGroupLanes, coverage };
  }, [workHistory, now]);

  if (!model) return null;

  const { timeline, placed, maxGroupLanes, coverage } = model;
  const { domainStart, domainEnd, gaps, undated } = timeline;
  const span = Math.max(1, domainEnd - domainStart + 1);

  // Band grows tall enough that even the deepest overlap stack keeps a readable
  // per-lane height. A role fills its share of the band: full height when it
  // overlaps nothing, an even split when it shares time with others.
  const bandHeight = maxGroupLanes * LANE_HEIGHT + (maxGroupLanes - 1) * LANE_GAP;
  const laneSpan = LANE_HEIGHT + LANE_GAP;
  const roleHeight = (groupLanes) => (bandHeight - (groupLanes - 1) * LANE_GAP) / groupLanes;

  // Position the START boundary of a month along the axis (0% = most recent, left).
  const scalePos = (index) =>
    scaleMode === "linear"
      ? ((domainEnd - index) / span) * 100
      : recencyPosition(index, domainStart, domainEnd);
  // A span covering months [startIdx, endIdx] inclusive reaches from the start of
  // startIdx to the END of endIdx (= start of endIdx + 1), so back-to-back spans
  // touch with no sliver and gaps butt exactly against their neighbors.
  const box = (startIdx, endIdx) => {
    const left = Math.max(0, scalePos(endIdx + 1));
    const right = Math.min(100, scalePos(startIdx));
    return { left, width: Math.max(0, right - left) };
  };

  const axisTicks = buildAxisTicks(domainStart, domainEnd, scalePos);
  const trailingGap = gaps.find((gap) => gap.toPresent);

  const runAction = () => {
    if (!active) return;
    if (active.roleId) {
      setActive(null);
      onSelectRole?.(active.roleId);
    } else if (active.gapPrefill) {
      setActive(null);
      onAddPosition?.(active.gapPrefill);
    }
  };

  return (
    <div ref={rootRef} className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-widest text-neutral-500">Employment timeline</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full ${coverage.currentlyEmployed ? "bg-emerald-500" : "bg-rose-500"}`}
            />
            <span className="text-neutral-400">
              {coverage.currentlyEmployed
                ? "Currently employed"
                : trailingGap
                  ? `No current role · ${formatMonthSpan(trailingGap.months)} since last job`
                  : "No current role"}
            </span>
          </span>
          <span className="text-neutral-400">
            {gaps.length === 0
              ? "No employment gaps"
              : `${gaps.length} gap${gaps.length === 1 ? "" : "s"} · ${formatMonthSpan(coverage.totalGapMonths)} total`}
          </span>
          {undated.length > 0 && (
            <span className="text-amber-500">
              {undated.length} undated role{undated.length === 1 ? "" : "s"}
            </span>
          )}
          {/* Scale toggle */}
          <span className="inline-flex overflow-hidden rounded-md border border-neutral-700">
            {[
              ["recency", "Recent-weighted"],
              ["linear", "Linear"],
            ].map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setScaleMode(mode)}
                className={`px-2 py-0.5 text-[11px] transition-colors ${
                  scaleMode === mode
                    ? "bg-neutral-700 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-800"
                }`}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
      </div>

      {/* Chart band. Popup can extend past the card (see whitespace-nowrap below). */}
      <div className="relative" style={{ height: bandHeight }}>
        {/* Gap bands sit behind the role blocks, span the full height, and butt
            right up against the neighboring roles (no min-width, no dead space). */}
        {gaps.map((gap, index) => {
          const { left, width } = box(gap.start, gap.end);
          const label = `Employment gap · ${formatMonthSpan(gap.months)}`;
          const sublabel = `${monthIndexToLabel(gap.start)} — ${gap.toPresent ? "Present" : monthIndexToLabel(gap.end)}`;
          const startParts = monthIndexToParts(gap.start);
          const prefill = {
            startMonth: startParts.month,
            startYear: startParts.year,
            ...(gap.toPresent
              ? { endMonth: "", endYear: "present" }
              : { endMonth: monthIndexToParts(gap.end).month, endYear: monthIndexToParts(gap.end).year }),
          };
          const popup = { tone: "gap", label, sublabel, leftPct: left + width / 2, topPx: 0, gapPrefill: prefill };
          return (
            <div
              key={`gap-${index}`}
              className="absolute top-0 cursor-pointer rounded-sm"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                height: bandHeight,
                background:
                  "repeating-linear-gradient(45deg, rgba(244,63,94,0.22) 0, rgba(244,63,94,0.22) 5px, rgba(244,63,94,0.10) 5px, rgba(244,63,94,0.10) 10px)",
                border: "1px solid rgba(244,63,94,0.45)",
              }}
              onMouseEnter={() => openPopup(popup)}
              onMouseLeave={scheduleClose}
              onClick={() => openPopup(popup)}
            />
          );
        })}

        {/* Role blocks — full height when alone, split into lanes only when they
            overlap another role in time. */}
        {placed.map((role, index) => {
          const color = ROLE_COLORS[index % ROLE_COLORS.length];
          const { left, width } = box(role.start, role.end);
          const height = roleHeight(role.groupLanes);
          const topPx = role.lane * (height + LANE_GAP);
          const popup = {
            tone: "role",
            color,
            roleId: role.id,
            label: [role.position, role.company].filter(Boolean).join(" — ") || "Role",
            sublabel: `${monthIndexToLabel(role.start)} — ${role.ongoing ? "Present" : monthIndexToLabel(role.end)} · ${formatMonthSpan(role.end - role.start + 1)}`,
            leftPct: left + width / 2,
            topPx,
          };
          return (
            <div
              key={role.id}
              className="absolute cursor-pointer rounded-[3px] shadow-sm ring-1 ring-black/10 transition-[filter] hover:brightness-110"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                minWidth: 6,
                top: topPx,
                height,
                background: color,
              }}
              onMouseEnter={() => openPopup(popup)}
              onMouseLeave={scheduleClose}
              onClick={() => openPopup(popup)}
            />
          );
        })}

        {/* Floating popup — width follows its content and may extend past the card.
            The action line ("Edit"/"Add") reveals only while the popup is hovered. */}
        {active && (
          <div
            className="absolute z-30 max-w-none -translate-x-1/2 -translate-y-full cursor-pointer whitespace-nowrap rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs shadow-2xl hover:border-neutral-500"
            style={{
              left: `${Math.min(88, Math.max(12, active.leftPct))}%`,
              top: active.topPx - 6,
            }}
            role="button"
            onMouseEnter={() => {
              cancelClose();
              setCtaVisible(true);
            }}
            onMouseLeave={scheduleClose}
            onClick={runAction}
          >
            <p className="flex items-center gap-1.5 font-semibold text-neutral-100">
              {active.tone === "role" && (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: active.color }} />
              )}
              {active.tone === "gap" && <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" />}
              <span>{active.label}</span>
            </p>
            <p className="mt-0.5 text-neutral-400">{active.sublabel}</p>
            {ctaVisible && (
              <p className={`mt-1 font-medium ${active.tone === "gap" ? "text-amber-400" : "text-blue-400"}`}>
                {active.tone === "gap" ? "Add a position →" : "Edit this position →"}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Year axis — most recent on the left */}
      <div className="relative mt-1 h-4 border-t border-neutral-800">
        {axisTicks.map((tick) => (
          <span
            key={tick.index}
            className="absolute top-1 -translate-x-1/2 text-[10px] text-neutral-500"
            style={{ left: `${Math.min(100, Math.max(0, tick.pos))}%` }}
          >
            {tick.year}
          </span>
        ))}
      </div>

      {undated.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-800 pt-3">
          <span className="text-[11px] text-amber-500">Add dates to place these on the timeline:</span>
          {undated.map((role) => (
            <button
              key={role.id}
              type="button"
              onClick={() => onSelectRole?.(role.id)}
              className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
            >
              {[role.position, role.company].filter(Boolean).join(" · ") || "Untitled role"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
