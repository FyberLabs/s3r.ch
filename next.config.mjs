/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  serverExternalPackages: [
    "gun",
    "gun/sea",
    "gun/sea.js",
    "gun/lib/webrtc",
    // Keep faker and core unbundled so lib/faker-v7-compat.ts patches the
    // same Node singleton @farcaster/core require()s. Turbopack otherwise
    // inlines faker into the app chunk and core loads an unpatched copy
    // (next build: Failed to collect /api/outbound).
    "@faker-js/faker",
    "@farcaster/core",
  ],
  async redirects() {
    return [
      { source: "/design", destination: "/", permanent: false },
    ];
  },
};

export default nextConfig;
