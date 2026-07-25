/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // There are no passwords in this product, so there is nothing to reset or
  // forget. These paths exist only to catch old bookmarks and stale links and
  // put people back on the one flow that works.
  async redirects() {
    return [
      { source: "/reset-password", destination: "/login", permanent: false },
      { source: "/forgot-password", destination: "/login", permanent: false },
    ];
  },
};

export default nextConfig;
