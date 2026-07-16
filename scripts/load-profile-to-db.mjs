// One-time loader: pushes a Quick Resume export JSON into Supabase.
//
// Maps the browser export (localStorage shape) into the DB tables:
//   profile          -> public.profiles   (upsert on user_id)
//   profile.education-> public.education   (replace all rows for the user)
//   workHistory      -> public.work_history(replace all rows for the user)
//
// Usage:
//   node scripts/load-profile-to-db.mjs [path/to/export.json] [--email=you@x.com] [--with-resumes]
//
// With no path, the newest ~/Downloads/quick-resume-export-*.json is used.
// Reads SUPABASE_URL and SUPABASE_SECRET_KEY from .env.local. The secret key
// bypasses row-level security, so this must only ever run locally.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const ROOT = process.cwd();

function parseEnvFile(filePath) {
  const env = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function parseArgs(argv) {
  const args = { file: null, email: null, withResumes: false };
  for (const raw of argv) {
    if (raw === "--with-resumes") args.withResumes = true;
    else if (raw.startsWith("--email=")) args.email = raw.slice("--email=".length);
    else if (!raw.startsWith("--")) args.file = raw;
  }
  return args;
}

function findLatestExport() {
  const dir = path.join(os.homedir(), "Downloads");
  const matches = fs
    .readdirSync(dir)
    .filter((name) => /^quick-resume-export-.*\.json$/.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (matches.length === 0) {
    throw new Error(`No quick-resume-export-*.json files found in ${dir}`);
  }
  return path.join(dir, matches[0].name);
}

// The DB has CHECK constraints; coerce anything that would violate them to "".
const asText = (value) => (value == null ? "" : String(value));
const asYear = (value) => (/^\d{4}$/.test(asText(value)) ? asText(value) : "");
const asMonth = (value) => (/^(0[1-9]|1[0-2])$/.test(asText(value)) ? asText(value) : "");
const asEndYear = (value) => {
  const text = asText(value);
  return text === "present" || /^\d{4}$/.test(text) ? text : "";
};
const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(asText(value));

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const envPath = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envPath)) {
    throw new Error(`Cannot find .env.local at ${envPath}. Run this from the repo root.`);
  }
  const env = parseEnvFile(envPath);
  const supabaseUrl = env.SUPABASE_URL;
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !secretKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env.local.");
  }

  const exportPath = args.file ?? findLatestExport();
  const data = JSON.parse(fs.readFileSync(exportPath, "utf8"));

  const restBase = `${supabaseUrl}/rest/v1`;
  const authHeaders = { apikey: secretKey, Authorization: `Bearer ${secretKey}` };

  async function rest(method, pathAndQuery, body, prefer) {
    const response = await fetch(`${restBase}${pathAndQuery}`, {
      method,
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      throw new Error(`${method} ${pathAndQuery} failed (HTTP ${response.status}): ${detail}`);
    }
    return parsed;
  }

  async function resolveUser(email) {
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=1000`, {
      headers: authHeaders,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`Listing users failed (HTTP ${response.status}): ${JSON.stringify(payload)}`);
    }
    const users = Array.isArray(payload) ? payload : payload.users ?? [];
    if (users.length === 0) {
      throw new Error("No auth users exist yet. Sign up in the app first, then re-run.");
    }
    if (email) {
      const match = users.find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase());
      if (!match) {
        throw new Error(
          `No user with email ${email}. Existing: ${users.map((u) => u.email).join(", ")}`
        );
      }
      return match;
    }
    if (users.length > 1) {
      throw new Error(
        `Found ${users.length} users (${users
          .map((u) => u.email)
          .join(", ")}). Re-run with --email=<the account to load into>.`
      );
    }
    return users[0];
  }

  const user = await resolveUser(args.email);
  const userId = user.id;

  const profile = data.profile ?? {};
  const profileRow = {
    user_id: userId,
    name: asText(profile.name),
    headline: asText(profile.headline),
    location: asText(profile.location),
    email: asText(profile.email),
    phone: asText(profile.phone),
    linkedin: asText(profile.linkedin),
    github: asText(profile.github),
    website: asText(profile.website),
    visible_contact_fields: Array.isArray(profile.visibleContactFields)
      ? profile.visibleContactFields.map(asText)
      : ["location", "email", "linkedin", "github", "website"],
  };

  const educationRows = (Array.isArray(profile.education) ? profile.education : [])
    .map((item) => ({
      user_id: userId,
      school: asText(item.school),
      degree: asText(item.degree),
      year: asYear(item.year),
      description: asText(item.description),
    }))
    .filter((row) => row.school || row.degree || row.year || row.description);

  const workRows = (Array.isArray(data.workHistory) ? data.workHistory : [])
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

  console.log(`Loading into project ${supabaseUrl}`);
  console.log(`Target user: ${user.email} (${userId})`);
  console.log(`Source file: ${exportPath}`);

  await rest("POST", "/profiles?on_conflict=user_id", [profileRow], "resolution=merge-duplicates,return=minimal");
  console.log("profiles: upserted 1 row");

  await rest("DELETE", `/education?user_id=eq.${userId}`, null, "return=minimal");
  if (educationRows.length > 0) {
    await rest("POST", "/education", educationRows, "return=minimal");
  }
  console.log(`education: replaced with ${educationRows.length} row(s)`);

  await rest("DELETE", `/work_history?user_id=eq.${userId}`, null, "return=minimal");
  if (workRows.length > 0) {
    await rest("POST", "/work_history", workRows, "return=minimal");
  }
  console.log(`work_history: replaced with ${workRows.length} row(s)`);

  if (args.withResumes) {
    // Break the FK before clearing resumes, then restore the selection after.
    await rest("PATCH", `/profiles?user_id=eq.${userId}`, { selected_resume_id: null }, "return=minimal");
    await rest("DELETE", `/resumes?user_id=eq.${userId}`, null, "return=minimal");

    const idRemap = new Map();
    const resumeRows = (Array.isArray(data.resumes) ? data.resumes : []).map((item) => {
      const id = isUuid(item.id) ? item.id : randomUUID();
      idRemap.set(item.id, id);
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
    if (resumeRows.length > 0) {
      await rest("POST", "/resumes", resumeRows, "return=minimal");
    }
    console.log(`resumes: replaced with ${resumeRows.length} row(s)`);

    const selectedId = idRemap.get(data.selectedResumeId);
    if (selectedId) {
      await rest(
        "PATCH",
        `/profiles?user_id=eq.${userId}`,
        { selected_resume_id: selectedId },
        "return=minimal"
      );
      console.log(`profiles.selected_resume_id set to ${selectedId}`);
    }
  }

  console.log("Done.");
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exit(1);
});
