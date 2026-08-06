import { getRequestUser, unauthorizedResponse } from "../../../src/lib/server/auth";
import { getSubscriptionForUser, hasActiveAccess } from "../../../src/lib/server/subscription";
import { getResumeAllowance } from "../../../src/lib/server/quota";

// Subscription status for the account UI and the post-checkout poll.
export async function GET() {
  const user = await getRequestUser();
  if (!user) return unauthorizedResponse();

  const subscription = await getSubscriptionForUser(user.id);
  // Null when no cap applies, so the UI renders nothing rather than "unlimited".
  const resumeAllowance = hasActiveAccess(subscription)
    ? await getResumeAllowance({ userId: user.id, subscription })
    : null;

  return Response.json({
    resumeAllowance,
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
