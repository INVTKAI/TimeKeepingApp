import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/context/AuthContext";
import { AppShell } from "@/components/AppShell";

type Props = {
  children: ReactNode;
  role?: "admin" | "submitter";
  /** Opt out of the sidebar shell (e.g. full-bleed editors). */
  bare?: boolean;
};

export function RequireAuth({ children, role, bare }: Props) {
  const { loading, session, claims } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-ink-muted">Loading session…</p>
      </div>
    );
  }

  if (!session || !claims.tenantId) {
    return <Navigate to="/sign-in" state={{ from: location }} replace />;
  }

  if (role && claims.appRole !== role) {
    const unauthorized = (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="invenio-card max-w-md">
          <h1 className="text-xl font-semibold mb-2">Not authorized</h1>
          <p className="text-ink-muted">
            This page requires the <span className="font-mono">{role}</span> role.
            Your account has <span className="font-mono">{claims.appRole ?? "none"}</span>.
          </p>
        </div>
      </div>
    );
    return bare ? unauthorized : <AppShell>{unauthorized}</AppShell>;
  }

  return bare ? <>{children}</> : <AppShell>{children}</AppShell>;
}
