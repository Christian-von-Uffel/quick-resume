/* ── product metrics ──────────────────────────────────────────────────────
   Six tables for the six things we count, named after the thing they count:
   "resumes imported" is `select count(*) from resume_imports`. Nothing to
   filter, no slug to typo into a silent zero.

   Two shared tables hang off them, because three features ask the user
   questions and two of those also offer suggestions:
     questions   — one row per question a user was actually shown
     suggestions — one row per AI suggestion a user was actually shown
   Both foreign-key to `prompts`, which is what makes prompt performance
   comparable across versions.

   Ids from other tables: work_history and education ids are REGENERATED on
   every save (src/lib/syncProfile.js delete-and-reinserts them), so a role is
   identified by its text, never its id — the same reasoning as
   profiles.conflict_acks. Resume ids ARE stable, but are stored as bare uuids
   with no foreign key: that same delete-and-reinsert would cascade-delete the
   metrics rows on the user's next save. */

/* ── prompts ──────────────────────────────────────────────────────────────
   One row per shipped version of each prompt. Bump the version in
   src/lib/prompts.js and insert a row here when a prompt changes materially;
   old rows keep their events, which is what makes v1-vs-v2 comparable. */

create table public.prompts (
  id uuid primary key default gen_random_uuid(),
  -- Stable identifier used by the app, e.g. 'clarity_review'.
  key text not null,
  version integer not null default 1,
  -- Plain-English name, so this table reads without the code open.
  name text not null default '',
  -- Where the prompt is built: file#function.
  source text not null default '',
  created_at timestamptz not null default now(),
  unique (key, version)
);

/* ── the six metrics ──────────────────────────────────────────────────── */

-- Imports run unattended: no questions, no suggestions, results auto-apply.
create table public.resume_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Resolved MIME type of the uploaded file.
  file_type text not null default '',
  -- doc/docx/ppt/pptx/odt/odp go through Mistral OCR first; PDFs/images don't.
  used_ocr boolean not null default false,
  -- What the model returned vs what survived the merge into work history.
  -- They differ: empty rows are dropped and duplicates fold into existing roles.
  roles_found integer not null default 0,
  roles_added integer not null default 0,
  succeeded boolean not null default true,
  created_at timestamptz not null default now()
);

-- One review of one work-history role's bullets.
create table public.clarity_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The role reviewed, by text: work_history ids don't survive a save.
  position text not null default '',
  company text not null default '',
  created_at timestamptz not null default now()
);

-- One interview about one thin role. Runs up to 4 rounds of questions,
-- then composes bullets the user accepts or rejects.
create table public.experience_expansions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  position text not null default '',
  company text not null default '',
  -- How far the interview got before the user stopped (0 = quit immediately).
  rounds_completed integer not null default 0,
  created_at timestamptz not null default now()
);

-- One pass of a job description against the user's work history.
create table public.job_gap_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Gaps the model surfaced. Each becomes a row in `questions`.
  gaps_found integer not null default 0,
  -- Details the user actually saved into their work history at the end.
  details_saved integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.resume_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Bare uuid, never a foreign key: see the note at the top of this file.
  resume_id uuid,
  -- What the resume was aimed at, copied at generation time so the row still
  -- means something after the user renames or deletes the resume.
  job_title text not null default '',
  company text not null default '',
  succeeded boolean not null default true,
  created_at timestamptz not null default now()
);

-- Downloads happen entirely in the browser (window.print), so this is the one
-- metric the server cannot observe. Written by the client under RLS.
create table public.resume_downloads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  resume_id uuid,
  created_at timestamptz not null default now()
);

