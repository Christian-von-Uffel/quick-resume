"use client";

import { useEffect } from "react";
import Script from "next/script";
import { adsId, captureGclid } from "../lib/ads";

// The gtag base tag, plus the gclid capture that has to happen on whatever page
// the ad landed on.
//
// This is rendered by *both* route-group layouts. There is no shared root
// layout — app/(marketing) and app/(product) each render their own <html> — so
// a tag added to only one of them is silently absent on half the site, which is
// exactly the failure that makes conversion numbers quietly wrong rather than
// obviously broken.
//
// With no NEXT_PUBLIC_GOOGLE_ADS_ID set it renders nothing, so dev and preview
// deploys don't report conversions into the live account.
export default function GoogleAdsTag() {
  const id = adsId();

  // Runs on every page, not just the landing page: paid traffic can be sent to
  // any URL, and the cookie write is idempotent.
  useEffect(() => {
    captureGclid();
  }, []);

  if (!id) return null;

  return (
    <>
      <Script
        id="gtag-src"
        src={`https://www.googletagmanager.com/gtag/js?id=${id}`}
        strategy="afterInteractive"
      />
      <Script id="gtag-init" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
window.gtag = gtag;
gtag('js', new Date());
gtag('config', '${id}');`}
      </Script>
    </>
  );
}
