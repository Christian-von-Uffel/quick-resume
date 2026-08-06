// Google Ads conversion reporting.
//
// The hard part here is not the tag, it's *when* the conversion happens. Signup
// is a magic link, so the sequence is: click the ad, ask for a link, leave for
// an inbox, come back — often on a different device, hours later. The gclid
// that identifies the ad click lives in the tab that made the request, and by
// the time the trial actually starts that tab is usually gone.
//
// So the two conversions are deliberately unequal:
//
//   signup_requested — fires in the same session as the ad click, so Google can
//     always attribute it. This is the one the campaign bids on.
//   trial_started    — fires after the email hop, so attribution is partial by
//     construction. Reported for observation only; Stripe is the real number.
//
// captureGclid() below stores the click id in a first-party cookie so the gap
// can be closed properly later, by uploading offline conversions from the
// Stripe webhook once a trial converts to paid.

const ADS_ID = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID;

// Conversion labels are minted per conversion action in the Google Ads UI, so
// they are configuration, not constants. Missing labels make the corresponding
// call a no-op rather than an error — a half-configured deploy should not throw
// in the middle of someone's signup.
const LABELS = {
  signup_requested: process.env.NEXT_PUBLIC_GOOGLE_ADS_SIGNUP_LABEL,
  trial_started: process.env.NEXT_PUBLIC_GOOGLE_ADS_TRIAL_LABEL,
};

const GCLID_COOKIE = "1resume_gclid";
const GCLID_MAX_AGE_DAYS = 90;

export function adsEnabled() {
  return Boolean(ADS_ID);
}

export function adsId() {
  return ADS_ID;
}

// Fire-and-forget, like the product metrics in src/lib/metrics.js: analytics
// must never be able to break the flow it is measuring.
export function reportConversion(name, { value, currency = "USD", once } = {}) {
  try {
    if (typeof window === "undefined") return;
    if (!ADS_ID) return;

    const label = LABELS[name];
    if (!label) return;

    // Several of these fire from polling effects that legitimately re-run.
    // Deduping here keeps the call sites from each inventing their own guard.
    if (once && alreadySent(once)) return;

    const gtag = window.gtag;
    if (typeof gtag !== "function") return;

    const payload = { send_to: `${ADS_ID}/${label}` };
    if (typeof value === "number") {
      payload.value = value;
      payload.currency = currency;
    }

    gtag("event", "conversion", payload);
    if (once) markSent(once);
  } catch {
    // Nothing a visitor can act on.
  }
}

/* ── click attribution ───────────────────────────────────────────────────── */

// Read the gclid off the landing URL and keep it. Google appends it to the ad's
// destination; it is the only durable link between a visit and the click that
// paid for it.
export function captureGclid() {
  try {
    if (typeof window === "undefined") return;
    const gclid = new URLSearchParams(window.location.search).get("gclid");
    if (!gclid) return;
    // Conservative: a gclid is an opaque URL-safe token, and this value is
    // echoed back into a cookie, so reject anything that isn't one.
    if (!/^[\w-]{1,200}$/.test(gclid)) return;

    const maxAge = GCLID_MAX_AGE_DAYS * 24 * 60 * 60;
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${GCLID_COOKIE}=${gclid}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // Cookies can be blocked outright; attribution is best-effort.
  }
}

export function readGclid() {
  try {
    if (typeof document === "undefined") return null;
    const match = document.cookie.match(
      new RegExp(`(?:^|; )${GCLID_COOKIE}=([^;]*)`)
    );
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/* ── one-shot bookkeeping ────────────────────────────────────────────────── */

function alreadySent(key) {
  try {
    return window.sessionStorage.getItem(`1resume:conv:${key}`) === "1";
  } catch {
    // Storage blocked: better a possible duplicate than a missed conversion.
    return false;
  }
}

function markSent(key) {
  try {
    window.sessionStorage.setItem(`1resume:conv:${key}`, "1");
  } catch {
    // Non-fatal.
  }
}
