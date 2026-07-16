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
const BLOCK_GAP = 1.5; // px inset per side, so back-to-back blocks show a hairline gap
const CLOSE_DELAY_MS = 140;

function yearOf(monthIndex) {
  return Math.floor(monthIndex / 12);
}

// Build one label per year, positioned at that year's START (its January-1
// boundary) on the axis. The axis runs recent→old, so a year's start sits on its
// right/older edge. Ticks are then thinned by on-screen distance so the recency
// scale, where old years bunch up on the right, never crowds. (We drop no extra
// end tick, so the newest year sits at its own boundary rather than clamping to
// the left edge.)
function buildAxisTicks(domainStart, domainEnd, scalePos) {
  const ticks = [];
  for (let year = yearOf(domainStart); year <= yearOf(domainEnd); year += 1) {
    const pos = Math.min(100, Math.max(0, scalePos(year * 12)));
    ticks.push({ year, pos });
  }
  ticks.sort((a, b) => a.pos - b.pos);

  const kept = [];
  for (const tick of ticks) {
    const last = kept[kept.length - 1];
    if (!last || tick.pos - last.pos >= 6.5) kept.push(tick);
  }
  return kept;
}

export function WorkHistoryTimeline({ workHistory, now = new Date(), onSelectRole, onAddPosition }) {
  const [active, setActive] = useState(null);
  const [ctaVisible, setCtaVisible] = useState(false);
  // The chart is heavy vertically; on phones it's collapsed by default behind a
  // one-line summary so the position cards below get real scroll room. The `sm:`
  // classes keep it always-expanded on desktop regardless of this state.
  const [open, setOpen] = useState(false);
  const [hoverYear, setHoverYear] = useState(null); // year whose gridline is shown
  const [scaleMode, setScaleMode] = useState("recency"); // "recency" | "linear"
  // Hover-capable pointer (desktop mouse) vs. touch. Drives whether a click on a
  // block acts directly or first opens the popup.
  const [canHover, setCanHover] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches
  );
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

  // Keep canHover in sync if the primary pointer changes (e.g. a tablet gaining a
  // mouse). Rare, but cheap to honor.
  useEffect(() => {
    const mq = window.matchMedia?.("(hover: hover) and (pointer: fine)");
    if (!mq) return;
    const onChange = (event) => setCanHover(event.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

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
  const hoverTick = hoverYear == null ? null : axisTicks.find((t) => t.year === hoverYear);
  const trailingGap = gaps.find((gap) => gap.toPresent);

  // One-line recap shown on the collapsed (mobile) summary bar.
  const summaryText = [
    coverage.currentlyEmployed
      ? "Currently employed"
      : trailingGap
        ? `${formatMonthSpan(trailingGap.months)} since last role`
        : "No current role",
    gaps.length === 0 ? "No gaps" : `${gaps.length} gap${gaps.length === 1 ? "" : "s"}`,
    undated.length > 0 ? `${undated.length} undated` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Group positions by employer so multiple titles at one company render as a
  // single colored block, with a divider seam at each promotion / internal
  // switch, instead of separate blocks. Colors are per-employer, assigned in
  // chronological order (placed is already start-sorted). A real >1-month gap
  // between two tenures at the same company still breaks into separate blocks.
  const employerOrder = [];
  const employerRoles = new Map();
  for (const role of placed) {
    if (!employerRoles.has(role.employerId)) {
      employerRoles.set(role.employerId, []);
      employerOrder.push(role.employerId);
    }
    employerRoles.get(role.employerId).push(role);
  }
  const employerColor = new Map(
    employerOrder.map((id, i) => [id, ROLE_COLORS[i % ROLE_COLORS.length]])
  );

  const companyBlocks = []; // one colored block per contiguous run of positions
  const roleSeams = []; // divider lines at internal promotions/switches
  const roleHits = []; // transparent per-position hover/edit targets
  for (const employerId of employerOrder) {
    const roles = employerRoles.get(employerId);
    const color = employerColor.get(employerId);
    const { lane, groupLanes } = roles[0];
    const height = roleHeight(groupLanes);
    const top = lane * (height + LANE_GAP);

    let run = [];
    let runMaxEnd = -Infinity;
    const flushRun = () => {
      if (run.length === 0) return;
      const { left, width } = box(run[0].start, runMaxEnd);
      companyBlocks.push({ key: `emp-${employerId}-${run[0].start}`, color, left, width, top, height });
      for (let k = 1; k < run.length; k += 1) {
        roleSeams.push({
          key: `seam-${run[k].id}`,
          pos: Math.min(100, Math.max(0, scalePos(run[k].start))),
          top,
          height,
        });
      }
      run = [];
      runMaxEnd = -Infinity;
    };
    for (const role of roles) {
      if (run.length && role.start > runMaxEnd + 1) flushRun();
      run.push(role);
      runMaxEnd = Math.max(runMaxEnd, role.end);
    }
    flushRun();

    for (const role of roles) {
      const { left, width } = box(role.start, role.end);
      roleHits.push({
        role,
        left,
        width,
        top,
        height,
        popup: {
          tone: "role",
          color,
          roleId: role.id,
          label: [role.position, role.company].filter(Boolean).join(" — ") || "Role",
          sublabel: `${monthIndexToLabel(role.start)} — ${role.ongoing ? "Present" : monthIndexToLabel(role.end)} · ${formatMonthSpan(role.end - role.start + 1)}`,
          leftPct: left + width / 2,
          topPx: top,
        },
      });
    }
  }

  // Navigate to a role's details, or seed a new position from a gap.
  const performAction = (data) => {
    if (!data) return;
    if (data.roleId) {
      setActive(null);
      onSelectRole?.(data.roleId);
    } else if (data.gapPrefill) {
      setActive(null);
      onAddPosition?.(data.gapPrefill);
    }
  };

  // Clicking a block: on a hovering pointer the popup is already shown, so act
  // directly rather than making the user chase a tooltip that may have started to
  // close. On touch, the first tap opens the popup and its own tap runs the action.
  const handleBlockClick = (data) => {
    if (canHover) performAction(data);
    else openPopup(data);
  };

  return (
    <div ref={rootRef} className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4">
      {/* Mobile-only collapse toggle. Tapping it reveals the full chart; on
          desktop the toggle is hidden and the chart is always shown. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left sm:hidden"
      >
        <span className="shrink-0 text-xs uppercase tracking-widest text-neutral-400">Timeline</span>
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">{summaryText}</span>
        <svg
          className={`h-4 w-4 shrink-0 text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {/* Full chart — hidden on mobile until expanded, always visible on desktop. */}
      <div className={`${open ? "mt-3" : "hidden"} sm:mt-0 sm:block`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-widest text-neutral-500">Employment timeline</p>
        <div className="hidden sm:flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
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
        {/* Vertical gridline at the hovered year's start, dropped straight down
            from its label so it's easy to read which roles/gaps that year spans. */}
        {hoverTick && (
          <div
            className="pointer-events-none absolute top-0 z-20 w-px bg-neutral-300/70"
            style={{ left: `${Math.min(100, Math.max(0, hoverTick.pos))}%`, height: bandHeight }}
          />
        )}

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
              onClick={() => handleBlockClick(popup)}
            />
          );
        })}

        {/* Company blocks — one per contiguous run of positions at the same
            employer, so promotions/switches read as a single block rather than
            separate colored bars. Full height when alone, split into lanes only
            when a concurrent employer overlaps in time. */}
        {companyBlocks.map((b) => (
          <div
            key={b.key}
            className="pointer-events-none absolute rounded-[3px] shadow-sm ring-1 ring-black/10"
            style={{
              left: `calc(${b.left}% + ${BLOCK_GAP}px)`,
              width: `calc(${b.width}% - ${BLOCK_GAP * 2}px)`,
              minWidth: 4,
              top: b.top,
              height: b.height,
              background: b.color,
            }}
          />
        ))}

        {/* Semitransparent seams marking a promotion or position switch within a
            company (the boundary between two adjacent titles). */}
        {roleSeams.map((s) => (
          <div
            key={s.key}
            className="pointer-events-none absolute z-10 rounded-full"
            style={{
              left: `${s.pos}%`,
              top: s.top + 2,
              height: Math.max(2, s.height - 4),
              width: 2,
              transform: "translateX(-1px)",
              background: "rgba(255,255,255,0.55)",
            }}
          />
        ))}

        {/* Transparent hit areas — one per position — carry hover/edit and
            highlight just the hovered segment inside its company block. */}
        {roleHits.map(({ role, left, width, top, height, popup }) => (
          <div
            key={role.id}
            className="absolute z-10 cursor-pointer rounded-[3px] transition-colors hover:bg-white/10"
            style={{ left: `${left}%`, width: `${width}%`, minWidth: 6, top, height }}
            onMouseEnter={() => openPopup(popup)}
            onMouseLeave={scheduleClose}
            onClick={() => handleBlockClick(popup)}
          />
        ))}

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
            onClick={() => performAction(active)}
          >
            <p className="flex items-center gap-1.5 font-semibold text-neutral-100">
              {active.tone === "role" && (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: active.color }} />
              )}
              {active.tone === "gap" && <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" />}
              <span>{active.label}</span>
            </p>
            <p className="mt-0.5 text-neutral-400">{active.sublabel}</p>
            {(canHover || ctaVisible) && (
              <p className={`mt-1 font-medium ${active.tone === "gap" ? "text-amber-400" : "text-blue-400"}`}>
                {active.tone === "gap" ? "Add a position →" : "Edit this position →"}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Year axis — most recent on the left. Hover a year to drop a gridline. */}
      <div className="relative mt-1 h-4 border-t border-neutral-800">
        {axisTicks.map((tick) => (
          <span
            key={tick.year}
            className={`absolute top-1 -translate-x-1/2 cursor-default text-[10px] tabular-nums transition-colors ${
              hoverYear === tick.year ? "text-neutral-200" : "text-neutral-500 hover:text-neutral-300"
            }`}
            style={{ left: `${Math.min(100, Math.max(0, tick.pos))}%` }}
            onMouseEnter={() => setHoverYear(tick.year)}
            onMouseLeave={() => setHoverYear(null)}
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
    </div>
  );
}
