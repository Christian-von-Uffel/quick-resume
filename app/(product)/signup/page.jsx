"use client";

import { useState } from "react";
import { createClient } from "../../../src/lib/supabase/client";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    const supabase = createClient();
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (signUpError) {
      setError(signUpError.message);
      setSubmitting(false);
      return;
    }

    // Supabase anti-enumeration: signing up an already-registered email
    // "succeeds" but returns a user with no identities.
    if (data.user && data.user.identities?.length === 0) {
      setError("An account with this email already exists — sign in instead.");
      setSubmitting(false);
      return;
    }

    // With email confirmation enabled there's no session yet; the account
    // activates through the emailed link.
    if (!data.session) {
      setConfirmationSent(true);
      setSubmitting(false);
      return;
    }

    window.location.assign("/app");
  };

  if (confirmationSent) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-950/40 p-6">
          <h1 className="text-lg font-semibold text-neutral-100">Check your email</h1>
          <p className="mt-2 text-sm text-neutral-400">
            We sent a confirmation link to <span className="text-neutral-200">{email.trim()}</span>.
            Click it to activate your account, and you&rsquo;ll land right in the app.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-950/40 p-6">
        <h1 className="text-lg font-semibold text-neutral-100">Create your account</h1>
        <p className="mt-1 text-sm text-neutral-500">
          One profile. A tailored resume for every job.
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
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
            />
            <p className="mt-1 text-xs text-neutral-600">At least 8 characters.</p>
          </label>

          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg border border-neutral-700 bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-white disabled:cursor-wait disabled:opacity-60"
          >
            {submitting ? "Creating account..." : "Create account"}
          </button>
        </form>

        <p className="mt-4 text-sm text-neutral-500">
          Already have an account?{" "}
          <a href="/login" className="text-neutral-300 underline hover:text-neutral-100">
            Sign in
          </a>
        </p>
      </div>
    </main>
  );
}
