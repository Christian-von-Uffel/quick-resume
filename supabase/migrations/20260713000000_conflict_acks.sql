/* ── conflict acknowledgments ─────────────────────────────────────────────
   "Keep both" confirmations from the position-review dialog. Each entry is a
   content-signature pair key (company + title + dates of both roles), not a
   row id, so it survives the delete-and-reinsert work_history sync and goes
   stale automatically when either role's identity or dates change. */

alter table public.profiles
  add column conflict_acks text[] not null default '{}';
