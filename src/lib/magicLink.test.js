import { describe, expect, it } from "vitest";
import {
  describeRequestError,
  describeVerifyError,
  isUnknownAccountError,
  readVerification,
  withoutVerification,
} from "./magicLink";

// The GoTrue error shapes these helpers have to recognize, copied from what
// @supabase/auth-js actually surfaces.
const unknownAccount = {
  code: "otp_disabled",
  message: "Signups not allowed for otp",
  status: 422,
};
const rateLimited = {
  code: "over_email_send_rate_limit",
  message: "For security purposes, you can only request this after 51 seconds.",
  status: 429,
};
const spentLink = {
  code: "otp_expired",
  message: "Email link is invalid or has expired",
  status: 403,
};

describe("readVerification", () => {
  it("reads the token the emailed link carries", () => {
    expect(readVerification("token_hash=abc123&type=magiclink")).toEqual({
      tokenHash: "abc123",
      type: "magiclink",
    });
  });

  it("reads a first-signup link, which Supabase types differently", () => {
    expect(readVerification("token_hash=abc123&type=signup")).toEqual({
      tokenHash: "abc123",
      type: "signup",
    });
  });

  it("defaults a type-less link to magiclink rather than dropping it", () => {
    expect(readVerification("token_hash=abc123")).toEqual({
      tokenHash: "abc123",
      type: "magiclink",
    });
  });

  it("ignores a plain visit to the page", () => {
    expect(readVerification("")).toBeNull();
    expect(readVerification("email=a%40b.com")).toBeNull();
  });

  it("refuses a type it cannot verify, so recovery links can't sneak a session in", () => {
    expect(readVerification("token_hash=abc123&type=recovery")).toBeNull();
  });

  it("accepts a URLSearchParams as well as a string", () => {
    const params = new URLSearchParams({ token_hash: "abc", type: "email" });
    expect(readVerification(params)).toEqual({ tokenHash: "abc", type: "email" });
  });
});

describe("withoutVerification", () => {
  it("drops the single-use credential and keeps the rest of the query", () => {
    expect(withoutVerification("token_hash=abc&type=signup&next=%2Fapp%2Flab")).toBe(
      "?next=%2Fapp%2Flab"
    );
  });

  it("collapses to an empty string when nothing else was there", () => {
    expect(withoutVerification("token_hash=abc&type=magiclink")).toBe("");
  });
});

describe("describeRequestError", () => {
  it("tells a login attempt that the address has no account — the whole point of create_user:false", () => {
    expect(describeRequestError(unknownAccount, "login")).toMatch(
      /couldn't find an account/i
    );
  });

  it("does not claim 'no account' on the signup form, where that reading is nonsense", () => {
    expect(describeRequestError(unknownAccount, "signup")).not.toMatch(
      /couldn't find an account/i
    );
  });

  it("names the rate limit instead of blaming the address", () => {
    expect(describeRequestError(rateLimited, "login")).toMatch(/wait a minute/i);
  });

  it("recognizes a rate limit reported only in prose", () => {
    expect(
      describeRequestError(
        { message: "For security purposes, you can only request this after 51 seconds." },
        "signup"
      )
    ).toMatch(/wait a minute/i);
  });

  it("says nothing when there is no error", () => {
    expect(describeRequestError(null, "login")).toBe("");
  });
});

describe("describeVerifyError", () => {
  it("explains a spent or expired link and points at the fix", () => {
    expect(describeVerifyError(spentLink)).toMatch(/expired or was already used/i);
  });

  it("still offers a new link for an unrecognized failure", () => {
    expect(describeVerifyError({ message: "boom", status: 500 })).toMatch(
      /new link/i
    );
  });
});

describe("isUnknownAccountError", () => {
  it("matches on the message alone, in case the code stops being sent", () => {
    expect(isUnknownAccountError({ message: "Signups not allowed for otp" })).toBe(
      true
    );
  });

  it("does not fire on unrelated failures", () => {
    expect(isUnknownAccountError(rateLimited)).toBe(false);
    expect(isUnknownAccountError(null)).toBe(false);
  });
});
