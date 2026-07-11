-- Billing, plans, and usage metering.
--
-- Stripe is the source of truth for billing state; `subscriptions` is a
-- mirror maintained by the Stripe webhook route using the service-role key.
-- Clients can read their own rows but can write none of these tables —
-- there are deliberately no insert/update policies, so usage can only be
-- recorded server-side and can't be spoofed from the browser.

/* ── plans: limits live in data so tiers can be tuned without a deploy ── */

create table public.plans (
  -- Slug referenced by subscriptions ('pro', ...).
  id text primary key,
  name text not null,
  stripe_product_id text not null default '',
  stripe_price_id_monthly text not null default '',
  stripe_price_id_yearly text not null default '',
  -- Per-billing-period quotas and abuse caps, enforced by the API routes.
  -- Action counts are the user-facing limits; tokens_per_month is an
  -- internal cost backstop, not shown to users.
  limits jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function public.set_updated_at();

-- Confirmed limit: 50 resume generations per month. The rest are tunable
-- defaults pending real usage data — edit the row, no redeploy needed.
insert into public.plans (id, name, limits) values (
  'pro',
  'Pro',
  '{
    "generations_per_month": 50,
    "clarity_reviews_per_month": 100,
    "missing_experience_reviews_per_month": 100,
    "imports_per_month": 25,
    "burst_per_minute": 5,
    "max_jd_chars": 30000,
    "tokens_per_month": 15000000
  }'::jsonb
);

/* ── subscriptions: one row per user, upserted by the Stripe webhook ──── */

create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan_id text not null references public.plans (id),
  stripe_customer_id text not null default '',
  stripe_subscription_id text not null default '',
  -- Mirrors Stripe's subscription statuses. API routes allow LLM calls
  -- only for 'trialing' and 'active'.
  status text not null default 'trialing' check (status in (
    'trialing', 'active', 'past_due', 'canceled',
    'incomplete', 'incomplete_expired', 'unpaid', 'paused'
  )),
  billing_interval text not null default 'month' check (billing_interval in ('month', 'year')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index subscriptions_stripe_customer_id_idx on public.subscriptions (stripe_customer_id);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

/* ── usage_events: one row per provider call or countable product event ── */

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- What the tokens were spent on. Current values: 'generate_resume',
  -- 'clarity_review', 'clarity_suggestion', 'missing_experience_review',
  -- 'enrich_experience', 'import_resume', 'job_scrape', 'export_pdf'.
  -- Kept unconstrained so adding a feature doesn't need a migration.
  feature text not null,
  -- Groups the several provider calls of one logical run (a resume
  -- generation is analysis + evidence + compose). Quotas count distinct
  -- runs, not raw calls. Single-call features may leave it null.
  run_id uuid,
  provider text not null default '',
  model text not null default '',
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  -- Mistral OCR bills by page, not token.
  pages_processed integer not null default 0,
  status text not null default 'succeeded' check (status in ('succeeded', 'failed')),
  created_at timestamptz not null default now()
);

create index usage_events_user_created_idx on public.usage_events (user_id, created_at desc);
create index usage_events_user_feature_created_idx on public.usage_events (user_id, feature, created_at desc);

/* ── current-period usage rollup for the account Usage panel ──────────── */

-- Aggregates each user's events inside their live billing period (falling
-- back to the calendar month before a subscription row exists).
-- security_invoker makes the underlying RLS apply: users see only their own.
create view public.current_period_usage
with (security_invoker = true) as
select
  u.user_id,
  u.feature,
  count(*) filter (where u.status = 'succeeded') as calls,
  coalesce(
    count(distinct u.run_id) filter (where u.status = 'succeeded' and u.run_id is not null),
    0
  ) as runs,
  coalesce(sum(u.input_tokens + u.output_tokens), 0) as tokens,
  coalesce(sum(u.pages_processed), 0) as pages
from public.usage_events u
left join public.subscriptions s on s.user_id = u.user_id
where u.created_at >= coalesce(s.current_period_start, date_trunc('month', now()))
  and u.created_at < coalesce(s.current_period_end, now() + interval '1 second')
group by u.user_id, u.feature;

/* ── row-level security ───────────────────────────────────────────────── */

alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_events enable row level security;

-- Plans are public catalog data (needed to render limits in the UI).
create policy "plans are readable" on public.plans
  for select to authenticated using (true);

create policy "own subscription" on public.subscriptions
  for select using (auth.uid() = user_id);

create policy "own usage" on public.usage_events
  for select using (auth.uid() = user_id);
