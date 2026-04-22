// drain-notifications — spec §7.6 outbox drainer.
//
// Auth model: shared-secret Bearer header (NOT withAdminContext — this
// function is invoked by pg_cron / internal tooling, never by end users).
// The secret must match NOTIFICATION_DRAIN_SECRET in the function's
// environment. NOT service-role-bearer because a leaked drain secret is
// contained to triggering deliveries, whereas a leaked service-role key
// would bypass all RLS. Separate principles, separate secrets.
//
// Per cycle:
//   1. Claim up to N pending outbox rows (pending → sending; attempts++).
//   2. For each row, attempt email via Resend (or log-and-succeed if
//      RESEND_API_KEY is unset — dev/CI mode).
//   3. For each row, attempt webhook delivery per (tenant, run, event)
//      once — claim via notification_webhook_dispatches PK + HMAC-sign
//      the payload with tenants.webhook_signing_secret_ref.
//   4. Record success or failure per row.
//
// Webhook-signing-secret resolution: the spec says
// tenants.webhook_signing_secret_ref points at a Supabase Vault key.
// For Batch 5c we treat the column as the raw secret — Vault integration
// is future work. Column is NULLABLE, and webhook delivery is skipped
// entirely if either webhook_url or webhook_signing_secret_ref is NULL.

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

type ClaimedRow = {
  id: string;
  tenant_id: string;
  event_type: string;
  recipient_user_id: string;
  role_context: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  run_id: string | null;
  timesheet_id: string | null;
};

const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const DRAIN_SECRET = Deno.env.get("NOTIFICATION_DRAIN_SECRET") ?? "";
const MAX_ATTEMPTS = Number(Deno.env.get("NOTIFICATION_MAX_ATTEMPTS") ?? "3");

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendEmail(
  fromAddress: string,
  to: string,
  row: ClaimedRow,
): Promise<void> {
  if (!RESEND_KEY) {
    console.log(`[dev] would send email to ${to} (event=${row.event_type})`);
    return;
  }
  const subject = `[TK] ${row.event_type}: ${row.run_id ?? row.timesheet_id ?? ""}`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to,
      subject,
      text: JSON.stringify(row.payload, null, 2),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function dispatchWebhook(
  sb: SupabaseClient,
  row: ClaimedRow,
  tenantRow: { webhook_url: string | null; webhook_signing_secret_ref: string | null },
): Promise<void> {
  if (!tenantRow.webhook_url || !tenantRow.webhook_signing_secret_ref || !row.run_id) {
    return;   // webhook not configured or no run to reference
  }
  // Claim this (tenant, run, event) for webhook — loser (conflict) skips.
  const { error: claimErr } = await sb.from("notification_webhook_dispatches").insert({
    tenant_id: row.tenant_id,
    run_id: row.run_id,
    event_type: row.event_type,
  });
  if (claimErr) {
    // PK conflict means another drain already dispatched — silently skip.
    if (claimErr.code === "23505") return;
    throw new Error(`webhook dispatch claim failed: ${claimErr.message}`);
  }

  const bodyStr = JSON.stringify(row.payload);
  const sig = await hmacHex(tenantRow.webhook_signing_secret_ref, bodyStr);

  let status = 0;
  let errMsg: string | null = null;
  try {
    const res = await fetch(tenantRow.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TK-Signature": `sha256=${sig}`,
      },
      body: bodyStr,
    });
    status = res.status;
    if (!res.ok) errMsg = `webhook ${res.status}: ${(await res.text()).slice(0, 200)}`;
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
  }

  // Record outcome on the dispatch row regardless. Webhook failure is
  // surfaced to the drain via a thrown error (which trips the outbox
  // row's failure path); the dispatch row itself preserves the history.
  await sb.from("notification_webhook_dispatches").update({
    last_status_code: status,
    last_error: errMsg,
  })
    .eq("tenant_id", row.tenant_id)
    .eq("run_id", row.run_id)
    .eq("event_type", row.event_type);

  if (errMsg) throw new Error(errMsg);
}

async function deliver(sb: SupabaseClient, row: ClaimedRow): Promise<void> {
  // 1. Tenant config.
  const { data: tenantRow, error: tenantErr } = await sb
    .from("tenants")
    .select("email_from_address, webhook_url, webhook_signing_secret_ref")
    .eq("id", row.tenant_id)
    .single();
  if (tenantErr || !tenantRow) throw new Error(`tenant ${row.tenant_id}: ${tenantErr?.message}`);

  // 2. Recipient email via auth admin API.
  const { data: userData, error: userErr } =
    await sb.auth.admin.getUserById(row.recipient_user_id);
  if (userErr || !userData?.user?.email) {
    throw new Error(`recipient ${row.recipient_user_id}: ${userErr?.message ?? "no email"}`);
  }

  // 3. Email + webhook. Webhook per-event dedup via PK; email per-recipient.
  await sendEmail(tenantRow.email_from_address, userData.user.email, row);
  await dispatchWebhook(sb, row, tenantRow);
}

Deno.serve(async (req) => {
  if (!DRAIN_SECRET) {
    return json(500, {
      type: "https://api.invenio.example/errors/internal",
      title: "NOTIFICATION_DRAIN_SECRET not configured",
      status: 500,
    });
  }
  const authz = req.headers.get("authorization") ?? "";
  if (authz !== `Bearer ${DRAIN_SECRET}`) {
    return json(403, {
      type: "https://api.invenio.example/errors/forbidden",
      title: "Invalid drain secret",
      status: 403,
    });
  }

  let batchSize = 10;
  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (typeof body?.batch_size === "number") batchSize = body.batch_size;
    } catch {
      // empty body is fine
    }
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: claimed, error: claimErr } = await sb.rpc(
    "_claim_pending_notifications", { p_batch_size: batchSize },
  );
  if (claimErr) {
    return json(500, { title: "claim failed", detail: claimErr.message, status: 500 });
  }

  const summary = {
    ok: true,
    claimed: claimed?.length ?? 0,
    sent: 0,
    retrying: 0,
    failed: 0,
  };

  for (const row of (claimed ?? []) as ClaimedRow[]) {
    try {
      await deliver(sb, row);
      await sb.rpc("_record_notification_success", { p_id: row.id });
      summary.sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const { data: outcome } = await sb.rpc("_record_notification_failure", {
        p_id: row.id, p_error: msg, p_max_attempts: MAX_ATTEMPTS,
      });
      if (outcome === "failed") summary.failed++;
      else summary.retrying++;
    }
  }

  return json(200, summary);
});
