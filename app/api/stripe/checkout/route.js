import { getStripe } from "../../../../src/lib/server/stripe";
import { getSupabaseAdmin } from "../../../../src/lib/server/supabaseAdmin";
import { getRequestUser, unauthorizedResponse } from "../../../../src/lib/server/auth";
import { getSubscriptionForUser, hasActiveAccess } from "../../../../src/lib/server/subscription";

// Starts the card-upfront 14-day trial: creates a Stripe Checkout session for
// the signed-in user. client_reference_id carries the Supabase user id so the
// webhook can attach the resulting customer/subscription to the right account.
export async function POST(request) {
  const user = await getRequestUser();
  if (!user) return unauthorizedResponse();

  const existing = await getSubscriptionForUser(user.id);
  if (hasActiveAccess(existing)) {
    // Already subscribed — nothing to buy; send them into the app.
    return Response.json({ url: "/app" });
  }

  const { data: plan } = await getSupabaseAdmin()
    .from("plans")
    .select("stripe_price_id_monthly")
    .eq("id", "pro")
    .maybeSingle();

  if (!plan?.stripe_price_id_monthly) {
    return Response.json(
      { error: "Billing isn't configured yet. Try again later." },
      { status: 500 }
    );
  }

  const origin = new URL(request.url).origin;

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: plan.stripe_price_id_monthly, quantity: 1 }],
      // One trial per account: any prior subscription row means the trial was
      // already used, so cancel/reactivate can't mint endless free trials.
      ...(existing ? {} : { subscription_data: { trial_period_days: 14 } }),
      client_reference_id: user.id,
      // Returning customers (canceled, past_due) keep their Stripe customer
      // record; first-timers get one created from their account email.
      ...(existing?.stripe_customer_id
        ? { customer: existing.stripe_customer_id }
        : { customer_email: user.email }),
      success_url: `${origin}/app?checkout=success`,
      cancel_url: `${origin}/app`,
    });

    return Response.json({ url: session.url });
  } catch (error) {
    console.error("stripe checkout session failed:", error);
    return Response.json(
      { error: "Could not start checkout. Try again in a moment." },
      { status: 502 }
    );
  }
}
