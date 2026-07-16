"use client";

import { useState } from "react";
import { createClient } from "../../../src/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(() =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("error") === "confirmation"
      ? "That confirmation link is invalid or has expired. Try signing in, or sign up again."
      : ""
  );
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      setError(
        /confirm/i.test(signInError.message)
          ? "Confirm your email first — check your inbox for the link we sent."
          : "That email and password don't match. Try again."
      );
      setSubmitting(false);
      return;
    }

    // Full navigation so the fresh session cookie is on the request the
    // middleware sees. Carry ?checkout=success through (the middleware keeps
    // it on the redirect here) so a payer whose session lapsed during Stripe
    // Checkout still gets the activation poll instead of the trial gate.
    const checkout = new URLSearchParams(window.location.search).get("checkout");
    window.location.assign(
      checkout ? `/app?checkout=${encodeURIComponent(checkout)}` : "/app"
    );
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-950/40 p-6">
        <h1 className="text-lg font-semibold text-neutral-100">Sign in</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Welcome back — pick up where you left off.
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block">
            <span className="block text-xs text-neutral-500 mb-1">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
            />
          </label>

          <label className="block">
            <span className="block text-xs text-neutral-500 mb-1">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
            />
          </label>

          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg border border-neutral-700 bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-white disabled:cursor-wait disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {submitting ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-sm text-neutral-500">
          New here?{" "}
          <a href="/signup" className="text-neutral-300 underline hover:text-neutral-100">
            Create an account
          </a>
        </p>
      </div>
    </main>
  );
}
