import { useEffect } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { RequireAuth } from "@/routes/RequireAuth";
import { Dashboard } from "@/routes/Dashboard";

// Root route handler. Invite and recovery emails from Supabase Auth land on
// site_url (= `/` for us) with query or hash params that identify the flow:
//
//   - PKCE invite:    /?code=<pkce>&type=invite
//   - PKCE recovery:  /?code=<pkce>&type=recovery
//   - Implicit tokens: /#access_token=<jwt>&refresh_token=<jwt>&type=<type>
//
// /accept-invite is where we exchange the code and prompt for a password,
// but the email link has no way to know that path. We catch the params here
// and redirect with everything preserved.
//
// For normal (no-params) navigation, wrap Dashboard in RequireAuth like before.
export function RootHandler() {
  const location = useLocation();
  const navigate = useNavigate();

  // Read both search and hash in case it's implicit flow (hash) or PKCE (query).
  const search = location.search || "";
  const hash = location.hash || "";
  const combined = `${search} ${hash}`;

  const isInviteOrRecovery =
    /type=(invite|recovery|magiclink|signup|email_change|reauthentication)/.test(combined) ||
    /[?&#]code=/.test(combined);

  useEffect(() => {
    if (isInviteOrRecovery) {
      // Preserve all params (both query + hash) when redirecting.
      navigate(`/accept-invite${search}${hash}`, { replace: true });
    }
  }, [isInviteOrRecovery, search, hash, navigate]);

  if (isInviteOrRecovery) {
    // Render a placeholder while the redirect resolves — useEffect fires after
    // first paint, so without this we'd briefly mount Dashboard → RequireAuth
    // → redirect-to-sign-in before useEffect catches up.
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-ink-muted">Redirecting…</p>
      </div>
    );
  }

  return (
    <RequireAuth>
      <Dashboard />
    </RequireAuth>
  );
}

// Preserved for symmetry — some callers may want a "just navigate to /" fallback.
export const RootRedirect = () => <Navigate to="/" replace />;
