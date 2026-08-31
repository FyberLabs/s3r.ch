import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0fdf9",
          100: "#ccfbee",
          500: "#14E8B8",
          600: "#7C3AED",
          700: "#6d28d9",
          900: "#0F172A",
        },
      },
    },
  },
  plugins: [],
};

export default config;
