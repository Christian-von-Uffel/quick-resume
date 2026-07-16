import { getStripe } from "../../../../src/lib/server/stripe";
import { getRequestUser, unauthorizedResponse } from "../../../../src/lib/server/auth";
import { getSubscriptionForUser } from "../../../../src/lib/server/subscription";

// Hands the user to Stripe's hosted Customer Portal to manage payment method,
// see invoices, or cancel — so the app never has to build billing UI.
export async function POST(request) {
  const user = await getRequestUser();
  if (!user) return unauthorizedResponse();

  const subscription = await getSubscriptionForUser(user.id);
  if (!subscription?.stripe_customer_id) {
    return Response.json(
      { error: "No billing profile yet — start a trial first." },
      { status: 404 }
    );
  }

  const origin = new URL(request.url).origin;

  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: subscription.stripe_customer_id,
      return_url: `${origin}/app`,
    });
    return Response.json({ url: session.url });
  } catch (error) {
    console.error("stripe portal session failed:", error);
    return Response.json(
      { error: "Could not open the billing portal. Try again in a moment." },
      { status: 502 }
    );
  }
}
