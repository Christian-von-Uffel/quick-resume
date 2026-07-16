import { readFileSync } from "node:fs";
import path from "node:path";
import { MONTHLY_PRICE, STRIPE_PAYMENT_LINK } from "../../src/lib/constants";

// The landing page is hand-written static HTML (see content/landing-body.html),
// kept verbatim rather than translated to JSX so it stays in lockstep with the
// original design. Rendered at request/build time from that file.
export const dynamic = "force-static";

const landingBodyPath = path.join(process.cwd(), "content", "landing-body.html");

export default function LandingPage() {
  // Read inside the component so Next re-evaluates when this module reloads
  // (editing landing-body.html alone does not invalidate the page module).
  const landingHtml = readFileSync(landingBodyPath, "utf8")
    .replaceAll("{{STRIPE_PAYMENT_LINK}}", STRIPE_PAYMENT_LINK)
    .replaceAll("{{MONTHLY_PRICE}}", String(MONTHLY_PRICE));
  return <div dangerouslySetInnerHTML={{ __html: landingHtml }} />;
}
