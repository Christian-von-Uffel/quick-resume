import { describe, it, expect, vi } from "vitest";

// pretext measures text through a canvas, which the node test environment
// lacks. Stand in a fixed-width model: every glyph is half the font size wide,
// lines wrap greedily on spaces. Breaking rules don't depend on real metrics.
vi.mock("@chenglou/pretext", () => {
  const glyphWidth = (font) => parseFloat(font.match(/(\d+(?:\.\d+)?)px/)[1]) * 0.5;
  const wrap = ({ text, font }, width) => {
    const perLine = Math.max(1, Math.floor(width / glyphWidth(font)));
    const lines = [];
    let current = "";
    for (const word of text.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= perLine || !current) current = candidate;
      else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
    return lines;
  };
  return {
    prepareWithSegments: (text, font) => ({ text, font }),
    layoutWithLines: (prepared, width, lineHeight) => {
      const lines = wrap(prepared, width).map((text) => ({ text, width: text.length * glyphWidth(prepared.font) }));
      return { lines, lineCount: lines.length, height: lines.length * lineHeight };
    },
  };
});

const { parseMarkdown, paginateBlocks, findPagedFit, keepsWithNext, measureBlocks } = await import(
  "./markdownLayout"
);
const { FS_MAX_DEFAULT, LH_COMFORT } = await import("./constants");

const PAD = 10;
const PAGE_H = 200;
const CONTENT_W = 400;
const FS = 10;
const LH = 1; // one line = 10px, so heights are easy to reason about

const bullets = (n, prefix = "Did a thing") =>
  Array.from({ length: n }, (_, i) => `- ${prefix} ${i + 1}`).join("\n");

const resume = (bulletCount) => `# Jane Doe
Portland · jane@example.com

---

## Experience

### Engineer
Acme · 2020 – 2024

${bullets(bulletCount)}

## Education

### State University
BS Computer Science · 2016 – 2020

- Graduated with honors`;

const lastTextItem = (page) => [...page.items].reverse().find((item) => item.type === "text");

describe("keepsWithNext", () => {
  it("marks headings, the line under a title, and dividers", () => {
    const blocks = parseMarkdown(resume(1));
    const byText = (text) => blocks.find((block) => block.text === text);
    expect(keepsWithNext(byText("Jane Doe"))).toBe(true);
    expect(keepsWithNext(byText("Experience"))).toBe(true);
    expect(keepsWithNext(byText("Engineer"))).toBe(true);
    expect(keepsWithNext(byText("Acme · 2020 – 2024"))).toBe(true);
    expect(keepsWithNext(blocks.find((block) => block.type === "hr"))).toBe(true);
    expect(keepsWithNext(byText("• Did a thing 1"))).toBe(false);
  });
});

