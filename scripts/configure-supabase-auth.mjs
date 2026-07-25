// Applies this repo's auth configuration to the Supabase project.
//
// The passwordless flow has three moving parts that do NOT live in the app
// bundle, and this script is the source of truth for all three:
//
//   1. Custom SMTP through Resend. Sign-in latency is now email-delivery
//      latency, and Supabase's built-in mailer is rate-limited to a couple of
//      messages an hour — unusable when the email IS the credential.
//   2. The two email templates, which must link to /login?token_hash=... and
//      not to Supabase's {{ .ConfirmationURL }}. See supabase/templates/.
//   3. Session shape: 1h access tokens, rotating refresh tokens, so a device
//      signs in once and stays signed in.
//
// Usage:
//   node scripts/configure-supabase-auth.mjs [--dry-run] [--skip-resend-check]
//
// Reads from the environment (or .env.local):
//   SUPABASE_ACCESS_TOKEN  personal access token, https://supabase.com/dashboard/account/tokens
//   RESEND_API_KEY         becomes the SMTP password
//   SUPABASE_PROJECT_REF   optional; defaults to the ref in SUPABASE_URL
//   AUTH_EMAIL_FROM        optional; defaults to no-reply@1resume.app
//   AUTH_EMAIL_FROM_NAME   optional; defaults to 1Resume
//   SITE_URL               optional; defaults to https://www.1resume.app
//
// The access token is account-wide, so this is a local-only script. It is
// idempotent: run it again after editing a template.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TEMPLATE_DIR = path.join(ROOT, "supabase", "templates");

/* ── env ─────────────────────────────────────────────────────────────────── */

function parseEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
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

const fileEnv = parseEnvFile(path.join(ROOT, ".env.local"));
const read = (name, fallback = "") =>
  process.env[name] || fileEnv[name] || fallback;

function required(name, hint) {
  const value = read(name);
  if (!value) {
    console.error(`Missing ${name}.${hint ? ` ${hint}` : ""}`);
    process.exit(1);
  }
  return value;
}

/* ── settings ────────────────────────────────────────────────────────────── */

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipResendCheck = args.has("--skip-resend-check");
// Prints the two templates ready to paste into the dashboard, for when SMTP
// was set up by hand and a personal access token isn't worth creating.
// Needs no credentials at all.
const printOnly = args.has("--print-templates");

// Only demanded by the paths that actually use them: the access token is for
// the Management API call, the Resend key only becomes the SMTP password when
// this script is the thing configuring SMTP.
const accessToken =
  printOnly || dryRun
    ? read("SUPABASE_ACCESS_TOKEN")
    : required(
        "SUPABASE_ACCESS_TOKEN",
        "Create one at https://supabase.com/dashboard/account/tokens — or run with --print-templates and paste them in by hand."
      );
const resendApiKey = printOnly
  ? ""
  : required(
      "RESEND_API_KEY",
      "Create one at https://resend.com/api-keys (needs sending access on your domain)."
    );

const supabaseUrl = read("SUPABASE_URL") || read("NEXT_PUBLIC_SUPABASE_URL");
const projectRef =
  read("SUPABASE_PROJECT_REF") ||
  supabaseUrl.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ||
  "";
if (!projectRef) {
  console.error(
    "Could not determine the project ref. Set SUPABASE_PROJECT_REF, or SUPABASE_URL."
  );
  process.exit(1);
}

const siteUrl = read("SITE_URL", "https://www.1resume.app").replace(/\/$/, "");
const fromEmail = read("AUTH_EMAIL_FROM", "no-reply@1resume.app");
const fromName = read("AUTH_EMAIL_FROM_NAME", "1Resume");

