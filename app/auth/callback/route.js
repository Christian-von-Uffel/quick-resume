import { NextResponse } from "next/server";
import { createClient } from "../../../src/lib/supabase/server";

// Legacy landing pad. Nothing this product emails points here any more — the
// sign-in link goes to /login?token_hash=... and is verified by an explicit
// POST from the browser. This route stays so links that were already sitting
// in inboxes when the passwordless flow shipped still work.
//
// A `token_hash` link is forwarded rather than verified here: verifying on a
// GET is exactly what lets a mail scanner spend the token before the human
// clicks it.
export async function GET(request) {
  const { searchParams, origin } = new URL(request.url);

  const tokenHash = searchParams.get("token_hash");
  if (tokenHash) {
    const forwarded = new URLSearchParams({
      token_hash: tokenHash,
      type: searchParams.get("type") ?? "magiclink",
    });
    return NextResponse.redirect(`${origin}/login?${forwarded}`);
  }

  const code = searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/app`);
  }

  return NextResponse.redirect(`${origin}/login?error=confirmation`);
}
