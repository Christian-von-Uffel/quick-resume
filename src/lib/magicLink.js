// Pure helpers for the passwordless sign-in flow. Kept free of React and of
// the Supabase client so the URL parsing and the user-facing copy can be
// tested directly.

// The email-link types this app can verify. Supabase names the token type
// after the template that sent it: a brand-new account gets the "Confirm
// signup" template (type=signup), an existing one gets "Magic Link"
// (type=magiclink). "email" and "invite" are accepted so a link minted by the
// dashboard or an older template still works.
const VERIFIABLE_TYPES = new Set(["magiclink", "signup", "email", "invite"]);

// Reads the one-time credential out of a URL query string.
//
// The emailed link points at /login?token_hash=...&type=..., NOT at Supabase's
// default ConfirmationURL. Corporate mail scanners (Microsoft Safe Links and
// friends) fetch every GET link in an incoming message, which would burn a
// single-use token before the human ever clicks. Landing on our own page and
// POSTing the hash from there means the scanner's GET is inert.
export function readVerification(searchLike) {
  const params =
    typeof searchLike === "string"
      ? new URLSearchParams(searchLike)
      : searchLike;
  if (!params) return null;

  const tokenHash = params.get("token_hash");
  if (!tokenHash) return null;

  const type = params.get("type") || "magiclink";
  if (!VERIFIABLE_TYPES.has(type)) return null;

  return { tokenHash, type };
}

// Strips the one-time credential from a query string, preserving everything
// else. Used to clean the address bar the moment the token has been read, so a
// refresh doesn't replay a spent token and the hash never leaks through a
// Referer header.
export function withoutVerification(searchLike) {
  const params =
    typeof searchLike === "string"
      ? new URLSearchParams(searchLike)
      : new URLSearchParams(searchLike ?? "");
  params.delete("token_hash");
  params.delete("type");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

// Next hands a page's search params in as an object whose values are either a
// string or an array of them. Flattening to a query string once, in the server
// component, means the client half reads the same URL the server rendered
// against — no window-vs-server divergence on first paint.
export function toQueryString(searchParams) {
  const pairs = Object.entries(searchParams ?? {}).flatMap(([key, value]) => {
    if (value == null) return [];
    return Array.isArray(value)
      ? value.map((item) => [key, String(item)])
      : [[key, String(value)]];
  });
  return new URLSearchParams(pairs).toString();
}

const codeOf = (error) => error?.code ?? error?.error_code ?? "";
const messageOf = (error) => error?.message ?? "";

// True when Supabase is telling us "that email has no account". This is the
// answer to signInWithOtp({ shouldCreateUser: false }) for an unknown address:
// GoTrue refuses to create the user and reports signups as disabled.
export function isUnknownAccountError(error) {
  return (
    codeOf(error) === "otp_disabled" ||
    codeOf(error) === "signup_disabled" ||
    /signups? not allowed/i.test(messageOf(error))
  );
}

function isRateLimited(error) {
  return (
    error?.status === 429 ||
    codeOf(error) === "over_email_send_rate_limit" ||
    codeOf(error) === "over_request_rate_limit" ||
    /rate limit|too many requests|only request this after/i.test(messageOf(error))
  );
}

// Copy for a failed link request. `mode` is "login" or "signup" — the only
// place the two halves of the flow genuinely differ, because a typo on the
// login form must not silently create an account.
export function describeRequestError(error, mode) {
  if (!error) return "";

  if (isRateLimited(error)) {
    return "Too many sign-in links requested. Wait a minute, then try again.";
  }

  if (isUnknownAccountError(error)) {
    return mode === "signup"
      ? "We couldn't create an account for that address. Check the spelling and try again."
      : "We couldn't find an account for that email.";
  }

  if (/invalid|email/i.test(messageOf(error)) && error?.status === 400) {
    return "That doesn't look like a valid email address.";
  }

  return "We couldn't send the link. Check the address and try again.";
}

// Copy for a failed verification. Nearly always an expired or already-used
// link — the single-use token is the whole credential, so the recovery is
// simply to send a fresh one.
export function describeVerifyError(error) {
  if (!error) return "";

  if (isRateLimited(error)) {
    return "Too many attempts. Wait a minute, then request a new link.";
  }

  if (
    codeOf(error) === "otp_expired" ||
    /expired|invalid/i.test(messageOf(error))
  ) {
    return "That sign-in link has expired or was already used. Send yourself a new one.";
  }

  return "We couldn't complete that sign-in. Send yourself a new link.";
}
