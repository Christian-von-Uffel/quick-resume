"use client";

import { useEffect, useState } from "react";
import { createClient } from "../../../src/lib/supabase/client";

// What non-subscribers see instead of the editor: start the card-upfront
// trial, or — right after checkout — a short "activating" wait while the
// Stripe webhook lands the subscription row.
export default function TrialGate({ status, justCheckedOut }) {
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [activationTimedOut, setActivationTimedOut] = useState(false);

  // After the checkout redirect, poll until the webhook has mirrored the
  // subscription, then reload so the server gate re-evaluates.
  useEffect(() => {
    if (!justCheckedOut) return undefined;

    let cancelled = false;
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      try {
        const response = await fetch("/api/subscription");
        const data = await response.json();
        if (!cancelled && data.hasAccess) {
          window.location.replace("/app");
          return;
        }
      } catch {
        // Transient — keep polling.
      }
      if (!cancelled && attempts >= 15) {
        clearInterval(timer);
        setActivationTimedOut(true);
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [justCheckedOut]);

  const handleStartTrial = async () => {
    setError("");
    setStarting(true);
    try {
      const response = await fetch("/api/stripe/checkout", { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.url) {
        throw new Error(data.error || "Could not start checkout.");
      }
      window.location.assign(data.url);
    } catch (checkoutError) {
      setError(checkoutError instanceof Error ? checkoutError.message : "Could not start checkout.");
      setStarting(false);
    }
  };

  const handleSignOut = async () => {
    await createClient().auth.signOut();
    window.location.assign("/login");
  };

  if (justCheckedOut && !activationTimedOut) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-950/40 p-6 text-center">
          <h1 className="text-lg font-semibold text-neutral-100">Activating your trial...</h1>
          <p className="mt-2 text-sm text-neutral-400">
            Finishing up with Stripe — this usually takes a few seconds.
          </p>
        </div>
      </main>
    );
  }

  const returning = status && status !== "trialing";

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-950/40 p-6">
        <h1 className="text-lg font-semibold text-neutral-100">
          {activationTimedOut
            ? "Almost there"
            : returning
              ? "Restart your subscription"
              : "Start your 14-day free trial"}
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          {activationTimedOut
            ? "Your payment went through, but activation is taking longer than usual. Refresh this page in a minute — no need to check out again."
            : returning
              ? "Your subscription isn't active. Pick up right where you left off — your data is still here."
              : "Full access to tailored resume generation for 14 days. $20/month after — cancel anytime before day 14 and you won't be charged."}
        </p>

        {!activationTimedOut && (
          <button
            type="button"
            onClick={handleStartTrial}
            disabled={starting}
            className="mt-5 w-full rounded-lg border border-neutral-700 bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-white disabled:cursor-wait disabled:opacity-60"
          >
            {starting ? "Opening checkout..." : returning ? "Reactivate" : "Start free trial"}
          </button>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={handleSignOut}
          className="mt-4 text-sm text-neutral-500 underline hover:text-neutral-300"
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
