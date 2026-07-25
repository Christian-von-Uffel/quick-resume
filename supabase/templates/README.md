# Auth email templates

The two emails that are the entire sign-in experience. These files are the
source of truth: what's here is byte-for-byte what belongs in the dashboard,
with no comments or wrappers to strip.

| File | Dashboard tab | Subject | Sent when |
| --- | --- | --- | --- |
| `magic-link.html` | Magic Link | Your 1Resume sign-in link | an existing account requests a link |
| `confirm-signup.html` | Confirm signup | Confirm your email to start on 1Resume | an address with no account requests one from `/signup` |

The subjects live in `scripts/configure-supabase-auth.mjs`
(`mailer_subjects_*`), so changing one there and re-running keeps them in sync.

## Updating one

Edit the file, then apply it either way:

```bash
pnpm auth:configure                                        # needs SUPABASE_ACCESS_TOKEN
node scripts/configure-supabase-auth.mjs --print-templates  # needs nothing; paste by hand
```

Dashboard: **Authentication → Emails → Templates**. Editing there instead is
fine for a one-off, but the next `pnpm auth:configure` overwrites it — put the
change here too.

## Rules that aren't style preferences

**The link must be `{{ .SiteURL }}/login?token_hash={{ .TokenHash }}&type=…`**
(`type=magiclink` here, `type=signup` there). Never `{{ .ConfirmationURL }}`.
Corporate mail security prefetches every GET link in an incoming message;
against `ConfirmationURL` that prefetch spends the one-time token and the human
clicks a dead link. Our `/login` GET does nothing — the token is verified by an
explicit POST. `configure-supabase-auth.mjs` refuses to upload a template
containing `ConfirmationURL`, or one with no `TokenHash`.

**Write `&amp;` between the query parameters**, not a bare `&`. These are
parsed as HTML; a bare `&` before `type=` is a malformed entity.

**No external images, fonts, or stylesheets.** Inline styles and tables only —
this has to survive Outlook and every client that blocks remote content.

**`{{ .SiteURL }}` is a single project-wide value**, so the links always point
at production. To test locally, copy the `token_hash` out of a real email into
`http://localhost:5222/login?token_hash=…&type=magiclink`.

## Available variables

`{{ .SiteURL }}`, `{{ .TokenHash }}`, `{{ .Token }}` (6-digit OTP — unused
here), `{{ .Email }}`, `{{ .RedirectTo }}` (unused on purpose: relying on it
would mean maintaining a redirect allowlist), `{{ .Data }}` (the user's
metadata). Go template syntax, so conditionals work.

Templates for password recovery, invites, and email change are deliberately not
kept here — the product has no passwords, no invites, and no email-change flow.
Full reasoning: [`docs/auth.md`](../../docs/auth.md).
