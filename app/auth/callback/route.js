import { NextResponse } from "next/server";
import { createClient } from "../../../src/lib/supabase/server";

// Lands the links Supabase Auth emails out (signup confirmation, password
// reset): exchanges the one-time code for a session cookie, then forwards
// into the app.
export async function GET(request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/app";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next.startsWith("/") ? next : "/app"}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=confirmation`);
}
