-- Trial usage limits: make plans.limits mean something.
--
-- The limits column has existed since the billing migration, documented as
-- "enforced by the API routes" — but nothing ever read it, and the table those
-- keys were written against (usage_events + current_period_usage) was dropped
-- by the product-metrics migration. So the config pointed at nothing and every
-- trial was effectively unlimited.
--
-- llm_calls is the enforcement ledger: it is written server-side with the
-- service role, so a browser cannot forge or delete a row. What it lacked was
-- any notion of WHICH product action a call belonged to — prompts are keyless
-- ("the text is the identity"), so the purpose cannot be derived from
-- prompt_id. This adds that label.
--
-- Trust boundary, stated plainly: `feature` is declared by the client, the same
-- way was_repair already is. It makes the per-feature counts right for honest
-- clients and gives users an accurate "7 of 10 used". It is NOT the security
-- boundary — a forged label could dodge the generation count. The hard ceiling
-- is tokens_per_month / trial_tokens plus burst_per_minute, which are summed
-- over every call regardless of label and cannot be relabelled away.

/* ── which product action each call belongs to ─────────────────────────── */

alter table public.llm_calls
  add column if not exists feature text not null default '';

comment on column public.llm_calls.feature is
  'Product action this call served: resume_generation, clarity_review, '
  'job_gap_review, resume_import, experience_expansion, job_scrape, lab. '
  'Client-declared and used for per-feature quotas and usage display; the '
  'unspoofable ceiling is the token and burst backstop, not this label.';

-- Quota reads are always (this user, this feature, since this timestamp).
create index if not exists llm_calls_user_feature_created_idx
  on public.llm_calls (user_id, feature, created_at desc);

/* ── the limits themselves ─────────────────────────────────────────────────
   Kept in data so a number can change without a deploy. A key that is absent
   or null means unlimited, so any single limit can be lifted with one update.

   trial_* applies while subscriptions.status = 'trialing'; the _per_month keys
   apply to an active paid subscription.

   Sizing note, from the only data we have (37 calls, ~3.4k tokens each): a
   resume generation is 3 calls / ~10k tokens, so a full 10-generation trial is
   ~100k tokens — cents on Gemini Flash. trial_tokens is set to 2M, ~20x an
   honest trial, because its job is to cap a forged-label abuser, not to
   constrain a real user. */

update public.plans
set limits = limits || jsonb_build_object(
  'trial_resume_generations', 10,
  'trial_tokens', 2000000
)
where id = 'pro';

/* ── usage_snapshot: one round trip, everything a quota decision needs ───
   Server-only (service_role): the API routes call this with the admin client
   before spending money with a provider.

   Runs, not calls, are the user-facing unit — one resume generation is three
   provider calls sharing a run_id. Calls that arrive with no run_id are each
   counted as their own run, so omitting runId can only cost the caller more
   than sending it. Only succeeded calls count: a run that failed on our side
   or the provider's should not consume someone's allowance. */

create or replace function public.usage_snapshot(
  p_user_id uuid,
  p_feature text,
  p_window_start timestamptz,
  p_run_id uuid default null,
  p_burst_seconds integer default 60
)
returns table (
  feature_runs integer,
  window_tokens bigint,
  burst_calls integer,
  run_in_flight boolean
)
language sql
security definer
set search_path = public
as $$
  select
    -- Distinct runs of this feature, plus each run-id-less call as its own run.
    (
      count(distinct run_id) filter (
        where feature = p_feature and succeeded and run_id is not null
      )
      + count(*) filter (
        where feature = p_feature and succeeded and run_id is null
      )
    )::integer as feature_runs,
    -- Label-independent cost ceiling: every call in the window, any feature,
    -- succeeded or not, because a failed call still burned provider tokens.
    coalesce(sum(input_tokens + output_tokens), 0)::bigint as window_tokens,
    count(*) filter (
      where created_at >= now() - make_interval(secs => greatest(p_burst_seconds, 1))
    )::integer as burst_calls,
    -- Already-recorded run: a later call in a run the user has already been
    -- charged for, so it must not be blocked or double-counted.
    bool_or(p_run_id is not null and run_id = p_run_id) as run_in_flight
  from public.llm_calls
  where user_id = p_user_id
    and created_at >= p_window_start;
$$;

revoke all on function public.usage_snapshot(uuid, text, timestamptz, uuid, integer) from public;
revoke all on function public.usage_snapshot(uuid, text, timestamptz, uuid, integer) from authenticated;
grant execute on function public.usage_snapshot(uuid, text, timestamptz, uuid, integer) to service_role;

/* ── current_period_usage: what the Account panel shows the user ──────────
   Reinstated under its original name, now keyed off llm_calls.feature instead
   of the dropped usage_events. security_invoker so the reader's RLS applies —
   llm_calls already restricts select to your own rows, so this view cannot
   leak another account's usage. Window matches the quota window: the live
   billing/trial period, falling back to the calendar month. */

create or replace view public.current_period_usage
with (security_invoker = true) as
select
  c.user_id,
  c.feature,
  count(*) filter (where c.succeeded) as calls,
  (
    count(distinct c.run_id) filter (where c.succeeded and c.run_id is not null)
    + count(*) filter (where c.succeeded and c.run_id is null)
  ) as runs,
  coalesce(sum(c.input_tokens + c.output_tokens), 0) as tokens,
  coalesce(sum(c.pages), 0) as pages
from public.llm_calls c
left join public.subscriptions s on s.user_id = c.user_id
where c.created_at >= coalesce(s.current_period_start, date_trunc('month', now()))
group by c.user_id, c.feature;
