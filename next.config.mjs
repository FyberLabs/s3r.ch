/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  async redirects() {
    return [
      { source: "/design", destination: "/research", permanent: false },
    ];
  },
};

export default nextConfig;
