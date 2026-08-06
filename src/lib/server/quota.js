// Usage limits. Runs before any paid API route spends money with a provider.
//
// Numbers live in plans.limits (data, not code) so a limit can be retuned with
// one UPDATE and no deploy. An absent or null key means unlimited.
//
// Two layers, deliberately different in kind:
//
//   1. Per-feature run quotas — the user-facing limit ("10 resumes in your
//      trial"). Counted per distinct run_id off llm_calls.feature, which the
//      client declares. Right for honest clients, and what makes an accurate
//      "7 of 10 used" possible.
//   2. Token and burst ceilings — the actual security boundary. Summed over
//      every call in the window regardless of feature, so a forged feature
//      label cannot buy unlimited generations, only mislabelled ones.
//
// Layer 1 is UX. Layer 2 is the cost cap. Don't confuse them.

import { getSupabaseAdmin } from "./supabaseAdmin";

// Features a client may declare. Anything else is recorded as '' and metered
// under the token/burst ceiling only — an unknown label must never be a way to
// land in an unmetered bucket.
export const METERED_FEATURES = new Set([
  "resume_generation",
  "clarity_review",
  "job_gap_review",
  "experience_expansion",
  "resume_import",
  "job_scrape",
  "lab",
]);

export function normalizeFeature(value) {
  const feature = typeof value === "string" ? value.trim() : "";
  return METERED_FEATURES.has(feature) ? feature : "";
}

// Which limits key caps which feature. Trial and paid differ only for resume
// generation — the rest are already generous enough that a second trial-only
// number would be noise.
const QUOTA_KEYS = {
  resume_generation: { trial: "trial_resume_generations", paid: "resume_generations_per_month" },
  clarity_review: { trial: "clarity_reviews_per_month", paid: "clarity_reviews_per_month" },
  job_gap_review: { trial: "job_gap_reviews_per_month", paid: "job_gap_reviews_per_month" },
  resume_import: { trial: "resume_imports_per_month", paid: "resume_imports_per_month" },
  // No key in plans.limits today, so uncapped beyond the token ceiling. Mapped
  // anyway so capping it later is an UPDATE, not a deploy.
  experience_expansion: {
    trial: "experience_expansions_per_month",
    paid: "experience_expansions_per_month",
  },
};

// What the user calls the thing, for the message they get when they hit it.
const FEATURE_NOUNS = {
  resume_generation: { one: "resume", many: "resumes" },
  clarity_review: { one: "clarity review", many: "clarity reviews" },
  job_gap_review: { one: "job comparison", many: "job comparisons" },
  resume_import: { one: "resume import", many: "resume imports" },
};

/**
 * Read a limit. Absent, null, or non-numeric means unlimited (null), so a
 * limit can be lifted by deleting the key. Zero is a real limit: blocked.
 */
