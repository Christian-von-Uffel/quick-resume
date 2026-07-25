# Auth

Passwordless, email-only. There are no passwords anywhere in the product: no
password field, no "set a password later", no reset flow. `/reset-password` and
`/forgot-password` redirect to `/login`.

## The flow

Signing up and signing in are the same act — type an email, get a one-time
link, click it, you're in — with exactly one difference:

| | `/signup` | `/login` |
| --- | --- | --- |
| `create_user` | `true` | `false` |
| unknown email | creates the account | "We couldn't find an account for that email." |

`create_user: false` on login is the point of having two routes: a typo on the
sign-in form must not quietly mint a second, empty account that the person then
can't find their work in.

Clicking the emailed link confirms the address *and* starts the session in one
step. There is no separate confirmation screen.

## Why the link points at our own page

The email links to `https://www.1resume.app/login?token_hash=…&type=magiclink`
(or `type=signup`), **not** to Supabase's `{{ .ConfirmationURL }}`. The page's
GET does nothing; the token is verified by an explicit POST
(`supabase.auth.verifyOtp`) from the browser.

This is not a style preference. Corporate mail security — Microsoft Defender
Safe Links and every product like it — prefetches every GET link in an incoming
message. Against `ConfirmationURL` that prefetch *spends* the single-use token,
and the human clicks a dead link. When the link is the only credential, that is
a total sign-in outage for everyone behind such a scanner.

A side benefit: no redirect-URL allowlist to keep in sync with deploy previews,
because nothing relies on `emailRedirectTo`.

`scripts/configure-supabase-auth.mjs` refuses to upload a template that still
contains `{{ .ConfirmationURL }}`.

## Staying signed in

The session is the default and the only mode — there is no "remember me".

- Access token: 1 hour. Refresh token: rotating, with a 10s reuse grace window
  so two tabs racing a refresh don't sign the user out.
- Both live in cookies written by `@supabase/ssr` with a 400-day max-age (the
  browser ceiling). `middleware.js` runs on every `/app` request and spends an
  expired access token on a refresh, writing the rotated pair back — so an
  actively used device is never logged out.
- Remembered is **per device**. Each device signs in with its own link and
  keeps its own session; nothing is synced. Signing out, clearing storage, or a
  new device means one more email.

## Carrying intent across the inbox hop

Sign-in now costs an email round-trip, and links get opened somewhere else —
the phone, hours later. Anything held only in the requesting tab is gone by
then, so `src/lib/authIntent.js` carries it two ways:

1. **On the auth user's metadata**, written at link-request time via
   `signInWithOtp`'s `data` option. This is the copy that survives the hop to
   another device. Supabase only applies it when the account is created, which
   is the case that actually breaks otherwise.
2. **In `sessionStorage`**, as the same-device fallback for a returning user.

Both are re-validated through `safeNextPath` on the way out — user metadata is
user-writable, so it is never trusted as a redirect target.

Today the intent carries the destination: the middleware appends `?next=` when
it bounces a signed-out request, so a deep link into `/app/lab`, or a
`?checkout=success` return from Stripe, still lands correctly after the email
hop.

## One-time setup

Sign-in latency is now email-delivery latency, and Supabase's built-in mailer
allows only a couple of messages an hour. Custom SMTP is not optional.

1. **Resend**: add and verify `1resume.app`
   ([resend.com/domains](https://resend.com/domains)), then create an API key
   with sending access. Leave click/open tracking **off** — link rewriting
   would replace the token-hash URL and break sign-in.
2. Put these in `.env.local` (see `.env.example`):
   ```
   RESEND_API_KEY=
   AUTH_EMAIL_FROM=no-reply@1resume.app
   AUTH_EMAIL_FROM_NAME=1Resume
   SITE_URL=https://www.1resume.app
   SUPABASE_ACCESS_TOKEN=
   ```
   `SUPABASE_ACCESS_TOKEN` is an account-wide personal access token from
   [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens).
   It is for the script only — never set it on Vercel. None of these are read
   by the app at runtime.
3. Apply it:
   ```bash
   pnpm auth:configure
   ```
   `--dry-run` prints what it would send; `--skip-resend-check` skips the
   pre-flight that verifies the Resend key and domain.

### Without a personal access token

The token exists only so the script can drive the Management API — it is not
part of auth, and the app never reads it. If SMTP is already configured by hand
in the dashboard, the one remaining **mandatory** step is the templates:

```bash
node scripts/configure-supabase-auth.mjs --print-templates
```

That needs no credentials at all. Paste each block into
**Authentication → Emails → Templates**, into the *Magic Link* and *Confirm
signup* tabs, and check **Authentication → URL Configuration → Site URL** is
`https://www.1resume.app` — `{{ .SiteURL }}` is the base of every emailed link.

Default templates are not merely worse, they are broken here: they link to
`{{ .ConfirmationURL }}`, which verifies at Supabase on a GET and bounces to
the Site URL carrying a `?code=` that the marketing page ignores. Sign-in
fails silently.

Optional, under **Authentication → Rate Limits** and **Sessions**: raise the
email limit above the 30/hour default, and confirm 1h JWT expiry with refresh
token rotation on.

The script is idempotent — run it again after editing a template. It sets:

| Setting | Value | Why |
| --- | --- | --- |
| `smtp_*` | `smtp.resend.com:465`, user `resend` | Resend as the mailer |
| `rate_limit_email_sent` | 1000/hour | the 30/hour default is one busy afternoon away from blocking sign-ins |
| `smtp_max_frequency` | 20s | per-address cooldown; the UI's resend button waits 30s |
| `mailer_otp_exp` | 3600 | link lifetime |
| `jwt_exp` | 3600 | access-token lifetime |
| `refresh_token_rotation_enabled` | true | |
| `security_refresh_token_reuse_interval` | 10 | grace window for racing tabs |
| `mailer_autoconfirm` | false | the link is what confirms the address |
| `site_url` | `SITE_URL` | `{{ .SiteURL }}` is the base of every emailed link |
| magic-link + confirmation templates | `supabase/templates/*.html` | the token-hash links |

## Known edges

- **Supabase has no toggle that disables password sign-in** while keeping email
  OTP; both live behind the same `external_email_enabled` flag. Accounts that
  predate this change still have a password hash, and the GoTrue API would
  still accept it. Nothing in the product offers it, and no UI can reach it —
  but it is a hash on the row, not a removed capability. Clearing them is a
  separate decision.
- **Existing accounts need no migration.** They already exist, so `/login`'s
  `create_user: false` finds them and mails a link like anyone else.
- **`{{ .SiteURL }}` is a single value**, so emailed links always point at
  production. To test the full loop locally, either run
  `SITE_URL=http://localhost:5222 pnpm auth:configure` and put it back
  afterwards, or copy the `token_hash` out of the production link and paste it
  into `http://localhost:5222/login?token_hash=…&type=magiclink`.

## The trade-off

The inbox is now the single factor. Whoever controls the email controls the
account, and there is no second factor to fall back on. That is the deal
passwordless makes; it is worth naming rather than discovering.
