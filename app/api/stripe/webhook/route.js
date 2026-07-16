import { getStripe } from "../../../../src/lib/server/stripe";
import { getSupabaseAdmin } from "../../../../src/lib/server/supabaseAdmin";

// Stripe → Supabase subscription mirror. Stripe is the source of truth for
// billing; this route keeps public.subscriptions in sync so the app can gate
// access with one cheap query. Writes use the secret-key client — the table
// has no client-side write policies, so rows can only appear through here.

// Billing periods moved from the subscription object onto its items in newer
// Stripe API versions; read the item first and fall back for older payloads.
function subscriptionRow(subscription, planId) {
  const item = subscription.items?.data?.[0] ?? null;
  const toIso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);

  return {
    plan_id: planId,
    stripe_customer_id:
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id ?? "",
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    billing_interval: item?.price?.recurring?.interval === "year" ? "year" : "month",
    current_period_start: toIso(item?.current_period_start ?? subscription.current_period_start),
    current_period_end: toIso(item?.current_period_end ?? subscription.current_period_end),
    trial_ends_at: toIso(subscription.trial_end),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
  };
}

async function resolvePlanId(subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id ?? "";
  if (priceId) {
    const { data } = await getSupabaseAdmin()
      .from("plans")
      .select("id")
      .or(`stripe_price_id_monthly.eq.${priceId},stripe_price_id_yearly.eq.${priceId}`)
      .maybeSingle();
    if (data?.id) return data.id;
  }
  return "pro";
}

async function handleCheckoutCompleted(session) {
  if (session.mode !== "subscription") return;

  const userId = session.client_reference_id;
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;

  // Without a user id there is nothing to attach the customer to. This only
  // happens for checkouts that didn't come from the app (e.g. a raw Payment
  // Link click); those get reconciled manually.
  if (!userId || !subscriptionId) {
    console.warn("checkout.session.completed without client_reference_id or subscription", session.id);
    return;
  }

  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  const planId = await resolvePlanId(subscription);

  const { error } = await getSupabaseAdmin()
    .from("subscriptions")
    .upsert({ user_id: userId, ...subscriptionRow(subscription, planId) }, { onConflict: "user_id" });

  if (error) throw new Error(`subscriptions upsert failed: ${error.message}`);
}

async function handleSubscriptionChanged(subscription) {
  const planId = await resolvePlanId(subscription);
  const { error } = await getSupabaseAdmin()
    .from("subscriptions")
    .update(subscriptionRow(subscription, planId))
    .eq("stripe_subscription_id", subscription.id);

  // No matching row simply means checkout.session.completed hasn't landed
  // yet (or the subscription never belonged to an app user) — safe to skip.
  if (error) throw new Error(`subscriptions update failed: ${error.message}`);
}

export async function POST(request) {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    return Response.json({ error: "Webhook secret is not configured." }, { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");
  const payload = await request.text();

  let event;
  try {
    event = await getStripe().webhooks.constructEventAsync(payload, signature, secret);
  } catch {
    return Response.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(event.data.object);
    } else if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await handleSubscriptionChanged(event.data.object);
    }
  } catch (error) {
    // Non-2xx makes Stripe retry with backoff — the right behavior for a
    // transient database failure.
    console.error("stripe webhook handling failed:", error);
    return Response.json({ error: "Webhook handling failed." }, { status: 500 });
  }

  return Response.json({ received: true });
}
