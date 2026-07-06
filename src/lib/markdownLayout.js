import { prepareWithSegments, layout, layoutWithLines } from "@chenglou/pretext";
import { FONT, LH_DEFAULT, LH_MIN, LH_MAX, FS_MAX_DEFAULT } from "./constants";

/* ── Separator gap ─────────────────────────────────────────────
 * The padding above/below an `hr` is calibrated at the reference
 * font size. When auto-fit shrinks the font to pack in more text,
 * scale the gap down with it so the divider band stays proportional
 * instead of ballooning relative to the now-tiny text. Never grows
 * past the configured value.
 */
function separatorGap(separatorSpacing, baseFontSize) {
  const scale = Math.min(1, baseFontSize / FS_MAX_DEFAULT);
  return separatorSpacing * scale;
}

/* ── Parse markdown into blocks ────────────────────────────── */
export function parseMarkdown(md) {
  const blocks = [];
  const lines = md.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

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

    const prevBlock = blocks[blocks.length - 1];
    const isAfterTitle = prevBlock && prevBlock.bold && prevBlock.fontScale === 1 && prevBlock.mb === 2;

    if (isAfterTitle) {
      blocks.push({ text: line, fontScale: 0.8, bold: false, mb: 6, color: "#999" });
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

/* ── Measure blocks (pure math, no DOM) ────────────────────── */
export function measureBlocks(blocks, baseFontSize, contentW, lhMult = LH_DEFAULT, sectionSpacing = 18, itemSpacing = 10, separatorSpacing = 16) {
  let h = 0;
  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx];
    if (block.mt) {
      const isSection = block.fontScale === 0.85 && block.bold;
      const isItem = block.mt > 0 && !isSection;
      h += isSection ? sectionSpacing : isItem ? itemSpacing : block.mt;
    }
    if (block.type === "hr") {
      const gap = separatorGap(separatorSpacing, baseFontSize);
      h += gap + 1 + gap;
      continue;
    }
    const fs = baseFontSize * block.fontScale;
    const lh = fs * lhMult;
    const font = fontString(baseFontSize, block);
    h += layout(prepareWithSegments(block.text, font), contentW, lh).height;
    // Skip mb if the next block has mt or is an hr (spacing is handled by them)
    const next = blocks[idx + 1];
    if (next && (next.mt || next.type === "hr")) continue;
    h += block.mb;
  }
  return h;
}

/* ── Layout blocks into positioned lines ─────────────────── */
export function layoutBlocks(blocks, baseFontSize, contentW, pad, lhMult = LH_DEFAULT, sectionSpacing = 18, itemSpacing = 10, separatorSpacing = 16) {
  const positioned = [];
  let y = pad;

  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx];
    if (block.mt) {
      const isSection = block.fontScale === 0.85 && block.bold;
      const isItem = block.mt > 0 && !isSection;
      y += isSection ? sectionSpacing : isItem ? itemSpacing : block.mt;
    }
    if (block.type === "hr") {
      const gap = separatorGap(separatorSpacing, baseFontSize);
      y += gap;
      positioned.push({ type: "hr", y });
      y += 1 + gap;
      continue;
    }

    const fs = baseFontSize * block.fontScale;
    const lh = fs * lhMult;
    const font = fontString(baseFontSize, block);
    const prepared = prepareWithSegments(block.text, font);
    const result = layoutWithLines(prepared, contentW, lh);

    for (const line of result.lines) {
      positioned.push({
        type: "text",
        text: line.text,
        x: pad,
        y,
        font,
        fontSize: fs,
        fontWeight: block.bold ? "bold" : "normal",
        lineHeight: lh,
        color: block.color,
      });
      y += lh;
    }

    // Skip mb if the next block has mt or is an hr (spacing is handled by them)
    const next = blocks[idx + 1];
    if (next && (next.mt || next.type === "hr")) continue;
    y += block.mb;
  }

  return positioned;
}

/* ── Binary search for optimal font size + line height ────── */
export function findOptimalFit(blocks, contentW, maxH, minFs = 6, maxFs = 24, sectionSpacing = 18, itemSpacing = 10, separatorSpacing = 16) {
  // Pass 1: max font size at tightest line spacing
  let lo = minFs;
  let hi = maxFs;
  while (hi - lo > 0.01) {
    const mid = (lo + hi) / 2;
    if (measureBlocks(blocks, mid, contentW, LH_MIN, sectionSpacing, itemSpacing, separatorSpacing) <= maxH) lo = mid;
    else hi = mid;
  }
  const fontSize = Math.floor(lo * 100) / 100;

  // Pass 2: expand line-height to fill remaining space
  let lhLo = LH_MIN;
  let lhHi = LH_MAX;
  while (lhHi - lhLo > 0.001) {
    const mid = (lhLo + lhHi) / 2;
    if (measureBlocks(blocks, fontSize, contentW, mid, sectionSpacing, itemSpacing, separatorSpacing) <= maxH) lhLo = mid;
    else lhHi = mid;
  }
  const lineHeightMult = Math.floor(lhLo * 1000) / 1000;

  return { fontSize, lineHeightMult };
}
