import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import {
  getSupabaseUrl,
  getSupabasePublishableKey,
} from "./src/lib/supabase/config";
import { safeNextPath } from "./src/lib/authIntent";

// Session-refreshing auth gate. The editor is subscriber-only product surface:
// signed-out visitors of /app are sent to /login, and signed-in users have no
// business on the auth pages. API routes are NOT matched here — they return
// 401 JSON themselves (a redirect would hand fetch() an HTML page).
//
// This runs on every matched request, which is also what keeps a session alive
// indefinitely: the access token lasts an hour, and getUser() below spends an
// expired one on a refresh token and writes the rotated pair back as cookies.
export async function middleware(request) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    getSupabaseUrl(),
    getSupabasePublishableKey(),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Also refreshes an expired session — required on every matched request.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isAuthPage = path === "/login" || path === "/signup";
  // An emailed sign-in link lands here carrying its one-time token. It has to
  // reach the page even when a session already exists, or clicking a link for
  // a second account on a device that's already signed in silently does
  // nothing.
  const isVerifying = request.nextUrl.searchParams.has("token_hash");

  if (!user && !isAuthPage) {
    const url = request.nextUrl.clone();
    const wanted = `${path}${request.nextUrl.search}`;
    url.pathname = "/login";
    url.search = "";
    // Sign-in now costs an inbox round-trip, so remember where they were
    // headed — /login hands it back after the link is verified.
    if (wanted !== "/app") url.searchParams.set("next", wanted);
    return NextResponse.redirect(url);
  }

  if (user && isAuthPage && !isVerifying) {
    const wanted = safeNextPath(request.nextUrl.searchParams.get("next"));
    return NextResponse.redirect(new URL(wanted, request.nextUrl.origin));
  }

  return response;
}

export const config = {
  matcher: ["/app/:path*", "/login", "/signup"],
};
