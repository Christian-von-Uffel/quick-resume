/* ── first-run onboarding ─────────────────────────────────────────────────
   Tracks whether a user has seen the first-run onboarding overlay.
   NULL  = not yet onboarded (a fresh signup should see the welcome flow).
   a timestamp = the user finished or skipped it; never show it again.

   Existing accounts (created before this shipped) are backfilled as
   already-onboarded so the intro only appears for genuinely new users.
   The fixed cutoff makes the backfill safe to re-run: it can never mark an
   account created after ship time. RLS: the existing "own profile" policy
   already covers the new column, so no policy change is needed. */

alter table public.profiles
  add column if not exists onboarding_completed_at timestamptz;

update public.profiles
  set onboarding_completed_at = now()
  where onboarding_completed_at is null
    and created_at < timestamptz '2026-07-16 04:55:22+00';
