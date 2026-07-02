/** @type {import('tailwindcss').Config} */
const defaultTheme = require("tailwindcss/defaultTheme");

// The `neutral` palette is driven by CSS variables (see src/index.css) so the
// entire UI chrome flips between light (default) and dark themes without
// touching individual class names. Light mode simply mirrors the neutral scale.
const neutralVar = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["InterVariable", "Inter", ...defaultTheme.fontFamily.sans],
      },
      colors: {
        neutral: {
          50: neutralVar("neutral-50"),
          100: neutralVar("neutral-100"),
          200: neutralVar("neutral-200"),
          300: neutralVar("neutral-300"),
          400: neutralVar("neutral-400"),
          500: neutralVar("neutral-500"),
          600: neutralVar("neutral-600"),
          700: neutralVar("neutral-700"),
          800: neutralVar("neutral-800"),
          900: neutralVar("neutral-900"),
          950: neutralVar("neutral-950"),
        },
      },
    },
  },
  plugins: [require("@tailwindcss/forms")],
};