describe("paginateBlocks", () => {
  it("keeps a short resume on one page, starting at the padding", () => {
    const pages = paginateBlocks(parseMarkdown(resume(2)), FS, CONTENT_W, PAD, PAGE_H, LH, 0, 0, 0);
    expect(pages).toHaveLength(1);
    expect(pages[0].items[0]).toMatchObject({ type: "text", text: "Jane Doe", x: PAD, y: PAD });
    expect(pages[0].contentBottom).toBeLessThanOrEqual(PAGE_H - PAD);
  });

  it("never leaves a heading or the line under a title at the bottom of a page", () => {
    // Walk every bullet count so the Education block lands at every possible
    // offset relative to the page bottom.
    for (let count = 1; count <= 40; count++) {
      const pages = paginateBlocks(parseMarkdown(resume(count)), FS, CONTENT_W, PAD, PAGE_H, LH, 0, 0, 0);
      for (const page of pages) {
        const last = lastTextItem(page);
        expect(last.fontWeight, `bullets=${count}`).toBe("normal");
        expect(last.color, `bullets=${count}`).not.toBe("#999");
        expect(page.items[0].type, `bullets=${count}`).toBe("text");
        for (const item of page.items) {
          if (item.type === "text") {
            expect(item.y + item.lineHeight, `bullets=${count}`).toBeLessThanOrEqual(PAGE_H - PAD + 1e-9);
          }
        }
      }
    }
  });

  it("moves a section header to the next page together with its first entry", () => {
    // Grow the Experience section until the Education header first gets pushed
    // off page one: it must then open page two with its whole first entry.
    let pages;
    for (let count = 1; count <= 40 && !pages; count++) {
      const candidate = paginateBlocks(parseMarkdown(resume(count)), FS, CONTENT_W, PAD, PAGE_H, LH, 0, 0, 0);
      if (candidate.length > 1 && !candidate[0].items.some((item) => item.text === "Education")) {
        pages = candidate;
      }
    }
    expect(pages).toBeDefined();
    const pageWithEducation = pages.find((page) => page.items.some((item) => item.text === "Education"));
    const texts = pageWithEducation.items.map((item) => item.text);
    expect(texts[0]).toBe("Education");
    expect(pageWithEducation.items[0].y).toBe(PAD);
    expect(texts).toContain("State University");
    expect(texts).toContain("BS Computer Science · 2016 – 2020");
    expect(texts).toContain("• Graduated with honors");
  });

  it("does not open a page with a section gap or a divider", () => {
    let opened = 0;
    for (let count = 1; count <= 40; count++) {
      const md = `${bullets(count)}\n\n---\n\n## Next\n\n### Role\nLine under title\n\n- Body`;
      const pages = paginateBlocks(parseMarkdown(md), FS, CONTENT_W, PAD, PAGE_H, LH, 30, 10, 8);
      for (const page of pages.slice(1)) {
        expect(page.items[0].type, `bullets=${count}`).toBe("text");
        expect(page.items[0].y, `bullets=${count}`).toBe(PAD);
      }
      if (pages.length === 2 && pages[1].items[0].text === "Next") {
        opened += 1;
        expect(pages[1].items.some((item) => item.type === "hr")).toBe(false);
        expect(pages[0].items.some((item) => item.type === "hr")).toBe(false);
      }
    }
    // The divider sits right above "Next", so whenever "Next" opens page two the
    // divider that would have ended page one is dropped with it.
    expect(opened).toBeGreaterThan(0);
  });

  it("splits only a block taller than a whole page", () => {
    const giant = `- ${Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ")}`;
    const pages = paginateBlocks(parseMarkdown(giant), FS, CONTENT_W, PAD, PAGE_H, LH, 0, 0, 0);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0].items.length).toBe((PAGE_H - 2 * PAD) / (FS * LH));
  });

  it("matches measureBlocks for a single page", () => {
    const blocks = parseMarkdown(resume(3));
    const pages = paginateBlocks(blocks, FS, CONTENT_W, PAD, 1000, LH, 18, 10, 16);
    expect(pages).toHaveLength(1);
    const [page] = pages;
    const measured = measureBlocks(blocks, FS, CONTENT_W, LH, 18, 10, 16);
    // The final block's mb is trailing space, not content.
    const trailing = blocks[blocks.length - 1].mb * (FS / FS_MAX_DEFAULT);
    expect(page.contentBottom - PAD).toBeCloseTo(measured - trailing, 6);
  });

  it("shrinks every gap in proportion with the font", () => {
    // Short lines on a wide page never wrap, and every line under a title sits
    // beside it at both sizes, so halving the font halves the text height; the
    // gaps must halve with it. Only the 1px divider rule stays fixed.
    const blocks = parseMarkdown(resume(3));
    const rules = blocks.filter((block) => block.type === "hr").length;
    const wide = 1000;
    const full = measureBlocks(blocks, FS_MAX_DEFAULT, wide, LH, 18, 10, 16);
    const half = measureBlocks(blocks, FS_MAX_DEFAULT / 2, wide, LH, 18, 10, 16);
    expect(half - rules).toBeCloseTo((full - rules) / 2, 6);
  });
});

