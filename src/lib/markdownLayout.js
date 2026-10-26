import { prepareWithSegments, layoutNextLine } from "@chenglou/pretext";
import { FONT, LH_DEFAULT, LH_MIN, LH_MAX, LH_COMFORT, FS_MAX_DEFAULT, FS_MULTI_PAGE_MAX } from "./constants";

/* ── Spacing scale ─────────────────────────────────────────────
 * Every vertical gap — section and entry spacing, the space under
 * a block, the padding around an `hr` — is calibrated at the
 * reference font size. When auto-fit shrinks the font to pack in
 * more text, the gaps shrink with it so they stay proportional
 * instead of ballooning relative to the now-tiny text. Never grows
 * past the configured value.
 */
function spacingScale(baseFontSize) {
  return Math.min(1, baseFontSize / FS_MAX_DEFAULT);
}

function separatorGap(separatorSpacing, baseFontSize) {
  return separatorSpacing * spacingScale(baseFontSize);
}

// "**Title** · Start — End": one of several roles under a "### Company".
const ROLE_LINE = /^\*\*(.+?)\*\*\s*(?:·\s*(.*))?$/;

/* ── Parse markdown into blocks ────────────────────────────── */
export function parseMarkdown(md) {
  const blocks = [];
  const lines = md.split("\n");
  let i = 0;

  while (i < lines.length) {
    // Lines are drawn in a single weight, so inline **bold** keeps its words
    // and drops the markers.
    const line = lines[i].replace(/\*\*(.+?)\*\*/g, "$1");
    const role = lines[i].match(ROLE_LINE);

    if (line.trim() === "---") {
      blocks.push({ type: "hr", mb: 16 });
      i++;
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith("# ")) {
      blocks.push({ text: line.slice(2), fontScale: 1.5, bold: true, mb: 4, color: "#111" });
      i++;
      continue;
    }

    if (line.startsWith("## ")) {
      blocks.push({ text: line.slice(3), fontScale: 0.85, bold: true, mt: 18, mb: 3, color: "#999" });
      i++;
      continue;
    }

    if (line.startsWith("### ")) {
      const prev = blocks[blocks.length - 1];
      const afterSection = prev && prev.fontScale === 0.85 && prev.bold;
      blocks.push({ text: line.slice(4), fontScale: 1, bold: true, mt: afterSection ? 0 : 10, mb: 2, color: "#111" });
      i++;
      continue;
    }

    if (line.startsWith("- ")) {
      blocks.push({ text: "• " + line.slice(2), fontScale: 1, bold: false, mb: 3, color: "#555" });
      i++;
      continue;
    }

    // Laid out like a single-role entry: the title, then its dates. The first
    // role sits right under the company; later ones get entry spacing.
    if (role) {
      const prev = blocks[blocks.length - 1];
      const underHeading = prev && prev.bold && prev.fontScale === 1;
      blocks.push({ text: role[1], fontScale: 1, bold: true, mt: underHeading ? 0 : 10, mb: 2, color: "#333", role: true });
      if (role[2]) blocks.push({ text: role[2], fontScale: 0.8, bold: false, mb: 6, color: "#999", underTitle: true });
      i++;
      continue;
    }

    const prevBlock = blocks[blocks.length - 1];
    const isAfterTitle = prevBlock && prevBlock.bold && prevBlock.fontScale === 1 && prevBlock.mb === 2;

    if (isAfterTitle) {
      blocks.push({ text: line, fontScale: 0.8, bold: false, mb: 6, color: "#999", underTitle: true });
    } else if (prevBlock && prevBlock.fontScale === 1.5) {
      blocks.push({ text: line, fontScale: 1, bold: false, mb: 6, color: "#555" });
    } else if (prevBlock && !prevBlock.bold && prevBlock.color === "#555" && prevBlock.mb === 6 && prevBlock.fontScale === 1) {
      blocks.push({ text: line, fontScale: 0.8, bold: false, mb: 16, color: "#999" });
    } else {
      blocks.push({ text: line, fontScale: 1, bold: false, mb: 6, color: "#333" });
    }
    i++;
  }

  return blocks;
}

/* ── Build font string (same for prepare + DOM) ──────────── */
function fontString(baseFontSize, block) {
  const fs = baseFontSize * block.fontScale;
  return `${block.bold ? "bold " : ""}${fs}px ${FONT}`;
}

/* ── Spacing before a block ────────────────────────────────
 * A block's `mt` is a kind marker, not a size: section headers
 * take `sectionSpacing`, entry titles take `itemSpacing`.
 */
