import { CONTACT_FIELDS } from "./constants";
import { sortEducation, normalizeEducationItem } from "./resumeModel";

export function importResume() {
  return `<task>
Extract resume data from the uploaded file.
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
</schema>`;
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
