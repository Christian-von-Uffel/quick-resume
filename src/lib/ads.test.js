import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ads.js reads its ids at module load, so every case re-imports the module with
// the env it wants. No jsdom in this project, so window/document are faked to
// just the surface the module actually touches.

function installBrowser({ search = "", protocol = "https:", cookie = "" } = {}) {
  const store = new Map();
  let cookieJar = cookie;
  const calls = [];

  globalThis.window = {
    location: { search, protocol },
    gtag: (...args) => calls.push(args),
    sessionStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
  };

  globalThis.document = {
    get cookie() {
      return cookieJar;
    },
    set cookie(value) {
      // Good enough for these tests: keep the name=value pair, drop attributes.
      const pair = value.split(";")[0];
      cookieJar = cookieJar ? `${cookieJar}; ${pair}` : pair;
    },
  };

  return { calls, readCookie: () => cookieJar };
}

async function loadAds({ id = "AW-123", signupLabel = "sigLabel" } = {}) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", id);
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_SIGNUP_LABEL", signupLabel);
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_TRIAL_LABEL", "trialLabel");
  return import("./ads");
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete globalThis.window;
  delete globalThis.document;
});

describe("reportConversion", () => {
  let browser;

  beforeEach(() => {
    browser = installBrowser();
  });

  it("sends the configured conversion", async () => {
    const { reportConversion } = await loadAds();
    reportConversion("signup_requested");

    expect(browser.calls).toEqual([
      ["event", "conversion", { send_to: "AW-123/sigLabel" }],
    ]);
  });

  it("attaches a value when one is given", async () => {
    const { reportConversion } = await loadAds();
    reportConversion("trial_started", { value: 20 });

    expect(browser.calls[0][2]).toEqual({
      send_to: "AW-123/trialLabel",
      value: 20,
      currency: "USD",
    });
  });

  // TrialGate fires from a polling effect that legitimately re-runs, so the
  // dedupe is the thing standing between one trial and five reported ones.
  it("sends a once-keyed conversion exactly once", async () => {
    const { reportConversion } = await loadAds();
    reportConversion("trial_started", { once: "trial_started" });
    reportConversion("trial_started", { once: "trial_started" });
    reportConversion("trial_started", { once: "trial_started" });

    expect(browser.calls).toHaveLength(1);
  });

  it("does nothing when no ads id is configured", async () => {
    const { reportConversion } = await loadAds({ id: "" });
    reportConversion("signup_requested");

    expect(browser.calls).toHaveLength(0);
  });

  it("does nothing when that conversion has no label yet", async () => {
    const { reportConversion } = await loadAds({ signupLabel: "" });
    reportConversion("signup_requested");

    expect(browser.calls).toHaveLength(0);
  });

  it("survives gtag being blocked", async () => {
    const { reportConversion } = await loadAds();
    delete globalThis.window.gtag;

    expect(() => reportConversion("signup_requested")).not.toThrow();
  });
});

describe("gclid capture", () => {
  it("stores a click id from the landing URL and reads it back", async () => {
    const browser = installBrowser({ search: "?gclid=Test_Click-123&utm_source=google" });
    const { captureGclid, readGclid } = await loadAds();

    captureGclid();

    expect(browser.readCookie()).toContain("1resume_gclid=Test_Click-123");
    expect(readGclid()).toBe("Test_Click-123");
  });

  it("ignores anything that isn't a plausible click id", async () => {
    const browser = installBrowser({ search: "?gclid=" + encodeURIComponent("a; Path=/; evil=1") });
    const { captureGclid } = await loadAds();

    captureGclid();

    expect(browser.readCookie()).toBe("");
  });

  it("does nothing when there is no gclid on the URL", async () => {
    const browser = installBrowser({ search: "?utm_source=google" });
    const { captureGclid } = await loadAds();

    captureGclid();

    expect(browser.readCookie()).toBe("");
  });

  it("reads back nothing when no click id was stored", async () => {
    installBrowser({ cookie: "theme=dark" });
    const { readGclid } = await loadAds();

    expect(readGclid()).toBeNull();
  });
});