function template(name) {
  const file = path.join(TEMPLATE_DIR, name);
  if (!fs.existsSync(file)) {
    console.error(`Missing template ${path.relative(ROOT, file)}`);
    process.exit(1);
  }
  // The files carry a header comment explaining why they look the way they do;
  // that is for whoever opens the repo, not for every recipient's inbox. An
  // Outlook conditional (`<!--[if mso]>`) would be markup, so it survives.
  const html = fs
    .readFileSync(file, "utf8")
    .replace(/<!--(?!\[if)[\s\S]*?-->/g, "")
    .trim();

  // A template that still points at ConfirmationURL would hand the one-time
  // token to every mail scanner that prefetches links. Fail loudly instead.
  if (html.includes("{{ .ConfirmationURL }}")) {
    console.error(
      `${name} uses {{ .ConfirmationURL }}. Link to ${siteUrl}/login?token_hash={{ .TokenHash }}&type=... instead.`
    );
    process.exit(1);
  }
  if (!html.includes("{{ .TokenHash }}")) {
    console.error(`${name} has no {{ .TokenHash }} — nothing to verify.`);
    process.exit(1);
  }
  return html;
}

const config = {
  site_url: siteUrl,

  // Email is the only sign-in method. Confirmation stays ON: clicking the
  // emailed link is what confirms the address, and it happens in the same step
  // as signing in, so it costs the user nothing.
  external_email_enabled: true,
  mailer_autoconfirm: false,

  // Resend, over SMTP. Port 465 is implicit TLS, which Supabase's mailer
  // handles without STARTTLS negotiation.
  smtp_host: "smtp.resend.com",
  smtp_port: 465,
  smtp_user: "resend",
  smtp_pass: resendApiKey,
  smtp_admin_email: fromEmail,
  smtp_sender_name: fromName,
  // Seconds a single address must wait between links. Long enough to stop a
  // mash of the resend button, short enough that a real "it didn't arrive"
  // retry isn't punished. The UI's resend button is on a 30s cooldown.
  smtp_max_frequency: 20,
  // Project-wide ceiling. The default of 30/hour is a per-project cap that a
  // single busy afternoon would hit, and a blocked sign-in email is a blocked
  // sign-in.
  rate_limit_email_sent: 1000,

  // Link lifetime. An hour is generous enough to survive "I'll do it after
  // this meeting" without leaving a live credential in an inbox for a day.
  mailer_otp_exp: 3600,

  // Sessions: a short access token plus a rotating refresh token, both held in
  // the browser and swapped silently. Being remembered is the only mode, so
  // there is no inactivity timeout and no absolute session lifetime.
  jwt_exp: 3600,
  refresh_token_rotation_enabled: true,
  // Grace window for a rotated token, so two tabs racing a refresh don't log
  // the user out.
  security_refresh_token_reuse_interval: 10,

  mailer_subjects_magic_link: "Your 1Resume sign-in link",
  mailer_templates_magic_link_content: template("magic-link.html"),
  mailer_subjects_confirmation: "Confirm your email to start on 1Resume",
  mailer_templates_confirmation_content: template("confirm-signup.html"),
};

/* ── apply ───────────────────────────────────────────────────────────────── */

const redact = (value) =>
  typeof value === "string"
    ? `${value.slice(0, 3)}… (${value.length} chars)`
    : value;

async function checkResendKey() {
  const response = await fetch("https://api.resend.com/domains", {
    headers: { Authorization: `Bearer ${resendApiKey}` },
  });
  if (!response.ok) {
    console.error(
      `Resend rejected the API key (${response.status}). Supabase would fail to send every sign-in email.`
    );
    process.exit(1);
  }
  const { data = [] } = await response.json();
  const domain = fromEmail.split("@")[1];
  const match = data.find((entry) => entry.name === domain);
  if (!match) {
    console.error(
      `Resend has no domain "${domain}" — add and verify it before sending from ${fromEmail}.`
    );
    process.exit(1);
  }
  if (match.status !== "verified") {
    console.error(
      `Resend domain "${domain}" is "${match.status}", not verified. Finish the DNS records first.`
    );
    process.exit(1);
  }
  console.log(`Resend: ${domain} verified, key accepted.`);
}

function printTemplates() {
  const sections = [
    [
      "Magic Link",
      config.mailer_subjects_magic_link,
      config.mailer_templates_magic_link_content,
    ],
    [
      "Confirm signup",
      config.mailer_subjects_confirmation,
      config.mailer_templates_confirmation_content,
    ],
  ];

  console.log(
    "Paste these at https://supabase.com/dashboard/project/" +
      `${projectRef}/auth/templates\n` +
      `Site URL must be ${siteUrl} — the links below are built from it.\n`
  );

  for (const [tab, subject, html] of sections) {
    console.log(`${"=".repeat(70)}\n${tab} tab\n${"=".repeat(70)}`);
    console.log(`\nSubject heading:\n${subject}\n`);
    console.log(`Message body (HTML):\n${html}\n`);
  }
}

async function main() {
  if (printOnly) {
    printTemplates();
    return;
  }

  console.log(`Project    ${projectRef}`);
  console.log(`Site URL   ${siteUrl}`);
  console.log(`Sender     ${fromName} <${fromEmail}> via smtp.resend.com:465`);
  console.log(
    `Templates  magic-link.html (${config.mailer_templates_magic_link_content.length} bytes), ` +
      `confirm-signup.html (${config.mailer_templates_confirmation_content.length} bytes)`
  );

  if (!skipResendCheck) await checkResendKey();

  if (dryRun) {
    console.log("\n--dry-run: would PATCH /v1/projects/%s/config/auth", projectRef);
    for (const [key, value] of Object.entries(config)) {
      if (key.startsWith("mailer_templates_")) continue;
      console.log(`  ${key}: ${key === "smtp_pass" ? redact(value) : value}`);
    }
    return;
  }

  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/config/auth`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    }
  );

  const body = await response.text();
  if (!response.ok) {
    console.error(`\nSupabase rejected the config (${response.status}):`);
    console.error(body);
    process.exit(1);
  }

  const applied = JSON.parse(body);
  console.log("\nApplied. Effective settings:");
  for (const key of [
    "site_url",
    "smtp_host",
    "smtp_port",
    "smtp_admin_email",
    "smtp_sender_name",
    "smtp_max_frequency",
    "rate_limit_email_sent",
    "mailer_otp_exp",
    "mailer_autoconfirm",
    "jwt_exp",
    "refresh_token_rotation_enabled",
    "security_refresh_token_reuse_interval",
  ]) {
    console.log(`  ${key}: ${applied[key]}`);
  }

  const linkedTemplates = [
    ["magic link", applied.mailer_templates_magic_link_content],
    ["confirmation", applied.mailer_templates_confirmation_content],
  ];
  for (const [label, html] of linkedTemplates) {
    const ok = typeof html === "string" && html.includes("token_hash=");
    console.log(`  ${label} template: ${ok ? "token_hash link ✓" : "NOT the token_hash link ✗"}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
