import { createClient } from "../supabase/server";

// Resolves the signed-in user for an API route, or null. getUser() validates
// the token against Supabase rather than trusting the cookie contents.
export async function getRequestUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
}

// Standard 401 body shared by every guarded route.
export function unauthorizedResponse() {
  return Response.json(
    { error: "Sign in to use this feature." },
    { status: 401 }
  );
}