function leadingSpace(block, baseFontSize, sectionSpacing, itemSpacing) {
  if (!block.mt) return 0;
  const isSection = block.fontScale === 0.85 && block.bold;
  return (isSection ? sectionSpacing : itemSpacing) * spacingScale(baseFontSize);
}

/* ── Keep-with-next ────────────────────────────────────────
 * Blocks that must never end a page: the name, section headers,
 * entry titles, the company/dates line under a title, and the
 * divider. Each is pulled onto the next page together with the
 * first block of body text that follows it.
 */
export function keepsWithNext(block) {
  if (block.type === "hr") return true;
  if (block.bold) return true;
  return block.fontScale === 0.8 && block.color === "#999";
}

/* ── Measure blocks (pure math, no DOM) ────────────────────── */
export function measureBlocks(blocks, baseFontSize, contentW, lhMult = LH_DEFAULT, sectionSpacing = 18, itemSpacing = 10, separatorSpacing = 16) {
  return prepareBlocks(blocks, baseFontSize, contentW, lhMult, sectionSpacing, itemSpacing, separatorSpacing)
    .reduce((h, entry) => h + entry.lead + entry.bodyH + entry.trail, 0);
}

/* ── Dates beside the title ────────────────────────────────
 * The line under an entry title (its dates, or "Year · Details")
 * moves up onto the title's first line, right-aligned, when it
 * takes at most ASIDE_MAX_SHARE of the width; the title wraps in
 * the room left, an em clear of it. It is drawn at the title's
 * size so the two share a baseline. A longer line keeps its own
 * row under the title.
 */
const ASIDE_MAX_SHARE = 0.45;

/* ── Line breaking ─────────────────────────────────────────
 * pretext 0.0.3's batch walk (layoutWithLines, walkLineRanges)
 * drops a segment when it breaks a line between two runs with no
 * space between them — "data-|accuracy", "LLM|/RAG" — so a word
 * silently vanishes from the page. Stepping one line at a time
 * with layoutNextLine breaks the same text correctly, so every
 * line is taken that way.
 */
const LINE_START = { segmentIndex: 0, graphemeIndex: 0 };

function breakLines(text, font, width) {
  const prepared = prepareWithSegments(text, font);
  const lines = [];
  for (let line = layoutNextLine(prepared, LINE_START, width); line; line = layoutNextLine(prepared, line.end, width)) {
    lines.push(line);
  }
  return lines;
}

function textLines(text, font, fontSize, width, lineHeight, block) {
  return breakLines(text, font, width).map((line) => ({
    type: "text",
    text: line.text,
    width: line.width,
    font,
    fontSize,
    fontWeight: block.bold ? "bold" : "normal",
    lineHeight,
    color: block.color,
  }));
}

/* ── Break blocks into lines with their spacing ─────────────
 * One entry per block: the space above it, its positioned-line
 * payload (or the hr marker), and the space below it (`mb`,
 * unless the next block brings its own spacing). A title that
 * takes its dates onto its first line absorbs the dates block,
 * and the space below it.
 */
function prepareBlocks(blocks, baseFontSize, contentW, lhMult, sectionSpacing, itemSpacing, separatorSpacing) {
  const trailAfter = (idx) => {
    const next = blocks[idx + 1];
    return next && (next.mt || next.type === "hr") ? 0 : blocks[idx].mb * spacingScale(baseFontSize);
  };

  const entries = [];
  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx];
    const lead = leadingSpace(block, baseFontSize, sectionSpacing, itemSpacing);
    const keepWithNext = keepsWithNext(block);

    if (block.type === "hr") {
      const gap = separatorGap(separatorSpacing, baseFontSize);
      entries.push({ type: "hr", lead: lead + gap, trail: gap, bodyH: 1, lines: [], keepWithNext });
      continue;
    }

    const fs = baseFontSize * block.fontScale;
    const lh = fs * lhMult;
    const font = fontString(baseFontSize, block);

    const under = blocks[idx + 1];
    if (under?.underTitle) {
      const asideStyle = { ...under, fontScale: block.fontScale };
      const asideFont = fontString(baseFontSize, asideStyle);
      const aside = textLines(under.text, asideFont, fs, contentW, lh, asideStyle);
      if (aside.length === 1 && aside[0].width <= contentW * ASIDE_MAX_SHARE) {
        const lines = textLines(block.text, font, fs, contentW - aside[0].width - fs, lh, block);
        lines[0].aside = aside[0];
        idx += 1;
        entries.push({ type: "text", lead, trail: trailAfter(idx), bodyH: lines.length * lh, lines, lineHeight: lh, keepWithNext, role: block.role });
        continue;
      }
    }

    const lines = textLines(block.text, font, fs, contentW, lh, block);
    entries.push({ type: "text", lead, trail: trailAfter(idx), bodyH: lines.length * lh, lines, lineHeight: lh, keepWithNext, role: block.role });
  }
  return entries;
}