export function readLimit(limits, key) {
  if (!key) return null;
  const value = limits?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * The window usage is counted over: the live trial or billing period, falling
 * back to the calendar month when there is no subscription row yet. Matches the
 * current_period_usage view so the Account panel and the enforcer never
 * disagree about what "this period" means.
 */
export function usageWindowStart(subscription, now = new Date()) {
  const start = subscription?.current_period_start ?? subscription?.created_at ?? null;
  const parsed = start ? new Date(start) : null;
  if (parsed && !Number.isNaN(parsed.getTime()) && parsed <= now) return parsed;
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/**
 * Decide from already-counted usage. Pure, so the interesting cases are
 * testable without a database.
 *
 * `snapshot` is { featureRuns, windowTokens, burstCalls, runInFlight }.
 * Returns { allowed: true } or { allowed, status, error, limit, used, feature }.
 */
export function evaluateUsage({ feature, isTrialing, limits, snapshot }) {
  const { featureRuns = 0, windowTokens = 0, burstCalls = 0, runInFlight = false } = snapshot ?? {};

  // Burst first: it is the one limit that should also apply mid-run, since a
  // hammered route is the shape of a script, not a person.
  const burst = readLimit(limits, "burst_per_minute");
  if (burst !== null && burstCalls >= burst) {
    return {
      allowed: false,
      status: 429,
      error: "You're going a bit fast for us — wait a minute and try again.",
      limit: burst,
      used: burstCalls,
      feature,
      reason: "burst",
    };
  }

  const tokenKey = isTrialing ? "trial_tokens" : "tokens_per_month";
  const tokenCeiling = readLimit(limits, tokenKey);
  if (tokenCeiling !== null && windowTokens >= tokenCeiling) {
    return {
      allowed: false,
      status: 429,
      error: isTrialing
        ? "Your trial has reached its usage limit. Subscribe to keep going."
        : "You've reached this month's usage limit. It resets when your next billing period starts.",
      limit: tokenCeiling,
      used: windowTokens,
      feature,
      reason: "tokens",
    };
  }

  // A later call in a run already recorded — and therefore already counted
  // against the quota. Blocking it would strand a half-finished resume and
  // charge the user a run they never received.
  if (runInFlight) return { allowed: true, feature, runInFlight: true };

  const keys = QUOTA_KEYS[feature];
  const limit = readLimit(limits, isTrialing ? keys?.trial : keys?.paid);
  if (limit === null) return { allowed: true, feature };

  if (featureRuns >= limit) {
    const noun = FEATURE_NOUNS[feature] ?? { one: "request", many: "requests" };
    const allowance = `${limit} ${limit === 1 ? noun.one : noun.many}`;
    return {
      allowed: false,
      status: 429,
      error: isTrialing
        ? `Your free trial includes ${allowance}, and you've used ${featureRuns === limit ? "all of them" : "them all"}. Subscribe to keep going — your work is saved.`
        : `You've used all ${allowance} in this billing period. Your allowance resets when the next one starts.`,
      limit,
      used: featureRuns,
      feature,
      reason: "quota",
      upgrade: isTrialing,
    };
  }

  return { allowed: true, feature, limit, used: featureRuns };
}

// plans.limits changes rarely and is read on every metered call, so it is
// cached per server instance for a minute rather than fetched each time.
const LIMITS_TTL_MS = 60_000;
let limitsCache = null;

export async function getPlanLimits(planId = "pro") {
  if (limitsCache && limitsCache.planId === planId && Date.now() < limitsCache.expiresAt) {
    return limitsCache.limits;
  }

  const { data, error } = await getSupabaseAdmin()
    .from("plans")
    .select("limits")
    .eq("id", planId)
    .maybeSingle();

  if (error) throw new Error(`Could not load plan limits: ${error.message}`);

  const limits = data?.limits && typeof data.limits === "object" ? data.limits : {};
  limitsCache = { planId, limits, expiresAt: Date.now() + LIMITS_TTL_MS };
  return limits;
}

export function clearPlanLimitsCache() {
  limitsCache = null;
}

/**
 * The call the API routes make. Counts this user's usage in the current period
 * and decides. Returns the same shape as evaluateUsage.
 *
 * Fails OPEN: if the counting query itself breaks, a paying user must not be
 * locked out of the product by our own metering bug. The token ceiling means
 * the exposure from a broken window is bounded by the next successful check.
 */
export async function checkUsageAllowed({ userId, subscription, feature, runId = null }) {
  const normalized = normalizeFeature(feature);
  const isTrialing = subscription?.status === "trialing";

  let limits;
  try {
    limits = await getPlanLimits(subscription?.plan_id ?? "pro");
  } catch (error) {
    console.warn("[quota] limits unavailable, allowing call:", error?.message ?? error);
    return { allowed: true, feature: normalized };
  }

  const windowStart = usageWindowStart(subscription);

  let snapshot;
  try {
    const { data, error } = await getSupabaseAdmin().rpc("usage_snapshot", {
      p_user_id: userId,
      p_feature: normalized,
      p_window_start: windowStart.toISOString(),
      p_run_id: runId,
    });
    if (error) throw new Error(error.message);

    const row = Array.isArray(data) ? data[0] : data;
    snapshot = {
      featureRuns: Number(row?.feature_runs ?? 0),
      windowTokens: Number(row?.window_tokens ?? 0),
      burstCalls: Number(row?.burst_calls ?? 0),
      runInFlight: Boolean(row?.run_in_flight),
    };
  } catch (error) {
    console.warn("[quota] usage_snapshot failed, allowing call:", error?.message ?? error);
    return { allowed: true, feature: normalized };
  }

  return evaluateUsage({ feature: normalized, isTrialing, limits, snapshot });
}

/**
 * Resume allowance for display: what the Account panel and the generate button
 * show so nobody discovers the limit by hitting it. Returns null when there is
 * no cap in force, so the UI can simply render nothing.
 */
export async function getResumeAllowance({ userId, subscription }) {
  const isTrialing = subscription?.status === "trialing";

  let limits;
  try {
    limits = await getPlanLimits(subscription?.plan_id ?? "pro");
  } catch {
    return null;
  }

  const limit = readLimit(
    limits,
    isTrialing ? QUOTA_KEYS.resume_generation.trial : QUOTA_KEYS.resume_generation.paid
  );
  if (limit === null) return null;

  try {
    const { data, error } = await getSupabaseAdmin().rpc("usage_snapshot", {
      p_user_id: userId,
      p_feature: "resume_generation",
      p_window_start: usageWindowStart(subscription).toISOString(),
      p_run_id: null,
    });
    if (error) throw new Error(error.message);

    const row = Array.isArray(data) ? data[0] : data;
    const used = Number(row?.feature_runs ?? 0);
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      isTrial: isTrialing,
    };
  } catch (error) {
    console.warn("[quota] allowance lookup failed:", error?.message ?? error);
    return null;
  }
}

/** 429 body for a blocked call. `upgrade` tells the client to offer checkout. */
export function usageLimitResponse(decision) {
  return Response.json(
    {
      error: decision.error,
      limit: decision.limit ?? null,
      used: decision.used ?? null,
      feature: decision.feature || null,
      reason: decision.reason ?? "quota",
      upgrade: Boolean(decision.upgrade),
    },
    { status: decision.status ?? 429 }
  );
}
