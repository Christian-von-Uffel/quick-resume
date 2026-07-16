import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client. Uses the publishable key: row-level security
// governs everything it can touch, so it is safe in the bundle.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  );
}