/* ── questions ────────────────────────────────────────────────────────────
   One row per question actually shown to the user — written after validation,
   so the denominator is what a person really saw, not what the model emitted.

   Exactly one parent id is set, enforced by the database, so a question can
   never point at a review that doesn't exist and the row itself tells you
   which flow it came from. Imports and generations don't ask questions and so
   have no column here.

   The funnel is timestamps, not a status column: answered_at set = answered,
   skipped_at set = explicitly skipped, both empty = shown and ignored. */

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  prompt_id uuid references public.prompts (id),

  clarity_review_id uuid references public.clarity_reviews (id) on delete cascade,
  job_gap_analysis_id uuid references public.job_gap_analyses (id) on delete cascade,
  experience_expansion_id uuid references public.experience_expansions (id) on delete cascade,

  question text not null default '',
  -- Tappable answers offered. Empty means it was a free-text question.
  options text[] not null default '{}',
  -- Which of `options` the user picked (multi-select can pick several).
  selected_options text[] not null default '{}',
  -- Free text typed instead of, or alongside, picking an option.
  answer_text text not null default '',
  -- Interview round this was asked in; always 1 outside expansions.
  round integer not null default 1,

  presented_at timestamptz not null default now(),
  answered_at timestamptz,
  skipped_at timestamptz,

  constraint questions_belong_to_one_flow check (
    num_nonnulls(clarity_review_id, job_gap_analysis_id, experience_expansion_id) = 1
  ),
  constraint questions_not_both_answered_and_skipped check (
    answered_at is null or skipped_at is null
  )
);

create index questions_user_idx on public.questions (user_id, presented_at desc);
create index questions_prompt_idx on public.questions (prompt_id);
create index questions_clarity_review_idx on public.questions (clarity_review_id);
create index questions_job_gap_analysis_idx on public.questions (job_gap_analysis_id);
create index questions_experience_expansion_idx on public.questions (experience_expansion_id);

/* ── suggestions ──────────────────────────────────────────────────────────
   One row per AI-written suggestion shown to the user, for the two flows that
   have a real accept/reject moment: clarity sentence rewrites and expansion
   bullets.

   Job gap analyses deliberately have no column here. Their elaborations are
   the model reformatting the user's own typed answer, applied straight to work
   history on Save with no accept/reject step (src/App.jsx handleSaveMissing-
   ExperienceDetails) — there is no decision to record. */

create table public.suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  prompt_id uuid references public.prompts (id),

  clarity_review_id uuid references public.clarity_reviews (id) on delete cascade,
  experience_expansion_id uuid references public.experience_expansions (id) on delete cascade,
  -- The question this suggestion was written from, when there was one.
  question_id uuid references public.questions (id) on delete set null,

  suggestion text not null default '',

  presented_at timestamptz not null default now(),
  accepted_at timestamptz,
  rejected_at timestamptz,

  constraint suggestions_belong_to_one_flow check (
    num_nonnulls(clarity_review_id, experience_expansion_id) = 1
  ),
  constraint suggestions_not_both_accepted_and_rejected check (
    accepted_at is null or rejected_at is null
  )
);

create index suggestions_user_idx on public.suggestions (user_id, presented_at desc);
create index suggestions_prompt_idx on public.suggestions (prompt_id);
create index suggestions_clarity_review_idx on public.suggestions (clarity_review_id);
create index suggestions_experience_expansion_idx on public.suggestions (experience_expansion_id);

/* ── llm_calls ────────────────────────────────────────────────────────────
   One row per provider call, written server-side with the service role. This
   is the unspoofable half: what a call cost is recorded where the browser
   can't reach it, so quotas can be enforced off it.

   Replaces the old `usage_events`, which was dropped from the database by hand.
   The drops below make this file correct whether or not it still exists (the
   committed billing migration creates it, the live database no longer has it). */

drop view if exists public.current_period_usage;
drop table if exists public.usage_events;

