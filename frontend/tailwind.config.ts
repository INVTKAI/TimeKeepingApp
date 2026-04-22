import type { Config } from "tailwindcss";

// Wired to the InvenioStyle token source of truth at src/design/tokens.ts.
// Hex literals intentionally duplicated here because Tailwind's config is
// evaluated at build time by PostCSS and can't import runtime TS modules.
// Keep these in sync with src/design/tokens.ts (light + dark).

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        canvas: {
          DEFAULT: "#F8FAFC",
          dark: "#0B1220",
        },
        surface: {
          DEFAULT: "#FFFFFF",
          dark: "#111A2E",
        },
        raised: {
          DEFAULT: "#F1F5F9",
          dark: "#1A2744",
        },
        border: {
          DEFAULT: "#E2E8F0",
          strong: "#CBD5E1",
          dark: "#334155",
          darkStrong: "#475569",
        },
        ink: {
          primary: "#1E293B",
          muted: "#64748B",
          subtle: "#94A3B8",
          inverse: "#FFFFFF",
          primaryDark: "#F1F5F9",
          mutedDark: "#94A3B8",
        },
        brand: {
          DEFAULT: "#0369A1",
          hover: "#075985",
          soft: "#E0F2FE",
          pressed: "#CDE9FB",
          accent: "#0891B2",
          accentSoft: "#CFFAFE",
          dark: "#22D3EE",
          darkHover: "#67E8F9",
        },
        success: {
          DEFAULT: "#059669",
          soft: "#D1FAE5",
          deep: "#166534",
        },
        warn: {
          DEFAULT: "#D97706",
          soft: "#FEF3C7",
          deep: "#92400E",
        },
        danger: {
          DEFAULT: "#DC2626",
          hover: "#B91C1C",
          soft: "#FEE2E2",
          deep: "#991B1B",
        },
        info: {
          DEFAULT: "#7C3AED",
          soft: "#EDE9FE",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "Menlo", "monospace"],
      },
      fontSize: {
        xs: ["12px", { lineHeight: "1.5" }],
        sm: ["13px", { lineHeight: "1.5" }],
        body: ["14px", { lineHeight: "1.5" }],
        md: ["16px", { lineHeight: "1.5" }],
        lg: ["20px", { lineHeight: "1.35" }],
        xl: ["24px", { lineHeight: "1.35" }],
        h2: ["32px", { lineHeight: "1.2" }],
        h1: ["48px", { lineHeight: "1.2" }],
      },
      spacing: {
        "0": "0",
        "1": "4px",
        "2": "8px",
        "3": "12px",
        "4": "16px",
        "5": "20px",
        "6": "24px",
        "8": "32px",
        "10": "40px",
        "12": "48px",
        "16": "64px",
      },
      borderRadius: {
        sm: "6px",
        DEFAULT: "8px",
        md: "8px",
        lg: "12px",
        xl: "16px",
        pill: "999px",
      },
      boxShadow: {
        sm: "0 1px 2px rgba(15,23,42,0.05)",
        md: "0 4px 12px rgba(15,23,42,0.08)",
        lg: "0 12px 32px rgba(15,23,42,0.12)",
      },
      transitionDuration: {
        fast: "120ms",
        standard: "180ms",
        slow: "260ms",
      },
      transitionTimingFunction: {
        "invenio-standard": "cubic-bezier(0.2, 0, 0, 1)",
        "invenio-emphasized": "cubic-bezier(0.3, 0, 0, 1.2)",
      },
    },
  },
  plugins: [],
} satisfies Config;
