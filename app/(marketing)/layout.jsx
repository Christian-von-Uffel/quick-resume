import Script from "next/script";
import "./landing.css";

export const metadata = {
  metadataBase: new URL("https://1Resume.app"),
  title: "1Resume — One resume. Tailored for every job.",
  description:
    "Write about your experience once. 1Resume reads every job description and builds a tailored, ATS-ready resume from your story.",
  openGraph: {
    type: "website",
    url: "https://1Resume.app/",
    title: "1Resume — One resume. Tailored for every job.",
    description:
      "Write about your experience once. 1Resume reads every job description and builds a tailored, ATS-ready resume from your story.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "1Resume — The last resume you'll ever write",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function MarketingLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
        {/* Scroll reveal, nav shadow, FAQ accordion, and the two product demos. */}
        <Script src="/landing.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
