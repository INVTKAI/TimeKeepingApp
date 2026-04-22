import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

// Claims injected by the custom access-token hook (backend §4.2).
type AppClaims = {
  tenantId: string | null;
  appRole: "admin" | "submitter" | null;
  username: string | null;
};

type AuthState = {
  loading: boolean;
  session: Session | null;
  user: User | null;
  claims: AppClaims;
};

type AuthContextValue = AuthState & {
  signOut: () => Promise<void>;
};

function decodeClaims(session: Session | null): AppClaims {
  if (!session?.access_token) {
    return { tenantId: null, appRole: null, username: null };
  }
  try {
    const parts = session.access_token.split(".");
    if (parts.length !== 3) return { tenantId: null, appRole: null, username: null };
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(b64)) as Record<string, unknown>;
    return {
      tenantId: typeof payload.tenant_id === "string" ? payload.tenant_id : null,
      appRole:
        payload.app_role === "admin" || payload.app_role === "submitter"
          ? payload.app_role
          : null,
      username: typeof payload.username === "string" ? payload.username : null,
    };
  } catch {
    return { tenantId: null, appRole: null, username: null };
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    loading: true,
    session: null,
    user: null,
    claims: { tenantId: null, appRole: null, username: null },
  });

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setState({
        loading: false,
        session: data.session,
        user: data.session?.user ?? null,
        claims: decodeClaims(data.session),
      });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({
        loading: false,
        session,
        user: session?.user ?? null,
        claims: decodeClaims(session),
      });
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signOut: async () => {
        await supabase.auth.signOut();
      },
    }),
    [state],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used within <AuthProvider>");
  return v;
}
