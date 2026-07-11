import { CONTACT_FIELDS } from "./constants";
import { sortEducation, normalizeEducationItem } from "./resumeModel";

// Formats the chat providers can't ingest natively; imports of these are
// converted to markdown by Mistral OCR before extraction. PDF and images skip
// OCR and go straight to the selected provider, which reads them natively.
const OCR_ONLY_MIME_TYPES_BY_EXTENSION = {
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  odp: "application/vnd.oasis.opendocument.presentation",
};

const OCR_ONLY_MIME_TYPES = new Set(Object.values(OCR_ONLY_MIME_TYPES_BY_EXTENSION));

// Browsers report an empty MIME type for files whose format the platform
// doesn't recognize (common for Office files on machines without Office), so
// fall back to the extension before giving up.
export function resolveImportMimeType(file) {
  if (file.type) return file.type;
  const extension = /\.([a-z0-9]+)$/i.exec(file.name ?? "")?.[1]?.toLowerCase();
  return OCR_ONLY_MIME_TYPES_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export function needsMistralOcr(file) {
  if (!file) return false;
  return OCR_ONLY_MIME_TYPES.has(resolveImportMimeType(file));
}

export function importResume(resumeText) {
  const source = resumeText
    ? "the resume text below, extracted from the uploaded file"
    : "the uploaded file";
  const resumeTextBlock = resumeText
    ? `\n\n<resume_text>\n${resumeText}\n</resume_text>`
    : "";

  return `<task>
Extract resume data from ${source}.
</task>

<instructions>
Return only valid JSON. Do not wrap it in markdown.
Use empty strings for unknown profile fields.
Use one workHistory item per role. Put accomplishment bullets in description separated by newline characters.
Normalize all dates into numeric fields:
- startMonth/endMonth: two-digit month strings from "01" to "12", or "" when only a year is known
- startYear/endYear: four-digit year strings like "2020", or "" when unknown
- endYear: use "present" for current roles
Accept any visible resume date format (January, Jan, 01, 03/2020, 2020-01, etc.) and convert it into this schema.
</instructions>

<schema>
{
  "profile": {
    "name": "",
    "headline": "",
    "location": "",
    "email": "",
    "phone": "",
    "linkedin": "",
    "github": "",
    "website": ""
  },
  "workHistory": [
    {
      "position": "",
      "company": "",
      "startMonth": "03",
      "startYear": "2020",
      "endMonth": "",
      "endYear": "present",
      "description": ""
    }
  ]
}
</schema>${resumeTextBlock}`;
}

export function coerceImportedProfile(profile) {
  if (!profile || typeof profile !== "object") return {};

  const acc = CONTACT_FIELDS.concat([["name"], ["headline"]]).reduce((res, [field]) => {
    if (typeof profile[field] === "string") res[field] = profile[field].trim();
    return res;
  }, {});

  if (Array.isArray(profile.education)) {
    acc.education = sortEducation(profile.education.map(normalizeEducationItem));
  } else {
    acc.education = [];
  }

  return acc;
}
