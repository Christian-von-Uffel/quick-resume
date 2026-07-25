import MagicLinkAuth from "../../../src/components/MagicLinkAuth";
import { toQueryString } from "../../../src/lib/magicLink";

// Signing up is the same act as signing in — one email field, one link — with
// the single difference that an unknown address here creates the account.
// The emailed link lands on /login, which is where verification lives.
export default async function SignupPage({ searchParams }) {
  const params = await searchParams;
  return <MagicLinkAuth mode="signup" query={toQueryString(params)} />;
}