describe("parseMarkdown", () => {
  it("lays out each role under a shared company heading as a title and its dates", () => {
    const blocks = parseMarkdown(`### Celsius Network
**UX Research Manager** · December 2021 — July 2022
- Ran **large** event queries
**UX Researcher** · May 2021 — July 2021
- Ran a survey`);
    expect(blocks.map((block) => block.text)).toEqual([
      "Celsius Network",
      "UX Research Manager",
      "December 2021 — July 2022",
      "• Ran large event queries",
      "UX Researcher",
      "May 2021 — July 2021",
      "• Ran a survey",
    ]);
    const [, firstRole, firstDates, , secondRole] = blocks;
    expect(firstRole.mt).toBeFalsy();
    expect(secondRole.mt).toBeTruthy();
    expect(keepsWithNext(firstRole)).toBe(true);
    expect(keepsWithNext(firstDates)).toBe(true);
  });
});

describe("keeping a job on one page", () => {
  const job = (title, count) => `### ${title}\n2020 – 2024\n${bullets(count, title)}`;
  const company = (count) =>
    `### Celsius Network\n**Manager** · 2021 – 2022\n${bullets(count, "Manager")}\n**Researcher** · 2020 – 2021\n${bullets(count, "Researcher")}`;
  const paginate = (md) => paginateBlocks(parseMarkdown(md), FS, CONTENT_W, PAD, PAGE_H, LH, 0, 0, 0);
  const pageOf = (pages, text) => pages.findIndex((page) => page.items.some((item) => item.text === text));
  const jobTexts = (title, count) => [title, ...Array.from({ length: count }, (_, i) => `• ${title} ${i + 1}`)];

  it("moves a whole job to the next page rather than splitting its bullets", () => {
    let moved = 0;
    for (let count = 1; count <= 12; count++) {
      const pages = paginate(`## Experience\n\n${job("Alpha", 6)}\n\n${job("Beta", count)}`);
      const pagesOfBeta = new Set(jobTexts("Beta", count).map((text) => pageOf(pages, text)));
      expect([...pagesOfBeta], `count=${count}`).toHaveLength(1);
      if (pageOf(pages, "Beta") === 1) moved += 1;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it("keeps every role of a company on the same page as the company", () => {
    const texts = ["Celsius Network", ...jobTexts("Manager", 3), ...jobTexts("Researcher", 3)];
    let moved = 0;
    for (let count = 1; count <= 12; count++) {
      const pages = paginate(`## Experience\n\n${job("Alpha", count)}\n\n${company(3)}`);
      const pagesOfCompany = new Set(texts.map((text) => pageOf(pages, text)));
      expect([...pagesOfCompany], `count=${count}`).toHaveLength(1);
      if (pageOf(pages, "Celsius Network") === 1) moved += 1;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it("splits a company taller than a page between roles, keeping each role whole", () => {
    const pages = paginate(`## Experience\n\n${job("Alpha", 3)}\n\n${company(8)}`);
    const managerPages = new Set(["Celsius Network", ...jobTexts("Manager", 8)].map((text) => pageOf(pages, text)));
    const researcherPages = new Set(jobTexts("Researcher", 8).map((text) => pageOf(pages, text)));
    expect([...managerPages]).toHaveLength(1);
    expect([...researcherPages]).toHaveLength(1);
    expect([...researcherPages][0]).toBeGreaterThan([...managerPages][0]);
  });
});

describe("dates beside the title", () => {
  const place = (md) => paginateBlocks(parseMarkdown(md), FS, CONTENT_W, PAD, 1000, LH, 0, 0, 0)[0].items;

  it("puts the line under a title on its first line, right-aligned at the title's size", () => {
    const [title, dates, bullet] = place("### Engineer\nAcme · 2020 – 2024\n\n- Did a thing");
    expect(title).toMatchObject({ text: "Engineer", x: PAD, y: PAD });
    expect(dates).toMatchObject({ text: "Acme · 2020 – 2024", y: PAD, fontSize: title.fontSize, fontWeight: "normal" });
    expect(dates.x + dates.width).toBe(PAD + CONTENT_W);
    // The dates' row is gone: the bullet follows the title line and the dates' own spacing.
    expect(bullet.y).toBeCloseTo(PAD + FS * LH + 6 * (FS / FS_MAX_DEFAULT), 6);
  });

  it("does the same for each role under a shared company heading", () => {
    const items = place("### Celsius Network\n**UX Researcher** · May 2021 — July 2021\n- Ran a survey");
    const role = items.find((item) => item.text === "UX Researcher");
    const dates = items.find((item) => item.text === "May 2021 — July 2021");
    expect(dates.y).toBe(role.y);
    expect(dates.x + dates.width).toBe(PAD + CONTENT_W);
  });

  it("keeps a line too wide to share the title on its own row", () => {
    const detail = "BS Computer Science · Graduated with honors and a minor in Mathematics";
    const items = place(`### State University\n${detail}\n\n- Thesis`);
    const title = items.find((item) => item.text === "State University");
    const below = items.find((item) => item.text === detail);
    expect(below.y).toBeGreaterThan(title.y);
    expect(below.x).toBe(PAD);
  });

  it("wraps a long title in the room the dates leave", () => {
    const longTitle = "Lead ".repeat(14).trim();
    const items = place(`### ${longTitle}\n2020 – 2024\n\n- Did a thing`);
    const dates = items.find((item) => item.text === "2020 – 2024");
    const titleLines = items.filter((item) => item.fontWeight === "bold");
    expect(titleLines.length).toBe(2);
    expect(titleLines[0].x + titleLines[0].width).toBeLessThanOrEqual(dates.x - FS);
  });
});

describe("findPagedFit", () => {
  // A taller page than the breaking tests use, so one page holds a short resume
  // at the largest font and a 30-bullet one only at a tiny font.
  const options = { contentW: CONTENT_W, pad: PAD, pageH: 400, minFs: 4, maxFs: 14, minReadableFs: 8, sectionSpacing: 0, itemSpacing: 0, separatorSpacing: 0 };

  it("uses the largest font on one page when the text is short", () => {
    const fit = findPagedFit(parseMarkdown(resume(1)), { ...options, maxPages: 2 });
    expect(fit).toMatchObject({ fontSize: 14, pageCount: 1 });
  });

  it("spills onto a second page instead of shrinking below the readable floor", () => {
    const blocks = parseMarkdown(resume(30));
    const onePage = findPagedFit(blocks, { ...options, maxPages: 1 });
    const twoPages = findPagedFit(blocks, { ...options, maxPages: 2 });
    expect(onePage.pageCount).toBe(1);
    expect(onePage.fontSize).toBeLessThan(8);
    expect(twoPages.pageCount).toBe(2);
    expect(twoPages.fontSize).toBeGreaterThanOrEqual(8);
    expect(twoPages.fontSize).toBeGreaterThan(onePage.fontSize);
  });

  it("stays on one page while the text is still readable there", () => {
    const fit = findPagedFit(parseMarkdown(resume(12)), { ...options, maxPages: 2 });
    expect(fit.pageCount).toBe(1);
    expect(fit.fontSize).toBeGreaterThanOrEqual(8);
    expect(fit.fontSize).toBeLessThan(14);
  });

  it("caps line spacing on a multi-page fit at the default instead of filling page two", () => {
    const fit = findPagedFit(parseMarkdown(resume(30)), { ...options, maxPages: 2 });
    expect(fit.lineHeightMult).toBeLessThanOrEqual(1.5);
  });

  it("stops a multi-page font at its cap and keeps comfortable spacing", () => {
    const blocks = parseMarkdown(resume(30));
    const uncapped = findPagedFit(blocks, { ...options, maxPages: 2, multiPageMaxFs: 14 });
    const capped = findPagedFit(blocks, { ...options, maxPages: 2, multiPageMaxFs: 9 });
    expect(uncapped.fontSize).toBeGreaterThan(9);
    expect(capped).toMatchObject({ fontSize: 9, pageCount: 2 });
    expect(capped.lineHeightMult).toBeGreaterThanOrEqual(LH_COMFORT);
  });
});
