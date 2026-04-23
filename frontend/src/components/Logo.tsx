import { useTheme } from "@/context/ThemeContext";

// Invenio brand assets live in frontend/public/brand/ (copied from
// InvenioStyle). The lockup includes the wordmark; the mark is just the
// gradient square. Both have -dark variants tuned for the dark palette.

type Props = {
  variant?: "mark" | "lockup";
  className?: string;
  /** px — for the square mark; lockup auto-sizes by height */
  size?: number;
};

export function Logo({ variant = "mark", className, size = 28 }: Props) {
  const { effective } = useTheme();
  const suffix = effective === "dark" ? "-dark" : "";
  const src = `/brand/invenio-${variant}${suffix}.svg`;
  const dim =
    variant === "mark"
      ? { width: size, height: size }
      : { height: size }; // lockup aspect 260x64 ≈ 4.06
  return (
    <img
      src={src}
      alt="Invenio"
      className={className}
      style={dim}
      draggable={false}
    />
  );
}
