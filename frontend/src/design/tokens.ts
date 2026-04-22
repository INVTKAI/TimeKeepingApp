// Invenio design tokens — web-only adaptation of the InvenioStyle repo
// (https://github.com/TomEnglish/InvenioStyle). Source of truth in this repo.
//
// Tailwind's config (tailwind.config.ts) duplicates these values because it
// can't import this module at build time. Keep them in sync — if you add or
// change a token here, update the corresponding key in tailwind.config.ts.
//
// Use this module at runtime (e.g. for inline styles, canvas drawing, or
// framework-agnostic components). Prefer Tailwind utility classes for
// component styling.

export const colors = {
  canvas: "#F8FAFC",
  surface: "#FFFFFF",
  raised: "#F1F5F9",

  border: "#E2E8F0",
  borderStrong: "#CBD5E1",

  textPrimary: "#1E293B",
  textMuted: "#64748B",
  textSubtle: "#94A3B8",
  textInverse: "#FFFFFF",

  brandPrimary: "#0369A1",
  brandPrimaryHover: "#075985",
  brandPrimaryPressed: "#CDE9FB",
  brandPrimarySoft: "#E0F2FE",
  brandAccent: "#0891B2",
  brandAccentSoft: "#CFFAFE",

  success: "#059669",
  successSoft: "#D1FAE5",
  successDeep: "#166534",
  warn: "#D97706",
  warnSoft: "#FEF3C7",
  warnDeep: "#92400E",
  danger: "#DC2626",
  dangerHover: "#B91C1C",
  dangerSoft: "#FEE2E2",
  dangerDeep: "#991B1B",
  info: "#7C3AED",
  infoSoft: "#EDE9FE",

  overlay: "rgba(15, 23, 42, 0.45)",
} as const;

export const colorsDark = {
  canvas: "#0B1220",
  surface: "#111A2E",
  raised: "#1A2744",

  border: "#334155",
  borderStrong: "#475569",

  textPrimary: "#F1F5F9",
  textMuted: "#94A3B8",
  textSubtle: "#64748B",
  textInverse: "#0B1220",

  brandPrimary: "#22D3EE",
  brandPrimaryHover: "#67E8F9",
  brandPrimaryPressed: "rgba(34,211,238,0.28)",
  brandPrimarySoft: "rgba(34,211,238,0.14)",
  brandAccent: "#0891B2",
  brandAccentSoft: "rgba(8,145,178,0.18)",

  success: "#10B981",
  successSoft: "rgba(16,185,129,0.15)",
  successDeep: "#6EE7B7",
  warn: "#F59E0B",
  warnSoft: "rgba(245,158,11,0.15)",
  warnDeep: "#FCD34D",
  danger: "#EF4444",
  dangerHover: "#DC2626",
  dangerSoft: "rgba(239,68,68,0.15)",
  dangerDeep: "#FCA5A5",
  info: "#8B5CF6",
  infoSoft: "rgba(139,92,246,0.15)",

  overlay: "rgba(0, 0, 0, 0.6)",
} as const;

export const fontFamily = {
  base: "Inter, system-ui, -apple-system, sans-serif",
  mono: "JetBrains Mono, ui-monospace, Menlo, monospace",
} as const;

export const fontSize = {
  xs: 12,
  sm: 13,
  body: 14,
  md: 16,
  lg: 20,
  xl: 24,
  h2: 32,
  h1: 48,
} as const;

export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  pill: 999,
} as const;

export const motion = {
  duration: { fast: 120, standard: 180, slow: 260 },
  easing: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    emphasized: "cubic-bezier(0.3, 0, 0, 1.2)",
  },
} as const;

export const touchTarget = 44;

export const tokens = {
  color: colors,
  colorDark: colorsDark,
  fontFamily,
  fontSize,
  space,
  radius,
  motion,
  touchTarget,
} as const;

export default tokens;
