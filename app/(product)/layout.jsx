import "../../src/index.css";

export const metadata = {
  metadataBase: new URL("https://1Resume.app"),
  title: "One Resume",
  description:
    "Write about your experience once. 1Resume reads every job description and builds a tailored, ATS-ready resume from your story.",
  openGraph: {
    type: "website",
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

// Runs before first paint to avoid a light-to-dark flash. Light mode is the
// default; only opt into dark when explicitly saved.
const themeScript = `
if (localStorage.getItem("theme") === "dark") {
  document.documentElement.classList.add("dark");
}
`;

export default function ProductLayout({ children }) {
  return (
    // suppressHydrationWarning: the theme script below sets the `dark` class
    // on <html> before React hydrates, which React would otherwise report as
    // a server/client mismatch.
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-neutral-900">
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
