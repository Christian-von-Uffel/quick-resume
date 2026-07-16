import { createClient } from "@supabase/supabase-js";

// Server-only Supabase client on the secret key: bypasses row-level security.
// Reserved for writes users must never be able to fake (subscription mirroring,
// usage recording) and reads that span users. Never import from client code.
let adminClient = null;

export function getSupabaseAdmin() {
  if (!adminClient) {
    adminClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return adminClient;
}
