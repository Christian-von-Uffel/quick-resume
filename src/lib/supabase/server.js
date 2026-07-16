import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Supabase client for server components and route handlers, backed by the
// session cookies. Still the publishable key: requests act as the signed-in
// user under row-level security, never as an admin.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a server component, where cookies are read-only.
            // Safe to ignore: middleware handles session refresh.
          }
        },
      },
    }
  );
}
