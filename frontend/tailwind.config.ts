import type { Config } from "tailwindcss";

// Wired to the InvenioStyle token source of truth at src/design/tokens.ts.
// Tailwind references CSS variables (defined in src/index.css) so that
// [data-theme="dark"] on <html> can flip every utility without touching
// the class names. Hex literals live in tokens.ts (light + dark maps) and
// in index.css (the :root and [data-theme="dark"] blocks). All three must
// agree — if you add a new color here, wire it in both other places.

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        canvas: "var(--color-canvas)",
        surface: "var(--color-surface)",
        raised: "var(--color-raised)",
        border: {
          DEFAULT: "var(--color-border)",
          strong: "var(--color-border-strong)",
        },
        ink: {
          primary: "var(--color-ink-primary)",
          muted: "var(--color-ink-muted)",
          subtle: "var(--color-ink-subtle)",
          inverse: "var(--color-ink-inverse)",
        },
        brand: {
          DEFAULT: "var(--color-brand)",
          hover: "var(--color-brand-hover)",
          soft: "var(--color-brand-soft)",
          pressed: "var(--color-brand-pressed)",
          accent: "var(--color-brand-accent)",
          accentSoft: "var(--color-brand-accent-soft)",
        },
        success: {
          DEFAULT: "var(--color-success)",
          soft: "var(--color-success-soft)",
          deep: "var(--color-success-deep)",
        },
        warn: {
          DEFAULT: "var(--color-warn)",
          soft: "var(--color-warn-soft)",
          deep: "var(--color-warn-deep)",
        },
        danger: {
          DEFAULT: "var(--color-danger)",
          hover: "var(--color-danger-hover)",
          soft: "var(--color-danger-soft)",
          deep: "var(--color-danger-deep)",
        },
        info: {
          DEFAULT: "var(--color-info)",
          soft: "var(--color-info-soft)",
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