// Position one prepared line, and the dates beside it if it carries any.
function placeLine(items, { aside, ...line }, pad, contentW, y) {
  items.push({ ...line, x: pad, y });
  if (aside) items.push({ ...aside, x: pad + contentW - aside.width, y });
}

/* ── Paginate blocks ───────────────────────────────────────
 * Flow the blocks onto as many pages of `pageH` as they need,
 * `pad` inset on every side. Returns one entry per page:
 *   { items, contentBottom }
 * where `items` are positioned lines/hrs with y relative to the
 * page top and `contentBottom` is where the last block ends.
 *
 * Breaking rules:
 *  - A job stays on one page: its title, dates, and every bullet,
 *    and for a company with several roles, all of them. A job that
 *    doesn't fit in the room left moves whole to the next page.
 *  - Only a job taller than a whole page is split, between roles
 *    first, then between bullets, keeping each role together when
 *    it fits on a page by itself.
 *  - A heading, the line under a title, or an hr never ends a
 *    page: it moves to the next page with the body text after it.
 *  - A block's lines stay together; only a block taller than a
 *    whole page is split across pages.
 *  - A page starts flush at `pad`: no section gap, and no hr, at
 *    the top of a page.
 */
export function paginateBlocks(blocks, baseFontSize, contentW, pad, pageH, lhMult = LH_DEFAULT, sectionSpacing = 18, itemSpacing = 10, separatorSpacing = 16) {
  const prepared = prepareBlocks(blocks, baseFontSize, contentW, lhMult, sectionSpacing, itemSpacing, separatorSpacing);
  const limit = pageH - pad;

  // Group each run of keep-with-next blocks with the body block that follows.
  const chunks = [];
  let current = [];
  for (const entry of prepared) {
    current.push(entry);
    if (!entry.keepWithNext) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);

  // Group the chunks into jobs, and each job into its roles. A chunk that
  // opens with body text or a role line belongs to the job before it; any
  // other chunk (a job title, a section header, a divider) starts a new one.
  const jobs = [];
  for (const chunk of chunks) {
    const [first] = chunk;
    const job = jobs[jobs.length - 1];
    if (job && first.role) job.push([chunk]);
    else if (job && !first.keepWithNext) job[job.length - 1].push(chunk);
    else jobs.push([[chunk]]);
  }

  const pages = [];
  let items = [];
  let y = pad;
  let contentBottom = pad;
  let pageEmpty = true;

  const closePage = () => {
    pages.push({ items, contentBottom });
    items = [];
    y = pad;
    contentBottom = pad;
    pageEmpty = true;
  };

  // Height of `entries` placed from the current position (or from the top
  // of a fresh page) down to the end of the last one's text.
  const heightOf = (entries, freshPage) =>
    entries.reduce((sum, entry, i) => {
      const lead = i === 0 && freshPage ? 0 : entry.lead;
      const body = entry.type === "hr" && i === 0 && freshPage ? 0 : entry.bodyH;
      return sum + lead + body + entry.trail;
    }, 0) - entries[entries.length - 1].trail;

  // Start a new page for `entries` if they don't fit in the room left but
  // would fit on a page of their own.
  const keepTogether = (entries) => {
    if (!pageEmpty && y + heightOf(entries, false) > limit && pad + heightOf(entries, true) <= limit) closePage();
  };

  const placeChunk = (chunk) => {
    if (!pageEmpty && y + heightOf(chunk, false) > limit) closePage();

    for (const entry of chunk) {
      if (entry.type === "hr") {
        // A divider at the very top of a page has nothing to divide.
        if (pageEmpty) continue;
        y += entry.lead;
        items.push({ type: "hr", y });
        y += entry.bodyH;
        contentBottom = y;
        y += entry.trail;
        pageEmpty = false;
        continue;
      }

      if (!pageEmpty) y += entry.lead;
      for (const line of entry.lines) {
        // Only a block taller than a page gets here with no room left.
        if (!pageEmpty && y + entry.lineHeight > limit) closePage();
        placeLine(items, line, pad, contentW, y);
        y += entry.lineHeight;
        contentBottom = y;
        pageEmpty = false;
      }
      y += entry.trail;
    }
  };

  for (const job of jobs) {
    keepTogether(job.flat(2));
    for (const role of job) {
      keepTogether(role.flat());
      role.forEach(placeChunk);
    }
  }
  pages.push({ items, contentBottom });
  return pages;
}

