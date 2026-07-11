import { describe, it, expect } from "vitest";
import { importResume, needsMistralOcr, resolveImportMimeType } from "./importResume";

describe("needsMistralOcr", () => {
  it("routes Office and OpenDocument files through OCR", () => {
    expect(
      needsMistralOcr({
        name: "resume.docx",
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })
    ).toBe(true);
    expect(needsMistralOcr({ name: "resume.doc", type: "application/msword" })).toBe(true);
    expect(needsMistralOcr({ name: "resume.odt", type: "application/vnd.oasis.opendocument.text" })).toBe(true);
  });

  it("keeps PDFs and images on the native provider path", () => {
    expect(needsMistralOcr({ name: "resume.pdf", type: "application/pdf" })).toBe(false);
    expect(needsMistralOcr({ name: "resume.png", type: "image/png" })).toBe(false);
  });

  it("falls back to the extension when the browser reports no MIME type", () => {
    expect(needsMistralOcr({ name: "resume.docx", type: "" })).toBe(true);
    expect(needsMistralOcr({ name: "resume.pdf", type: "" })).toBe(false);
  });
});

describe("resolveImportMimeType", () => {
  it("prefers the browser-reported type", () => {
    expect(resolveImportMimeType({ name: "resume.docx", type: "application/pdf" })).toBe("application/pdf");
  });

  it("derives Office MIME types from the extension when the type is empty", () => {
    expect(resolveImportMimeType({ name: "My Resume.DOCX", type: "" })).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  it("defaults to octet-stream for unknown extensions", () => {
    expect(resolveImportMimeType({ name: "resume.xyz", type: "" })).toBe("application/octet-stream");
  });
});

describe("importResume", () => {
  it("asks about the uploaded file when no text is supplied", () => {
    const prompt = importResume();
    expect(prompt).toContain("the uploaded file");
    expect(prompt).not.toContain("<resume_text>");
  });

  it("embeds OCR-extracted text when supplied", () => {
    const prompt = importResume("# Jane Doe\nSenior Engineer");
    expect(prompt).toContain("<resume_text>\n# Jane Doe\nSenior Engineer\n</resume_text>");
    expect(prompt).toContain("the resume text below");
  });
});
