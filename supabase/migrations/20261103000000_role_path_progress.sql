/* ── per-role happy-path progress ─────────────────────────────────────────
   When each role finished (or skipped) the guided "Polish wording" and
   "Interview me" passes, so the Next step bar knows which role is next on
   any device. Nullable: an untouched role has neither. Carried through the
   delete-and-reinsert work_history sync like every other column. */

alter table public.work_history
  add column if not exists polished_at timestamptz,
  add column if not exists interviewed_at timestamptz;
