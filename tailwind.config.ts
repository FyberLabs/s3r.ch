import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/brand-ui.ts",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "var(--font-recursive)",
          "IBM Plex Sans",
          "ui-sans-serif",
          "sans-serif",
        ],
        mono: [
          "var(--font-recursive)",
          "IBM Plex Mono",
          "ui-monospace",
          "monospace",
        ],
      },
      colors: {
        ground: "var(--ground)",
        ink: "var(--ink)",
        "ink-muted": "var(--ink-muted)",
        signal: "var(--signal)",
        "signal-soft": "var(--signal-soft)",
        "on-signal": "var(--on-signal)",
        rule: "var(--rule)",
        panel: "var(--panel)",
        "panel-strong": "var(--panel-strong)",
        "status-pass": "var(--status-pass)",
        "status-fail": "var(--status-fail)",
      },
    },
  },
  plugins: [],
};

export default config;
