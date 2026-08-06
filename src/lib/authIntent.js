// Carries whatever the visitor was trying to do across the email round-trip.
//
// Sign-in now costs an inbox hop, and the link is very often opened somewhere
// else — the phone, a different browser, hours later. Anything held only in
// this tab's memory is gone by then. So the intent travels two ways:
//
//   1. On the auth user's metadata, written at link-request time. Survives the
//      hop to any device, which is the case that actually breaks otherwise:
//      someone clicks "start your trial", signs up, opens the link on their
//      phone, and lands somewhere unrelated.
//   2. In this device's sessionStorage, as the fallback for a returning user —
//      an existing account's metadata isn't rewritten on a login request.
//
// Everything read back out goes through safeNextPath: user metadata is
// user-writable (auth.updateUser), and a query string is anyone-writable, so
// neither is trusted as a redirect target.

const STORAGE_KEY = "1resume:auth-intent";

// Same-origin absolute paths only. Rejects "//evil.example", "https://evil",
// backslash tricks, and anything with control characters or whitespace, all of
// which browsers have historically been willing to read as another origin.
export function safeNextPath(value, fallback = "/app") {
  if (typeof value !== "string") return fallback;

  const path = value.trim();
  if (!path.startsWith("/")) return fallback;
  if (path.startsWith("//") || path.startsWith("/\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s\\]/.test(path)) return fallback;

  return path;
}

// Pulls the intent out of the URL the visitor arrived on. `next` is set by the
// middleware when it bounces a signed-out request, and by any deep link into
// the product. `checkout` is Stripe's return marker, kept so a payer whose
// session lapsed mid-checkout still lands on the activation poll.
export function readIntent(searchLike) {
  const params =
    typeof searchLike === "string"
      ? new URLSearchParams(searchLike)
      : new URLSearchParams(searchLike ?? "");

  const next = params.get("next");
  const checkout = params.get("checkout");

  const intent = {};
  if (next) intent.next = safeNextPath(next, "");
  if (!intent.next && checkout) intent.next = `/app?checkout=${encodeURIComponent(checkout)}`;
  if (!intent.next) delete intent.next;

  return intent;
}

// Shape written to auth.users.raw_user_meta_data at link-request time, via
// signInWithOtp's `data` option. Namespaced under pending_intent so it is
// obvious this is a one-shot instruction and not durable profile data.
//
// `attribution` rides along on the same trip for the same reason the intent
// does: the Google click id is only in the tab that requested the link, and the
// account is created on the far side of an inbox hop. Unlike pending_intent it
// is *not* cleared after sign-in — it is what lets a paid conversion months
// later be reported back to the click that bought it.
export function intentToUserMetadata(intent, attribution) {
  const metadata = {};

  if (intent?.next) metadata.pending_intent = { next: intent.next };
  if (attribution?.gclid) metadata.ad_attribution = { gclid: attribution.gclid };

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

// Where to land after a verified sign-in. Metadata wins: it is the copy that
// survived the email hop, so it reflects what the person asked for even when
// the link opened on a different device.
export function destinationFor({ user, storedIntent } = {}) {
  const fromMetadata = user?.user_metadata?.pending_intent?.next;
  if (fromMetadata) return safeNextPath(fromMetadata);
  if (storedIntent?.next) return safeNextPath(storedIntent.next);
  return "/app";
}

export function hasPendingIntent(user) {
  return Boolean(user?.user_metadata?.pending_intent);
}

/* ── this device's copy ──────────────────────────────────────────────────── */

function storage() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Storage can be blocked outright (Safari private mode, embedded views).
    return null;
  }
}

export function rememberIntent(intent) {
  if (!intent?.next) return;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(intent));
  } catch {
    // Non-fatal: the metadata copy is the one that has to work.
  }
}

export function recallIntent() {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function forgetIntent() {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}
