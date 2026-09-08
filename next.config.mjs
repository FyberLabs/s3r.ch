/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["gun", "gun/sea", "gun/sea.js", "gun/lib/webrtc"],
  async redirects() {
    return [
      { source: "/design", destination: "/", permanent: false },
    ];
  },
};

export default nextConfig;
