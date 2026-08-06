-- Prompts are prompts: the body we sent (or the template we are testing),
-- nothing else. key/version/name/source were a catalog that never held the
-- actual text. lab_prompts was a second place to put the same thing.
--
-- Every distinct prompt body gets one row. Product runs point at it:
-- clarity_reviews, experience_expansions, job_gap_analyses, resume_generations.
-- questions / suggestions / llm_calls keep their prompt_id too so per-call
-- attribution still works.

drop table if exists public.lab_prompts;

alter table public.questions drop constraint if exists questions_prompt_id_fkey;
alter table public.suggestions drop constraint if exists suggestions_prompt_id_fkey;
alter table public.llm_calls drop constraint if exists llm_calls_prompt_id_fkey;

update public.questions set prompt_id = null where prompt_id is not null;
update public.suggestions set prompt_id = null where prompt_id is not null;
update public.llm_calls set prompt_id = null where prompt_id is not null;

drop table if exists public.prompts;

create table public.prompts (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  created_at timestamptz not null default now()
);

-- Same body → same row. md5 keeps the unique index small; equality still
-- compares the full text on conflict.
create unique index prompts_body_md5_uidx on public.prompts (md5(prompt));

create index prompts_created_idx on public.prompts (created_at desc);

alter table public.prompts enable row level security;

drop policy if exists "prompts are readable" on public.prompts;
create policy "prompts are readable" on public.prompts
  for select to authenticated using (true);

-- Find-or-insert by exact body. Used by /api/llm and the lab. Security
-- definer so inserts do not need a wide INSERT policy on the table.
create or replace function public.ensure_prompt(p_prompt text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  body text := btrim(coalesce(p_prompt, ''));
  found_id uuid;
begin
  if body = '' then
    return null;
  end if;

  select id into found_id from public.prompts where prompt = body limit 1;
  if found_id is not null then
    return found_id;
  end if;

  begin
    insert into public.prompts (prompt) values (body) returning id into found_id;
    return found_id;
  exception when unique_violation then
    select id into found_id from public.prompts where prompt = body limit 1;
    return found_id;
  end;
end;
$$;

revoke all on function public.ensure_prompt(text) from public;
grant execute on function public.ensure_prompt(text) to authenticated;
grant execute on function public.ensure_prompt(text) to service_role;

alter table public.questions
  add constraint questions_prompt_id_fkey
  foreign key (prompt_id) references public.prompts (id);

alter table public.suggestions
  add constraint suggestions_prompt_id_fkey
  foreign key (prompt_id) references public.prompts (id);

alter table public.llm_calls
  add constraint llm_calls_prompt_id_fkey
  foreign key (prompt_id) references public.prompts (id);

alter table public.clarity_reviews
  add column if not exists prompt_id uuid references public.prompts (id);

alter table public.experience_expansions
  add column if not exists prompt_id uuid references public.prompts (id);

alter table public.job_gap_analyses
  add column if not exists prompt_id uuid references public.prompts (id);

alter table public.resume_generations
  add column if not exists prompt_id uuid references public.prompts (id);

create index if not exists clarity_reviews_prompt_idx on public.clarity_reviews (prompt_id);
create index if not exists experience_expansions_prompt_idx on public.experience_expansions (prompt_id);
create index if not exists job_gap_analyses_prompt_idx on public.job_gap_analyses (prompt_id);
create index if not exists resume_generations_prompt_idx on public.resume_generations (prompt_id);
