import { PAGE_W, PAGE_H } from "./constants";

// 210mm at CSS 96dpi: the width of an A4 sheet in the browser's print pipeline.
const A4_WIDTH_PX = 794;

// Print every resume page (the `[data-pagefit-page]` elements inside `pagesEl`)
// as one A4-per-page PDF. The pages are cloned into a print-only root at the end
// of <body>; a print stylesheet hides everything else and places clone i at the
// top of sheet i (`top: i * 297mm`), scaled from the 620px layout width up to A4.
// The app's own DOM is never touched, and the clones are removed after printing.
// `exportName` seeds document.title, which browsers use as the default filename.
export function printResumePages(pagesEl, exportName) {
  if (!pagesEl) return;
  const pages = Array.from(pagesEl.querySelectorAll("[data-pagefit-page]"));
  if (!pages.length) return;

  const printScale = A4_WIDTH_PX / PAGE_W;

  const root = document.createElement("div");
  root.setAttribute("data-print-root", "");
  pages.forEach((page, index) => {
    const clone = page.cloneNode(true);
    clone.querySelectorAll("[data-margin-guide],[data-overflow]").forEach((guide) => guide.remove());
    clone.removeAttribute("class");
    clone.style.cssText = [
      "position:absolute",
      "left:0",
      `top:calc(${index} * 297mm)`,
      `width:${PAGE_W}px`,
      `height:${PAGE_H}px`,
      "overflow:hidden",
      "background:white",
      "box-shadow:none",
      "margin:0",
      `transform:scale(${printScale})`,
      "transform-origin:top left",
    ].join(";");
    root.appendChild(clone);
  });

  const style = document.createElement("style");
  style.textContent = `
    [data-print-root] { display: none; }
    @media print {
      @page { size: A4; margin: 0; }
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        height: auto !important;
        overflow: visible !important;
        background: white !important;
      }
      body > :not([data-print-root]) { display: none !important; }
      body::before { display: none !important; }
      [data-print-root] { display: block; position: absolute; top: 0; left: 0; }
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    }
  `;

  const savedTitle = document.title;
  const restore = () => {
    root.remove();
    style.remove();
    document.title = savedTitle;
    window.onafterprint = null;
  };

  document.head.appendChild(style);
  document.body.appendChild(root);
  // Browsers use document.title as the default "Save as PDF" filename.
  document.title = exportName;
  window.onafterprint = restore;
  window.print();
}
