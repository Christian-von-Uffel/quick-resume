import { useEffect, useState } from "react";
import { createClient } from "../lib/supabase/client";

// The signed-in identity card at the top of Settings. Self-contained so the
// editor stays ignorant of auth plumbing.
// "Trial ends Jul 26" / "Renews Aug 12" — the one line that answers the only
// billing question users actually have.
function describeBilling(subscription) {
  if (!subscription?.status) return "";
  const date = (iso) =>
    iso
      ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "";

  if (subscription.status === "trialing") {
    const end = date(subscription.trialEndsAt);
    return end ? `Free trial — first charge ${end}` : "Free trial";
  }
  if (subscription.status === "active") {
    const end = date(subscription.currentPeriodEnd);
    if (subscription.cancelAtPeriodEnd) return end ? `Cancels ${end}` : "Cancels at period end";
    return end ? `Renews ${end}` : "Active";
  }
  return `Subscription ${subscription.status.replace(/_/g, " ")}`;
}

export function AccountSection() {
  const [email, setEmail] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [subscription, setSubscription] = useState(null);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [portalError, setPortalError] = useState("");

  useEffect(() => {
    let cancelled = false;
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!cancelled) setEmail(data.user?.email ?? "");
      });
    fetch("/api/subscription")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data) setSubscription(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleManageBilling = async () => {
    setPortalError("");
    setOpeningPortal(true);
    try {
      const response = await fetch("/api/stripe/portal", { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.url) throw new Error(data.error || "Could not open billing.");
      window.location.assign(data.url);
    } catch (error) {
      setPortalError(error instanceof Error ? error.message : "Could not open billing.");
      setOpeningPortal(false);
    }
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    await createClient().auth.signOut();
    // Full navigation so the cleared session cookie is what middleware sees.
    window.location.assign("/login");
  };

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/40 p-4">
      <h2 className="text-sm font-semibold text-neutral-200">Account</h2>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-neutral-400">
            {email ? (
              <>
                Signed in as <span className="text-neutral-200">{email}</span>
              </>
            ) : (
              "Loading account..."
            )}
          </p>
          {subscription && (
            <p className="mt-1 text-xs text-neutral-500">{describeBilling(subscription)}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {subscription?.canManageBilling && (
            <button
              type="button"
              onClick={handleManageBilling}
              disabled={openingPortal}
              className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50 disabled:cursor-wait disabled:opacity-60"
            >
              {openingPortal ? "Opening..." : "Manage billing"}
            </button>
          )}
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50 disabled:cursor-wait disabled:opacity-60"
          >
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </div>
      {portalError && (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {portalError}
        </p>
      )}
    </div>
  );
}
