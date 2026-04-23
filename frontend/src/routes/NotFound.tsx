import { Link, useLocation } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";

// Rendered for unknown paths. Inside the shell (via RequireAuth) so signed-in
// users still see the sidebar; unauthed users get bounced to /sign-in by
// RequireAuth before they ever see this.
export function NotFound() {
  const location = useLocation();
  return (
    <div className="invenio-page">
      <PageHeader
        title="Page not found"
        subtitle={
          <>
            Nothing at <span className="font-mono">{location.pathname}</span>.
          </>
        }
      />
      <div className="invenio-card">
        <p className="text-sm text-ink-muted mb-4">
          The page you followed may have been moved, or the link is stale.
        </p>
        <div className="flex gap-2">
          <Link to="/" className="invenio-btn-primary">
            Back to dashboard
          </Link>
          <Link to="/my-timesheets" className="invenio-btn-secondary">
            My timesheets
          </Link>
        </div>
      </div>
    </div>
  );
}
