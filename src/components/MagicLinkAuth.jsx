"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "../lib/supabase/client";
import {
  describeRequestError,
  describeVerifyError,
  isUnknownAccountError,
  readVerification,
  withoutVerification,
} from "../lib/magicLink";
import {
  destinationFor,
  forgetIntent,
  hasPendingIntent,
  intentToUserMetadata,
  readIntent,
  recallIntent,
  rememberIntent,
} from "../lib/authIntent";
import { readGclid, reportConversion } from "../lib/ads";

// Both halves of auth are the same primitive: type an email, get a one-time
// link, click it, you're in. The only difference is whether an unknown address
// creates an account — so signup and login share this component and differ by
// one flag.
const COPY = {
  login: {
    heading: "Sign in",
    blurb: "Enter your email and we'll send you a link that signs you in.",
    submit: "Email me a sign-in link",
    submitting: "Sending link...",
    crossPrompt: "New here?",
    crossLabel: "Create an account",
    crossHref: "/signup",
  },
  signup: {
    heading: "Create your account",
    blurb: "One profile. A tailored resume for every job. No password to invent.",
    submit: "Email me a sign-up link",
    submitting: "Sending link...",
    crossPrompt: "Already have an account?",
    crossLabel: "Sign in",
    crossHref: "/login",
  },
};

const RESEND_AFTER_SECONDS = 30;

const CARD =
  "w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-950/40 p-6";
const PRIMARY_BUTTON =
  "w-full rounded-lg border border-neutral-700 bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-60";
const QUIET_LINK = "text-neutral-300 underline hover:text-neutral-100";

