import { describe, it, expect } from "vitest";
import {
  buildTimeline,
  gapKey,
  gapPrefill,
  formatGapRange,
  longestGap,
  interleaveGaps,
  formatRoleRange,
} from "./workHistoryTimeline";
import { sortWorkHistory } from "./resumeModel";

// A fixed "now" keeps every gap computation deterministic.
const now = new Date(2026, 6, 1); // July 2026

const role = (id, startYear, startMonth, endYear, endMonth = "") => ({
  id,
  position: id,
  company: "",
  startYear,
  startMonth,
  endYear,
  endMonth,
  description: "",
});

describe("gap helpers for the position list", () => {
  const history = sortWorkHistory([
    role("current", "2022", "01", "present"),
    role("middle", "2018", "01", "2021", "02"), // gap Mar 2021 – Dec 2021 (10 months)
    role("early", "2014", "01", "2017", "06"), // gap Jul 2017 – Dec 2017 (6 months)
  ]);

  it("places each gap between the roles on either side, newest first", () => {
    const { gaps } = buildTimeline(history, now);
    const rows = interleaveGaps(history, gaps, now);
    expect(rows.map((row) => (row.type === "gap" ? `gap:${row.gap.months}` : row.item.id))).toEqual([
      "current",
      "gap:10",
      "middle",
      "gap:6",
      "early",
    ]);
  });

  it("puts an open gap that runs to today above every role", () => {
    const ended = sortWorkHistory([role("last", "2019", "01", "2025", "09")]);
    const { gaps } = buildTimeline(ended, now);
    const rows = interleaveGaps(ended, gaps, now);
    expect(rows[0].type).toBe("gap");
    expect(rows[0].gap.toPresent).toBe(true);
    expect(formatGapRange(rows[0].gap)).toBe("Oct 2025 – now");
  });

  it("never anchors a gap on an undated role", () => {
    const withUndated = sortWorkHistory([...history, role("undated", "", "", "")]);
    const { gaps } = buildTimeline(withUndated, now);
    const rows = interleaveGaps(withUndated, gaps, now);
    expect(rows.filter((row) => row.type === "gap")).toHaveLength(2);
    expect(rows.findIndex((row) => row.type === "gap")).toBeGreaterThan(
      rows.findIndex((row) => row.type === "role" && row.item.id === "current")
    );
  });

  it("finds the longest gap and describes when it happened", () => {
    const { gaps } = buildTimeline(history, now);
    const gap = longestGap(gaps);
    expect(gap.months).toBe(10);
    expect(formatGapRange(gap)).toBe("Mar – Dec 2021");
    expect(longestGap([])).toBeNull();
  });

  it("spells out both years when a gap crosses New Year", () => {
    expect(formatGapRange({ start: 2020 * 12 + 10, end: 2021 * 12 + 1, toPresent: false })).toBe("Nov 2020 – Feb 2021");
  });

  it("keys an open gap on its start so it survives the months ticking by", () => {
    expect(gapKey({ start: 100, end: 120, toPresent: true })).toBe(gapKey({ start: 100, end: 125, toPresent: true }));
    expect(gapKey({ start: 100, end: 120, toPresent: false })).not.toBe(gapKey({ start: 100, end: 121, toPresent: false }));
  });

  it("prefills a new position with the gap's dates", () => {
    const { gaps } = buildTimeline(history, now);
    expect(gapPrefill(longestGap(gaps))).toEqual({ startMonth: "03", startYear: "2021", endMonth: "12", endYear: "2021" });
    expect(gapPrefill({ start: 2025 * 12 + 9, end: 0, toPresent: true })).toEqual({
      startMonth: "10",
      startYear: "2025",
      endMonth: "",
      endYear: "present",
    });
  });
});

describe("formatRoleRange", () => {
  it("shows years for list rows and months when asked", () => {
    expect(formatRoleRange(role("a", "2022", "01", "present"))).toBe("2022 – now");
    expect(formatRoleRange(role("a", "2022", "01", "present"), { withMonths: true })).toBe("Jan 2022 – Present");
    expect(formatRoleRange(role("a", "2018", "03", "2021", "11"), { withMonths: true })).toBe("Mar 2018 – Nov 2021");
    expect(formatRoleRange(role("a", "2019", "", "2019", ""))).toBe("2019");
    expect(formatRoleRange(role("a", "", "", ""))).toBe("");
  });
});