/* ── Layout blocks into positioned lines (single page) ────── */
export function layoutBlocks(blocks, baseFontSize, contentW, pad, lhMult = LH_DEFAULT, sectionSpacing = 18, itemSpacing = 10, separatorSpacing = 16) {
  const prepared = prepareBlocks(blocks, baseFontSize, contentW, lhMult, sectionSpacing, itemSpacing, separatorSpacing);
  const positioned = [];
  let y = pad;
  for (const entry of prepared) {
    y += entry.lead;
    if (entry.type === "hr") {
      positioned.push({ type: "hr", y });
      y += entry.bodyH + entry.trail;
      continue;
    }
    for (const line of entry.lines) {
      placeLine(positioned, line, pad, contentW, y);
      y += entry.lineHeight;
    }
    y += entry.trail;
  }
  return positioned;
}

/* ── Fit text to the fewest pages that stay readable ────────
 * Page counts are tried in order, each with the same two binary
 * searches: the largest font that fits at a given line spacing,
 * then the widest line spacing that still fits at that font.
 *
 * One page: the font grows at the tightest spacing, up to `maxFs`.
 * If it reaches `minReadableFs` (or no more pages are allowed),
 * spacing then opens up to LH_MAX, the way a short resume always
 * has.
 *
 * More pages: there is room to spare, so the font stops at
 * `multiPageMaxFs` and is sized at LH_COMFORT spacing, with any
 * room left widening it up to LH_DEFAULT. The last page may stay
 * part-empty. Only when that comfortable font would fall below
 * `minReadableFs` does spacing drop to the tightest to keep size.
 */
export function findPagedFit(blocks, {
  contentW,
  pad,
  pageH,
  maxPages = 1,
  minReadableFs = 0,
  minFs = 6,
  maxFs = 24,
  multiPageMaxFs = FS_MULTI_PAGE_MAX,
  sectionSpacing = 18,
  itemSpacing = 10,
  separatorSpacing = 16,
}) {
  const pagesAt = (fs, lh) =>
    paginateBlocks(blocks, fs, contentW, pad, pageH, lh, sectionSpacing, itemSpacing, separatorSpacing).length;
  const floor = Math.min(minReadableFs, maxFs);

  const largestFont = (allowed, lh, cap) => {
    if (pagesAt(cap, lh) <= allowed) return cap;
    let lo = minFs;
    let hi = cap;
    while (hi - lo > 0.01) {
      const mid = (lo + hi) / 2;
      if (pagesAt(mid, lh) <= allowed) lo = mid;
      else hi = mid;
    }
    return Math.floor(lo * 100) / 100;
  };

  const fit = (allowed, fontSize, lhLo, lhCap) => {
    let lo = lhLo;
    let hi = lhCap;
    if (pagesAt(fontSize, hi) <= allowed) {
      lo = hi;
    } else {
      while (hi - lo > 0.001) {
        const mid = (lo + hi) / 2;
        if (pagesAt(fontSize, mid) <= allowed) lo = mid;
        else hi = mid;
      }
    }
    const lineHeightMult = Math.floor(lo * 1000) / 1000;
    return { fontSize, lineHeightMult, pageCount: pagesAt(fontSize, lineHeightMult) };
  };

  for (let allowed = 1; allowed <= maxPages; allowed++) {
    const isLast = allowed === maxPages;
    if (allowed === 1) {
      const fontSize = largestFont(1, LH_MIN, maxFs);
      if (fontSize >= floor || isLast) return fit(1, fontSize, LH_MIN, LH_MAX);
      continue;
    }
    const cap = Math.min(maxFs, multiPageMaxFs);
    const comfortable = largestFont(allowed, LH_COMFORT, cap);
    if (comfortable >= floor) return fit(allowed, comfortable, LH_COMFORT, LH_DEFAULT);
    const fontSize = largestFont(allowed, LH_MIN, cap);
    if (fontSize >= floor || isLast) return fit(allowed, fontSize, LH_MIN, LH_DEFAULT);
  }
  return { fontSize: minFs, lineHeightMult: LH_MIN, pageCount: pagesAt(minFs, LH_MIN) };
}