export default function MagicLinkAuth({ mode, query = "" }) {
  const copy = COPY[mode];

  // Derived from the query string the server rendered against, so the first
  // client paint matches the server's and a link click doesn't flash the form.
  const verification = useMemo(() => readVerification(query), [query]);
  const intent = useMemo(() => readIntent(query), [query]);

  const [email, setEmail] = useState(
    () => new URLSearchParams(query).get("email") ?? ""
  );
  const [phase, setPhase] = useState(verification ? "verifying" : "form");
  const [error, setError] = useState(() =>
    new URLSearchParams(query).get("error") === "confirmation"
      ? "That link is no longer valid. Enter your email and we'll send a fresh one."
      : ""
  );
  const [noAccount, setNoAccount] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  // Separate from `phase`, so a resend from the "check your email" screen
  // doesn't drop the user back to an empty form while it's in flight.
  const [busy, setBusy] = useState(false);

  const sentTo = useRef("");
  const verifyStarted = useRef(false);

  /* ── verifying an emailed link ─────────────────────────────────────────── */

  useEffect(() => {
    if (!verification || verifyStarted.current) return undefined;
    // Strict Mode runs effects twice in development; the token is spent by the
    // first POST, so the second must not fire and report a bogus failure.
    verifyStarted.current = true;

    // Take the credential out of the address bar before anything else. It is
    // single-use, so a refresh would only replay a spent token, and leaving it
    // there leaks it through the Referer of anything the page loads next.
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${withoutVerification(query)}`
    );

    // No cancellation flag on purpose. The ref above already guarantees this
    // runs once, and Strict Mode's mount/unmount/mount would set such a flag
    // on the one in-flight request — leaving the page stuck on "Signing you
    // in..." with a token that has already been spent.
    (async () => {
      const supabase = createClient();
      // An explicit POST — this is the whole reason the emailed link points at
      // this page instead of Supabase's ConfirmationURL. Mail-security
      // scanners (Microsoft Safe Links and friends) fetch every GET link in an
      // incoming message; landing on a page whose GET does nothing means the
      // scanner can't burn the only credential the user has.
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: verification.tokenHash,
        type: verification.type,
      });

      if (verifyError || !data?.session) {
        setError(
          describeVerifyError(verifyError) ||
            "That sign-in link didn't work. Send yourself a new one."
        );
        setPhase("form");
        return;
      }

      const destination = destinationFor({
        user: data.user,
        storedIntent: recallIntent(),
      });
      forgetIntent();

      // The intent has now been honored; clear it so the next sign-in on this
      // account doesn't get dragged back to wherever they were months ago.
      if (hasPendingIntent(data.user)) {
        await supabase.auth.updateUser({ data: { pending_intent: null } });
      }

      // Full navigation, so the fresh session cookie is on the request the
      // middleware sees.
      window.location.replace(destination);
    })();

    return undefined;
  }, [verification, query]);

  /* ── requesting a link ─────────────────────────────────────────────────── */

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const requestLink = useCallback(
    async (address) => {
      setError("");
      setNoAccount(false);
      setBusy(true);

      const supabase = createClient();
      const { error: requestError } = await supabase.auth.signInWithOtp({
        email: address,
        options: {
          // The one real difference between the two forms. Signing up creates
          // the account; signing in must not, so a typo on the login form
          // can't quietly mint a second, empty account the person then can't
          // find their work in.
          shouldCreateUser: mode === "signup",
          // Stashed on the auth user at request time so it survives the inbox
          // hop — including opening the link on a phone. Supabase only applies
          // it when the account is created, which is exactly the case that
          // needs it.
          data: intentToUserMetadata(intent, { gclid: readGclid() }),
          // Deliberately no emailRedirectTo: the email template builds our own
          // /login?token_hash=... link, so there is no redirect allowlist to
          // keep in sync with deploy previews.
        },
      });

      if (requestError) {
        setError(describeRequestError(requestError, mode));
        setNoAccount(mode === "login" && isUnknownAccountError(requestError));
        // Phase deliberately unchanged: a failed resend belongs on the
        // "check your email" screen, not back at an empty form.
        setBusy(false);
        return;
      }

      rememberIntent(intent);

      // The campaign's bidding signal. This is the last moment that is still
      // the same browser session as the ad click, so it is the only signup
      // milestone Google can attribute reliably — everything after it happens
      // on the far side of an inbox. Signup only: a returning user signing in
      // is not an acquisition. Deduped so the resend button can't inflate it.
      if (mode === "signup") {
        reportConversion("signup_requested", { once: "signup_requested" });
      }

      sentTo.current = address;
      setCooldown(RESEND_AFTER_SECONDS);
      setBusy(false);
      setPhase("sent");
    },
    [intent, mode]
  );

  const handleSubmit = (event) => {
    event.preventDefault();
    requestLink(email.trim());
  };

  /* ── screens ───────────────────────────────────────────────────────────── */

  if (phase === "verifying") {
    return (
      <Shell>
        <div className={CARD}>
          <h1 className="text-lg font-semibold text-neutral-100">
            Signing you in...
          </h1>
          <p className="mt-2 text-sm text-neutral-400" aria-live="polite">
            One moment — finishing up with your link.
          </p>
        </div>
      </Shell>
    );
  }

  if (phase === "sent") {
    return (
      <Shell>
        <div className={CARD}>
          <h1 className="text-lg font-semibold text-neutral-100">
            Check your email
          </h1>
          <p className="mt-2 text-sm text-neutral-400">
            We sent a sign-in link to{" "}
            <span className="text-neutral-200">{sentTo.current}</span>. Open it
            and you&rsquo;re in — no password, nothing else to set up.
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            The link works once and expires in an hour. Opening it on your phone
            works too; it signs in whichever device you open it on.
          </p>

          {error && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => requestLink(sentTo.current)}
            disabled={busy || cooldown > 0}
            className="mt-5 w-full rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy
              ? "Sending..."
              : cooldown > 0
                ? `Resend in ${cooldown}s`
                : "Send another link"}
          </button>

          <button
            type="button"
            onClick={() => {
              setPhase("form");
              setError("");
            }}
            className="mt-4 text-sm text-neutral-500 underline hover:text-neutral-300"
          >
            Use a different email
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className={CARD}>
        <h1 className="text-lg font-semibold text-neutral-100">{copy.heading}</h1>
        <p className="mt-1 text-sm text-neutral-500">{copy.blurb}</p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-500">Email</span>
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
            />
          </label>

          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}{" "}
              {noAccount && (
                <a
                  href={`/signup?email=${encodeURIComponent(email.trim())}`}
                  className={QUIET_LINK}
                >
                  Create one
                </a>
              )}
            </p>
          )}

          <button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
            {busy ? copy.submitting : copy.submit}
          </button>
        </form>

        <p className="mt-4 text-xs text-neutral-500">
          No password — we email you a link every time. Once you&rsquo;re in,
          this device stays signed in.
        </p>

        <p className="mt-4 text-sm text-neutral-500">
          {copy.crossPrompt}{" "}
          <a href={copy.crossHref} className={QUIET_LINK}>
            {copy.crossLabel}
          </a>
        </p>
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      {children}
    </main>
  );
}
