import { describe, expect, it } from "vitest";
import {
  destinationFor,
  intentToUserMetadata,
  readIntent,
  safeNextPath,
} from "./authIntent";

describe("safeNextPath", () => {
  it("keeps an ordinary in-app path", () => {
    expect(safeNextPath("/app/lab")).toBe("/app/lab");
    expect(safeNextPath("/app?checkout=success")).toBe("/app?checkout=success");
  });

  it("refuses a protocol-relative path, which browsers read as another origin", () => {
    expect(safeNextPath("//evil.example/app")).toBe("/app");
  });

  it("refuses an absolute URL", () => {
    expect(safeNextPath("https://evil.example")).toBe("/app");
  });

  it("refuses the backslash variants browsers have been talked into normalizing", () => {
    expect(safeNextPath("/\\evil.example")).toBe("/app");
    expect(safeNextPath("/app\\@evil.example")).toBe("/app");
  });

  it("refuses control characters and whitespace smuggled into the path", () => {
    expect(safeNextPath("/\u0000//evil.example")).toBe("/app");
    expect(safeNextPath("/app /x")).toBe("/app");
  });

  it("falls back for anything that isn't a string", () => {
    expect(safeNextPath(undefined)).toBe("/app");
    expect(safeNextPath({ next: "/app" })).toBe("/app");
  });

  it("honors a caller-supplied fallback", () => {
    expect(safeNextPath("https://evil.example", "")).toBe("");
  });
});

describe("readIntent", () => {
  it("picks up the path the middleware bounced", () => {
    expect(readIntent("next=%2Fapp%2Flab")).toEqual({ next: "/app/lab" });
  });

  it("turns a Stripe return marker into a destination", () => {
    expect(readIntent("checkout=success")).toEqual({
      next: "/app?checkout=success",
    });
  });

  it("prefers an explicit next over the checkout marker", () => {
    expect(readIntent("next=%2Fapp%2Flab&checkout=success")).toEqual({
      next: "/app/lab",
    });
  });

  it("drops a hostile next instead of carrying it forward", () => {
    expect(readIntent("next=https%3A%2F%2Fevil.example")).toEqual({});
  });

  it("returns nothing for a plain visit", () => {
    expect(readIntent("")).toEqual({});
  });
});

describe("intentToUserMetadata", () => {
  it("namespaces the intent so it reads as a one-shot instruction", () => {
    expect(intentToUserMetadata({ next: "/app/lab" })).toEqual({
      pending_intent: { next: "/app/lab" },
    });
  });

  it("sends nothing when there is nothing to carry", () => {
    expect(intentToUserMetadata({})).toBeUndefined();
    expect(intentToUserMetadata(undefined)).toBeUndefined();
  });
});

describe("destinationFor", () => {
  const user = (pendingIntent) => ({
    user_metadata: pendingIntent ? { pending_intent: pendingIntent } : {},
  });

  it("uses the metadata copy — the one that survives opening the link on a phone", () => {
    expect(
      destinationFor({
        user: user({ next: "/app/lab" }),
        storedIntent: { next: "/app" },
      })
    ).toBe("/app/lab");
  });

  it("falls back to this device's copy for a returning user", () => {
    expect(
      destinationFor({ user: user(null), storedIntent: { next: "/app/lab" } })
    ).toBe("/app/lab");
  });

  it("lands in the app when nothing was carried", () => {
    expect(destinationFor({ user: user(null) })).toBe("/app");
    expect(destinationFor({})).toBe("/app");
  });

  it("re-validates metadata, which the user can write themselves", () => {
    expect(destinationFor({ user: user({ next: "https://evil.example" }) })).toBe(
      "/app"
    );
  });
});
