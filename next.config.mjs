/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["gun"],
  async redirects() {
    return [
      { source: "/design", destination: "/", permanent: false },
    ];
  },
};

export default nextConfig;
