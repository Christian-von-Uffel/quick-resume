// Single source of truth for the browser-safe Supabase config (project URL and
// publishable key), used by server components, route handlers, and the edge
// middleware.
//
// The browser bundle can ONLY read NEXT_PUBLIC_*-prefixed vars (Next inlines
// those at build time); historically the server code read the unprefixed
// names. Both hold the SAME publishable values — the split is a naming
// convention, not a security boundary. Accepting either name means a deploy
// works as long as ONE convention is configured, instead of crashing the whole
// auth-gated surface with an opaque MIDDLEWARE_INVOCATION_FAILED when only the
// NEXT_PUBLIC_ pair was set on the host.
//
// NEXT_PUBLIC_* is preferred because Next inlines it into every bundle
// (including the edge middleware) at build time, so it is guaranteed present at
// runtime whenever the build had it — the unprefixed name is only a runtime
// lookup. The secret key is deliberately NOT resolved here: it must never be
// exposed under a NEXT_PUBLIC_ name.

export function getSupabaseUrl() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!url) {
    throw new Error(
      "Missing Supabase URL. Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) " +
        "in the environment — on Vercel: Project → Settings → Environment " +
        "Variables, scoped to Production and Preview."
    );
  }
  return url;
}

export function getSupabasePublishableKey() {
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!key) {
    throw new Error(
      "Missing Supabase publishable key. Set " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or SUPABASE_PUBLISHABLE_KEY) " +
        "in the environment — on Vercel: Project → Settings → Environment " +
        "Variables, scoped to Production and Preview."
    );
  }
  return key;
}
