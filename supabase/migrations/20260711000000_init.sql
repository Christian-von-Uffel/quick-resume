-- Quick Resume SaaS schema, v1.
--
-- Every table is per-user and protected by row-level security: browser
-- clients use the anon key and can only touch their own rows; server API
-- routes may use the service-role key, which bypasses RLS.
--
-- Date fields on work history mirror the client model exactly (two-digit
-- month strings, four-digit year strings, "" for unknown, end_year
-- "present" for current roles) so the app's existing normalizers and
-- timeline logic keep working unchanged. CHECK constraints keep garbage out.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

/* ── profiles: one row per user, created automatically on signup ──────── */

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  headline text not null default '',
  location text not null default '',
  email text not null default '',
  phone text not null default '',
  linkedin text not null default '',
  github text not null default '',
  website text not null default '',
  visible_contact_fields text[] not null default array['location', 'email', 'linkedin', 'github', 'website'],
  -- Which resume the editor has open; nulled if that resume is deleted.
  selected_resume_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Create the profile row the moment a user signs up, seeded with their
-- auth email so the contact line has a starting value.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, coalesce(new.email, ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

/* ── education ────────────────────────────────────────────────────────── */

create table public.education (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  school text not null default '',
  degree text not null default '',
  year text not null default '' check (year = '' or year ~ '^\d{4}$'),
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index education_user_id_idx on public.education (user_id);

create trigger education_set_updated_at
  before update on public.education
  for each row execute function public.set_updated_at();

/* ── work_history: the master list of roles, reused across resumes ────── */

create table public.work_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  position text not null default '',
  company text not null default '',
  start_month text not null default '' check (start_month = '' or start_month ~ '^(0[1-9]|1[0-2])$'),
  start_year text not null default '' check (start_year = '' or start_year ~ '^\d{4}$'),
  end_month text not null default '' check (end_month = '' or end_month ~ '^(0[1-9]|1[0-2])$'),
  end_year text not null default '' check (end_year in ('', 'present') or end_year ~ '^\d{4}$'),
  -- Accomplishment bullets separated by newlines, as in the client model.
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index work_history_user_id_idx on public.work_history (user_id);

create trigger work_history_set_updated_at
  before update on public.work_history
  for each row execute function public.set_updated_at();

/* ── resumes ──────────────────────────────────────────────────────────── */

create table public.resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '',
  company text not null default '',
  job_title text not null default '',
  -- The resume markdown the editor renders and the PDF export prints.
  content text not null default '',
  -- Point-in-time copy of the roles tailored into THIS resume (client
  -- workHistory item shape). Deliberately a snapshot, not references:
  -- editing the master work_history must not rewrite already-built resumes.
  work_history_snapshot jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index resumes_user_id_idx on public.resumes (user_id);

create trigger resumes_set_updated_at
  before update on public.resumes
  for each row execute function public.set_updated_at();

alter table public.profiles
  add constraint profiles_selected_resume_id_fkey
  foreign key (selected_resume_id) references public.resumes (id) on delete set null;

/* ── job_descriptions: shared by generation and missing-experience review ─ */

create table public.job_descriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null default 'text' check (source in ('text', 'url')),
  -- The scraped page when source = 'url'.
  source_url text not null default '',
  -- Cleaned markdown actually inserted into prompts.
  content text not null,
  created_at timestamptz not null default now()
);

create index job_descriptions_user_id_idx on public.job_descriptions (user_id);

/* ── resume_generations: one row per generation run ───────────────────── */

create table public.resume_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_description_id uuid not null references public.job_descriptions (id) on delete cascade,
  -- The resume the run produced. The resume row keeps evolving as the user
  -- edits; output_markdown below preserves what the model actually returned.
  resume_id uuid references public.resumes (id) on delete set null,
  instructions text not null default '',
  provider text not null default '',
  model text not null default '',
  status text not null default 'succeeded' check (status in ('succeeded', 'failed')),
  error text not null default '',
  -- Intermediate step outputs (job analysis, selected evidence) for
  -- debugging bad generations and product analytics.
  analysis jsonb,
  output_markdown text not null default '',
  created_at timestamptz not null default now()
);

create index resume_generations_user_id_idx on public.resume_generations (user_id);
create index resume_generations_job_description_id_idx on public.resume_generations (job_description_id);

/* ── missing_experience_reviews: one row per review run ───────────────── */

create table public.missing_experience_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_description_id uuid not null references public.job_descriptions (id) on delete cascade,
  -- Gap questions as returned by the model (kind, question, likelyRoles, ...).
  -- Accepted answers are merged into work_history rows, not stored here.
  questions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index missing_experience_reviews_user_id_idx on public.missing_experience_reviews (user_id);
create index missing_experience_reviews_job_description_id_idx on public.missing_experience_reviews (job_description_id);

/* ── row-level security: users only ever see their own rows ───────────── */

alter table public.profiles enable row level security;
alter table public.education enable row level security;
alter table public.work_history enable row level security;
alter table public.resumes enable row level security;
alter table public.job_descriptions enable row level security;
alter table public.resume_generations enable row level security;
alter table public.missing_experience_reviews enable row level security;

create policy "own profile" on public.profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own education" on public.education
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own work history" on public.work_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own resumes" on public.resumes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own job descriptions" on public.job_descriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own generations" on public.resume_generations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own reviews" on public.missing_experience_reviews
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
