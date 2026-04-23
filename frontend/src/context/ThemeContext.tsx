import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// Theme preference. "system" follows the OS; "light" / "dark" override it.
// Stored in localStorage under STORAGE_KEY so the choice survives reloads
// but stays per-browser (not per-user) — the bootstrap is sync, inlined by
// a tiny IIFE in index.html to avoid a light-mode flash on first paint.
export type ThemePref = "system" | "light" | "dark";

const STORAGE_KEY = "invenio.theme";

type ThemeContextValue = {
  pref: ThemePref;
  effective: "light" | "dark";
  setPref: (p: ThemePref) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredPref(): ThemePref {
  if (typeof window === "undefined") return "system";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyThemeAttr(effective: "light" | "dark") {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", effective);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => readStoredPref());
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  // Watch the OS preference in case the user flips it while the tab is open.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const effective: "light" | "dark" = useMemo(() => {
    if (pref === "light") return "light";
    if (pref === "dark") return "dark";
    return systemDark ? "dark" : "light";
  }, [pref, systemDark]);

  useEffect(() => {
    applyThemeAttr(effective);
  }, [effective]);

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // private-mode / storage-denied — the in-memory state still wins.
    }
  }, []);

  const toggle = useCallback(() => {
    // Pragmatic toggle: flip between light + dark explicitly. "system" is
    // only selectable via a future menu; the sidebar button is a two-way.
    setPref(effective === "dark" ? "light" : "dark");
  }, [effective, setPref]);

  const value = useMemo<ThemeContextValue>(
    () => ({ pref, effective, setPref, toggle }),
    [pref, effective, setPref, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme must be used within <ThemeProvider>");
  return v;
}
