import Stripe from "stripe";

// Server-only Stripe client. The secret key decides the environment: sk_test_
// keys hit Stripe's test mode, sk_live_ keys hit production billing.
let stripeClient = null;

export function getStripe() {
  const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }
  if (!stripeClient) {
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}
