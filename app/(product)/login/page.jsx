import MagicLinkAuth from "../../../src/components/MagicLinkAuth";
import { toQueryString } from "../../../src/lib/magicLink";

// Sign-in, and the landing pad for every emailed link. The link arrives as
// /login?token_hash=...&type=magiclink|signup and is verified by an explicit
// POST from the client — this page's GET deliberately does nothing, so a mail
// scanner that prefetches the link can't spend it.
//
// Reading the params here rather than off `window` keeps the server-rendered
// markup identical to the first client paint.
export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  return <MagicLinkAuth mode="login" query={toQueryString(params)} />;
}
