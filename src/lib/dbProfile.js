// Maps between Supabase rows (snake_case) and the app's client model
// (camelCase) — the counterpart to scripts/load-profile-to-db.mjs. The App's
// existing normalizers handle defaults and sorting, so this only reshapes.

import { DEFAULT_VISIBLE_CONTACT_FIELDS } from "./constants";

// True when the profile row holds real user-entered info. A brand-new account
// only has the signup-trigger stub (user_id + email), which should NOT count as
// data worth loading over whatever the browser already has.
function profileHasContent(profile) {
  if (!profile) return false;
  return [
    profile.name,
    profile.headline,
    profile.location,
    profile.phone,
    profile.linkedin,
    profile.github,
    profile.website,
  ].some((value) => value && String(value).trim());
}

// Returns an app-state slice ({ profile, workHistory, resumes, selectedResumeId })
// or null when the account has no meaningful data yet.
export function mapDbRowsToAppState({ profile, education, workHistory, resumes } = {}) {
  const educationRows = Array.isArray(education) ? education : [];
  const workRows = Array.isArray(workHistory) ? workHistory : [];
  const resumeRows = Array.isArray(resumes) ? resumes : [];

  const hasData =
    profileHasContent(profile) ||
    educationRows.length > 0 ||
    workRows.length > 0 ||
    resumeRows.length > 0;
  if (!hasData) return null;

  return {
    profile: {
      name: profile?.name ?? "",
      headline: profile?.headline ?? "",
      location: profile?.location ?? "",
      email: profile?.email ?? "",
      phone: profile?.phone ?? "",
      linkedin: profile?.linkedin ?? "",
      github: profile?.github ?? "",
      website: profile?.website ?? "",
      visibleContactFields: Array.isArray(profile?.visible_contact_fields)
        ? profile.visible_contact_fields
        : undefined,
      // "Keep both" confirmations for concurrent/duplicate-looking positions,
      // so an acknowledged pair stays quiet across devices and sessions.
      conflictAcks: Array.isArray(profile?.conflict_acks) ? profile.conflict_acks : undefined,
      education: educationRows.map((row) => ({
        id: row.id,
        school: row.school ?? "",
        degree: row.degree ?? "",
        year: row.year ?? "",
        description: row.description ?? "",
      })),
    },
    workHistory: workRows.map((row) => ({
      id: row.id,
      position: row.position ?? "",
      company: row.company ?? "",
      startMonth: row.start_month ?? "",
      startYear: row.start_year ?? "",
      endMonth: row.end_month ?? "",
      endYear: row.end_year ?? "",
      description: row.description ?? "",
    })),
    resumes: resumeRows.map((row) => ({
      id: row.id,
      name: row.name ?? "",
      company: row.company ?? "",
      jobTitle: row.job_title ?? "",
      content: row.content ?? "",
      // An empty snapshot means the resume never stored tailored roles; leave it
      // undefined so the App parses roles from the markdown, as it did before.
      workHistory:
        Array.isArray(row.work_history_snapshot) && row.work_history_snapshot.length > 0
          ? row.work_history_snapshot
          : undefined,
      updatedAt: row.updated_at ?? "",
    })),
    selectedResumeId: profile?.selected_resume_id ?? undefined,
  };
}

// The DB has CHECK constraints on the date fields; coerce anything that would
// violate them to "" so a write never fails on stray data.
const asText = (value) => (value == null ? "" : String(value));
const asYear = (value) => (/^\d{4}$/.test(asText(value)) ? asText(value) : "");
const asMonth = (value) => (/^(0[1-9]|1[0-2])$/.test(asText(value)) ? asText(value) : "");
const asEndYear = (value) => {
  const text = asText(value);
  return text === "present" || /^\d{4}$/.test(text) ? text : "";
};
const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(asText(value));

function newUuid() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
      const rand = (Math.random() * 16) | 0;
      const value = char === "x" ? rand : (rand & 0x3) | 0x8;
      return value.toString(16);
    })
  );
}

// Turns the app state into ready-to-write DB rows. Education and work-history
// ids are left to the database (they're never referenced across saves); resume
// ids are kept when they're valid UUIDs so the selected-resume link survives.
export function buildDbWritePayload({ profile, workHistory, resumes, selectedResumeId } = {}, userId) {
  const p = profile ?? {};

  const profileRow = {
    user_id: userId,
    name: asText(p.name),
    headline: asText(p.headline),
    location: asText(p.location),
    email: asText(p.email),
    phone: asText(p.phone),
    linkedin: asText(p.linkedin),
    github: asText(p.github),
    website: asText(p.website),
    visible_contact_fields: Array.isArray(p.visibleContactFields)
      ? p.visibleContactFields.map(asText)
      : DEFAULT_VISIBLE_CONTACT_FIELDS,
    conflict_acks: Array.isArray(p.conflictAcks) ? p.conflictAcks.map(asText) : [],
  };

  const educationRows = (Array.isArray(p.education) ? p.education : [])
    .map((item) => ({
      user_id: userId,
      school: asText(item.school),
      degree: asText(item.degree),
      year: asYear(item.year),
      description: asText(item.description),
    }))
    .filter((row) => row.school || row.degree || row.year || row.description);

  const workRows = (Array.isArray(workHistory) ? workHistory : [])
    .map((item) => ({
      user_id: userId,
      position: asText(item.position),
      company: asText(item.company),
      start_month: asMonth(item.startMonth),
      start_year: asYear(item.startYear),
      end_month: asMonth(item.endMonth),
      end_year: asEndYear(item.endYear),
      description: asText(item.description),
    }))
    .filter((row) => row.position || row.company || row.description);

  let mappedSelectedId = null;
  const resumeRows = (Array.isArray(resumes) ? resumes : []).map((item) => {
    const id = isUuid(item.id) ? item.id : newUuid();
    if (item.id === selectedResumeId) mappedSelectedId = id;
    return {
      id,
      user_id: userId,
      name: asText(item.name),
      company: asText(item.company),
      job_title: asText(item.jobTitle),
      content: asText(item.content),
      work_history_snapshot: Array.isArray(item.workHistory) ? item.workHistory : [],
    };
  });
  if (mappedSelectedId == null && isUuid(selectedResumeId)) {
    mappedSelectedId = selectedResumeId;
  }

  return {
    profileRow,
    educationRows,
    workRows,
    resumeRows,
    selectedResumeId: mappedSelectedId,
  };
}
