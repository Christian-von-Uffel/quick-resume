import { getSupabaseAdmin } from "./supabaseAdmin";

// Statuses that open the paid product surface. Everything else — past_due,
// canceled, paused, incomplete — lands on the trial/renew gate.
const ACCESS_STATUSES = new Set(["trialing", "active"]);

export async function getSubscriptionForUser(userId) {
  const { data, error } = await getSupabaseAdmin()
    .from("subscriptions")
    .select(
      "plan_id, status, billing_interval, current_period_start, current_period_end, trial_ends_at, cancel_at_period_end, stripe_customer_id"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load the subscription: ${error.message}`);
  }
  return data ?? null;
}

export function hasActiveAccess(subscription) {
  return Boolean(subscription && ACCESS_STATUSES.has(subscription.status));
}

// Shared 402 for paid API routes: the caller is signed in but not subscribed.
export function subscriptionRequiredResponse() {
  return Response.json(
    { error: "Start your free trial to use this feature." },
    { status: 402 }
  );
}
