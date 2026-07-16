import "../../src/index.css";

export const metadata = {
  title: "One Resume",
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