create table public.llm_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  prompt_id uuid references public.prompts (id),
  -- Which metric row this call was part of. Deliberately a bare uuid and not a
  -- foreign key: metering must never fail because a client-written row is
  -- missing, and it can point at any of the six tables.
  run_id uuid,
  provider text not null default '',
  model text not null default '',
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  -- Mistral OCR bills per page, not per token.
  pages integer not null default 0,
  duration_ms integer not null default 0,
  -- True for the hidden retry that asks a model to fix its own broken JSON.
  -- Logged against the original prompt, so a prompt's repair rate is queryable.
  was_repair boolean not null default false,
  succeeded boolean not null default true,
  created_at timestamptz not null default now()
);

create index llm_calls_user_idx on public.llm_calls (user_id, created_at desc);
create index llm_calls_prompt_idx on public.llm_calls (prompt_id);
create index llm_calls_run_idx on public.llm_calls (run_id);

/* ── row-level security ───────────────────────────────────────────────────
   Users read and write only their own rows. The six metric tables, questions,
   and suggestions are client-written: a user faking their own analytics gains
   nothing, and downloads can't be seen server-side at all. llm_calls is
   read-only to the client — only the API routes write it, with the service
   role, which bypasses RLS. */

alter table public.prompts enable row level security;
alter table public.resume_imports enable row level security;
alter table public.clarity_reviews enable row level security;
alter table public.experience_expansions enable row level security;
alter table public.job_gap_analyses enable row level security;
alter table public.resume_generations enable row level security;
alter table public.resume_downloads enable row level security;
alter table public.questions enable row level security;
alter table public.suggestions enable row level security;
alter table public.llm_calls enable row level security;

-- The app reads this to stamp prompt_id on the rows it writes.
create policy "prompts are readable" on public.prompts
  for select to authenticated using (true);

create policy "own resume imports" on public.resume_imports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own clarity reviews" on public.clarity_reviews
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own experience expansions" on public.experience_expansions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own job gap analyses" on public.job_gap_analyses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own resume generations" on public.resume_generations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own resume downloads" on public.resume_downloads
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own questions" on public.questions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own suggestions" on public.suggestions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own llm calls" on public.llm_calls
  for select using (auth.uid() = user_id);

/* ── the prompts we ship today ────────────────────────────────────────────
   Keys and sources verified against the code. `import_extract` covers both the
   OCR and the native-file variant: they differ only by an inlined text block. */

insert into public.prompts (key, version, name, source) values
  ('import_extract',        1, 'Pull a profile out of an uploaded resume',      'src/lib/importResume.js#importResume'),
  ('clarity_review',        1, 'Find hard-to-understand sentences in a role',   'src/lib/clarifyExperience.js#buildClarityReviewPrompt'),
  ('clarity_rewrite',       1, 'Rewrite one sentence from the user''s answer',  'src/lib/clarifyExperience.js#buildClaritySuggestionPrompt'),
  ('expansion_opening',     1, 'Opening interview questions about a role',      'src/lib/enrichExperience.js#buildOpeningQuestionsPrompt'),
  ('expansion_followup',    1, 'Follow-up interview questions about a role',    'src/lib/enrichExperience.js#buildFollowupQuestionsPrompt'),
  ('expansion_compose',     1, 'Turn interview answers into resume bullets',    'src/lib/enrichExperience.js#buildComposePrompt'),
  ('gap_review',            1, 'Find what a posting asks for that is unsaid',   'src/lib/reviewExperience.js#buildMissingExperienceReviewPrompt'),
  ('gap_elaboration',       1, 'Reword a gap answer as a work-history detail',  'src/lib/reviewExperience.js#formatExperienceElaboration'),
  ('generation_analysis',   1, 'Work out what a job posting is really asking',  'src/lib/generateResume.js#buildJobAnalysisPrompt'),
  ('generation_evidence',   1, 'Pick the strongest true evidence for the job',  'src/lib/generateResume.js#selectRankedEvidence'),
  ('generation_compose',    1, 'Write the tailored resume',                     'src/lib/generateResume.js#composeResume'),
  ('job_description_clean', 1, 'Pull the posting out of a scraped page',        'src/lib/generateResume.js#extractJobDescription');
