import { getRequestUser, unauthorizedResponse } from "../../../src/lib/server/auth";
import { getSubscriptionForUser, hasActiveAccess } from "../../../src/lib/server/subscription";

// Subscription status for the account UI and the post-checkout poll.
export async function GET() {
  const user = await getRequestUser();
  if (!user) return unauthorizedResponse();

  const subscription = await getSubscriptionForUser(user.id);

  return Response.json({
    hasAccess: hasActiveAccess(subscription),
    status: subscription?.status ?? null,
    planId: subscription?.plan_id ?? null,
    billingInterval: subscription?.billing_interval ?? null,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    trialEndsAt: subscription?.trial_ends_at ?? null,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
    canManageBilling: Boolean(subscription?.stripe_customer_id),
  });
}
