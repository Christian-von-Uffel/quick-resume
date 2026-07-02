import { PAGE_W } from "./constants";

// Print `page` (the resume A4 element) on its own as a full-bleed PDF. Every
// sibling is hidden and every ancestor's transform/overflow is neutralized so
// the browser's print pipeline sees only the page, scaled to fill A4. All DOM
// mutations are recorded and reverted in `restore`, which runs after printing.
// `exportName` seeds document.title, which browsers use as the default filename.
export function printResumePage(page, exportName) {
  if (!page) return;

  const hiddenEls = [];
  const ancestorSaved = [];
  let current = page;
  while (current.parentElement) {
    const parent = current.parentElement;
    Array.from(parent.children).forEach((sibling) => {
      if (sibling !== current) {
        hiddenEls.push({ el: sibling, prev: sibling.style.display });
        sibling.style.display = "none";
      }
    });
    if (parent !== document.body) {
      ancestorSaved.push({
        el: parent,
        overflow: parent.style.overflow,
        transform: parent.style.transform,
        position: parent.style.position,
        visibility: parent.style.visibility,
        background: parent.style.background,
      });
      parent.style.overflow = "visible";
      parent.style.transform = "none";
      parent.style.visibility = "visible";
      parent.style.background = "none";
    }
    current = parent;
  }

  const pageSaved = {
    position: page.style.position,
    top: page.style.top,
    left: page.style.left,
    transform: page.style.transform,
    transformOrigin: page.style.transformOrigin,
    boxShadow: page.style.boxShadow,
    background: page.style.background,
  };
  const printScale = 794 / PAGE_W;
  page.style.position = "fixed";
  page.style.top = "0";
  page.style.left = "0";
  page.style.transform = `scale(${printScale})`;
  page.style.transformOrigin = "top left";
  page.style.boxShadow = "none";
  page.style.background = "white";

  const guides = page.querySelectorAll("[data-margin-guide],[data-overflow]");
  guides.forEach((g) => (g.style.display = "none"));

  const style = document.createElement("style");
  style.textContent = `
    @page { size: A4; margin: 0; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body::before { display: none !important; }
  `;
  document.head.appendChild(style);

  const restore = () => {
    style.remove();
    guides.forEach((g) => (g.style.display = ""));
    Object.assign(page.style, pageSaved);
    ancestorSaved.forEach((s) => {
      s.el.style.overflow = s.overflow;
      s.el.style.transform = s.transform;
      s.el.style.position = s.position;
      s.el.style.visibility = s.visibility;
      s.el.style.background = s.background;
      s.el.style.display = s.display;
    });
    hiddenEls.forEach((h) => (h.el.style.display = h.prev));
    window.onafterprint = null;
  };

  const savedTitle = document.title;
  // Browsers use document.title as the default "Save as PDF" filename.
  document.title = exportName;

  const origRestore = restore;
  const restoreWithTitle = () => {
    origRestore();
    document.title = savedTitle;
  };
  window.onafterprint = restoreWithTitle;
  window.print();
}
