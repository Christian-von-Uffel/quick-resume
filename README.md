# Always Fit Resume

A resume builder that auto-scales font size and line spacing to always fit on one A4 page.

Write your resume in markdown. The preview updates instantly — no DOM measurement, no flickering, no layout shifts.

Powered by [pretext](https://github.com/chenglou/pretext) for DOM-free text measurement.

## Features

- **Auto-fit**: Binary search finds the optimal font size and line height to fill exactly one page
- **Multi-page**: Auto-fit stops shrinking at a configurable minimum font size; when there's more content than fits one page at a readable size, it flows onto additional pages instead
- **Markdown editor**: Write your resume in simple markdown (`#`, `##`, `###`, `-`, `---`)
- **Live preview**: Scaled A4 page preview updates as you type
- **Fine-grained controls**: Font size, line spacing, page margin, section spacing, item spacing, separator spacing
- **PDF export**: Print to PDF with proper A4 sizing
- **Mobile friendly**: Tab-based layout on small screens
- **10 sample resumes**: Hit "Shuffle" to see different layouts

## Quick Start

```bash
git clone https://github.com/vladartym/always-fit-resume.git
cd always-fit-resume
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## How It Works

This project was inspired by [pretext](https://github.com/chenglou/pretext) by [Cheng Lou](https://github.com/chenglou) — a library that measures text layout without touching the DOM. Traditional web text measurement relies on `getBoundingClientRect()` and `offsetHeight`, which trigger expensive browser reflow — every call forces the browser to re-layout the entire document. Pretext sidesteps this entirely by using Canvas `measureText()` for font shaping in a one-time preparation step, then performing line breaking and height calculation with pure arithmetic. The result is roughly **500x faster** than interleaved DOM measurement.

This speed unlocks something that would otherwise be impractical: we can run a binary search over font sizes, measuring the full resume layout **hundreds of times per frame**, until we find the largest font size that fits on one page — all without a single layout reflow.

**Pass 1**: Binary search for the maximum font size at the tightest line spacing (1.15x).

**Pass 2**: With that font size locked, binary search for the maximum line height (up to 1.8x) that still fits.

The result is a resume that fills the page — add more content and the font shrinks, remove content and it grows.

**Multi-page flow**: Auto-fit won't shrink the font below the configurable **Min Font Size** floor. Once the content can no longer fit one page at that floor, the font holds steady and the layout paginates: lines are packed page by page (with keep-with-next rules so section headers and job titles aren't stranded at the bottom of a page), and the preview stacks each A4 page vertically.

### PDF Export

The export uses the browser's native `window.print()` — no server, no headless browser, no PDF library. Before printing, it clones each rendered page into an isolated print container, scales every clone to exactly fill an A4 sheet (794px wide), and separates them with `break-after: page` so each page prints on its own sheet. It injects a `@page { size: A4; margin: 0 }` style, hides the rest of the app during printing, and sets the document title to the person's name so the downloaded file is named nicely. After printing (or cancelling), the clones and styles are removed. The result is a pixel-perfect, multi-page A4 PDF that matches what you see in the preview.

## Markdown Format

```markdown
# Your Name
Your Title
City, State · email@example.com · github.com/you

---

A brief summary about yourself.

## EXPERIENCE

### Job Title — Company
2020 — Present
- Accomplishment one
- Accomplishment two

## EDUCATION

### Degree — University
Details about your education

## SKILLS

Skill 1 · Skill 2 · Skill 3
```

## Tech Stack

- [React](https://react.dev)
- [pretext](https://github.com/chenglou/pretext) — DOM-free text measurement
- [Tailwind CSS](https://tailwindcss.com)
- [Vite](https://vite.dev)

## License

MIT
