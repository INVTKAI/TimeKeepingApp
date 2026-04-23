import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import { Banner, PageHeader } from "@/components/PageHeader";

// Read-only tenant settings surface. Writes to public.tenants aren't exposed
// to authenticated users via RLS — changes happen out-of-band (Supabase
// Dashboard SQL / ops runbook). This page lets admins confirm what's wired
// (email from-address, webhook, timezone, stall thresholds) without SQL.

type Tenant = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  timezone: string;
  locale: string;
  email_from_address: string;
  webhook_url: string | null;
  webhook_signing_secret_ref: string | null;
  stall_hours: number;
  login_max_attempts: number;
  login_lockout_minutes: number;
  created_at: string;
};

export function TenantSettings() {
  const { claims } = useAuth();

  const { data, isLoading, error } = useQuery<Tenant | null>({
    queryKey: ["tenant_self"],
    enabled: !!claims.tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select(
          "id, name, slug, status, timezone, locale, email_from_address, webhook_url, webhook_signing_secret_ref, stall_hours, login_max_attempts, login_lockout_minutes, created_at",
        )
        .eq("id", claims.tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data as Tenant | null;
    },
  });

  if (isLoading) {
    return (
      <div className="invenio-page">
        <p className="text-ink-muted">Loading tenant…</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="invenio-page">
        <Banner kind="error">
          Couldn't load tenant: {error ? String(error) : "no row returned"}
        </Banner>
      </div>
    );
  }

  return (
    <div className="invenio-page">
      <PageHeader
        title="Tenant settings"
        subtitle={
          <>
            {data.name} · <span className="font-mono">{data.slug}</span> · {data.status}
          </>
        }
      />
      <Banner kind="info">
        Read-only. Tenant writes happen out-of-band (Supabase Dashboard SQL /
        ops runbook) — this page lets you confirm what's wired.
      </Banner>

      <section className="invenio-card">
        <h2 className="text-lg font-semibold mb-3">Identity</h2>
        <DlGrid
          rows={[
            ["ID", <span className="font-mono text-xs" key="id">{data.id}</span>],
            ["Display name", data.name],
            ["Slug", <span className="font-mono text-xs" key="slug">{data.slug}</span>],
            ["Status", data.status],
            ["Timezone", <span className="font-mono" key="tz">{data.timezone}</span>],
            ["Locale", <span className="font-mono" key="loc">{data.locale}</span>],
            ["Created", new Date(data.created_at).toLocaleString()],
          ]}
        />
      </section>

      <section className="invenio-card">
        <h2 className="text-lg font-semibold mb-3">Notifications</h2>
        <DlGrid
          rows={[
            [
              "Email from address",
              <span className="font-mono text-xs" key="from">
                {data.email_from_address}
              </span>,
            ],
            [
              "Webhook URL",
              data.webhook_url ? (
                <span className="font-mono text-xs break-all" key="wh">
                  {data.webhook_url}
                </span>
              ) : (
                <span className="text-ink-muted text-sm">not configured</span>
              ),
            ],
            [
              "Webhook signing secret",
              data.webhook_signing_secret_ref ? (
                <span className="text-sm text-success-deep">
                  configured (Vault)
                </span>
              ) : (
                <span className="text-ink-muted text-sm">not configured</span>
              ),
            ],
          ]}
        />
        <p className="text-xs text-ink-muted mt-3">
          Resend SMTP credentials live in Supabase env (RESEND_API_KEY) — not
          stored per-tenant. Verify domain auth at resend.com if outbound mail
          fails.
        </p>
      </section>

      <section className="invenio-card">
        <h2 className="text-lg font-semibold mb-3">Security + stall thresholds</h2>
        <DlGrid
          rows={[
            ["Login max attempts", data.login_max_attempts],
            ["Lockout minutes", data.login_lockout_minutes],
            [
              "Stall hours",
              <>
                {data.stall_hours}{" "}
                <span className="text-ink-muted text-xs">
                  (runs idle this long → stall notification)
                </span>
              </>,
            ],
          ]}
        />
      </section>
    </div>
  );
}

function DlGrid({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(160px,1fr)_3fr] gap-y-2 text-sm">
      {rows.map(([label, value], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-muted">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
