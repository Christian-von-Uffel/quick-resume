import { afterEach, describe, expect, it, vi } from "vitest";

const NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
];

// Reloads config.js against a controlled env. vi.stubEnv is used (not a
// process.env reassignment) because Vitest — like Next's browser bundle —
// statically inlines process.env.NEXT_PUBLIC_* at transform time; stubEnv is
// the supported way to override those inlined reads. Every relevant name is
// cleared first so a real .env.local value can't leak into a scenario.
async function loadConfig(env) {
  vi.resetModules();
  for (const name of NAMES) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import("./config.js");
}

const URL_A = "https://prefixed.supabase.co";
const URL_B = "https://unprefixed.supabase.co";
const KEY_A = "publishable_prefixed";
const KEY_B = "publishable_unprefixed";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("supabase config resolver", () => {
  it("resolves from the NEXT_PUBLIC_ names alone — the production repro where the unprefixed pair was never set on Vercel", async () => {
    const { getSupabaseUrl, getSupabasePublishableKey } = await loadConfig({
      NEXT_PUBLIC_SUPABASE_URL: URL_A,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: KEY_A,
    });
    expect(getSupabaseUrl()).toBe(URL_A);
    expect(getSupabasePublishableKey()).toBe(KEY_A);
  });

  it("resolves from the unprefixed names alone", async () => {
    const { getSupabaseUrl, getSupabasePublishableKey } = await loadConfig({
      SUPABASE_URL: URL_B,
      SUPABASE_PUBLISHABLE_KEY: KEY_B,
    });
    expect(getSupabaseUrl()).toBe(URL_B);
    expect(getSupabasePublishableKey()).toBe(KEY_B);
  });

  it("prefers NEXT_PUBLIC_ when both conventions are present", async () => {
    const { getSupabaseUrl, getSupabasePublishableKey } = await loadConfig({
      NEXT_PUBLIC_SUPABASE_URL: URL_A,
      SUPABASE_URL: URL_B,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: KEY_A,
      SUPABASE_PUBLISHABLE_KEY: KEY_B,
    });
    expect(getSupabaseUrl()).toBe(URL_A);
    expect(getSupabasePublishableKey()).toBe(KEY_A);
  });

  it("throws a var-naming error instead of crashing opaquely when the URL is absent", async () => {
    const { getSupabaseUrl } = await loadConfig({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: KEY_A,
    });
    expect(() => getSupabaseUrl()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("throws a var-naming error when the publishable key is absent", async () => {
    const { getSupabasePublishableKey } = await loadConfig({
      NEXT_PUBLIC_SUPABASE_URL: URL_A,
    });
    expect(() => getSupabasePublishableKey()).toThrow(
      /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/
    );
  });
});
