// Integration-test harness for Edge Functions.
// ----------------------------------------------------------------------------
// The pgTAP suite covers the DB layer thoroughly but the Edge Function surface
// has been untested end-to-end — withAdminContext's JWT checks, RFC 7807
// shapes, tenant-scoping of the admin client, etc. This harness fills that gap.
//
// Prereqs (the runner script validates all of these before invoking deno test):
//   * `supabase start` — local stack running on the +10 port offset
//   * `supabase functions serve --env-file .env` — functions runtime up
//   * environment vars from `supabase status -o env`: SUPABASE_URL,
//     SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
//
// Each test file runs its scenarios via `withFixture(async (ctx) => ...)`
// which seeds a fresh tenant + admin user, mints an admin JWT, then cleans up
// on return. Cleanup uses the service-role client — bypasses RLS.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";
import { assertEquals, assertExists } from "jsr:@std/assert@1";

// --- Environment -------------------------------------------------------------

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54331";
export const SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ??
  "";
export const ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("ANON_KEY") ??
  "";
export const JWT_SECRET =
  Deno.env.get("SUPABASE_JWT_SECRET") ??
  Deno.env.get("JWT_SECRET") ??
  "super-secret-jwt-token-with-at-least-32-characters-long";

if (!SERVICE_ROLE_KEY) {
  throw new Error(
    "tests-integration/_helpers.ts: SUPABASE_SERVICE_ROLE_KEY / SERVICE_ROLE_KEY not set. " +
      "Run via scripts/run-ef-tests.sh, which sources `supabase status -o env`.",
  );
}
if (!ANON_KEY) {
  throw new Error(
    "tests-integration/_helpers.ts: SUPABASE_ANON_KEY / ANON_KEY not set. " +
      "Run via scripts/run-ef-tests.sh.",
  );
}

export const adminClient: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --- JWT minting -------------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

let cachedKey: CryptoKey | null = null;
async function hmacKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return cachedKey;
}

export type JwtClaims = {
  sub: string;
  tenant_id: string;
  app_role: "admin" | "submitter";
  username: string;
  email: string;
  ttlSec?: number;
};

export async function mintJwt(c: JwtClaims): Promise<string> {
  const key = await hmacKey();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "supabase-demo",
    sub: c.sub,
    aud: "authenticated",
    role: "authenticated",
    email: c.email,
    tenant_id: c.tenant_id,
    app_role: c.app_role,
    username: c.username,
    iat: now,
    exp: now + (c.ttlSec ?? 900),
  };
  const enc = new TextEncoder();
  const headerB64 = b64urlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)),
  );
  return `${signingInput}.${b64urlEncode(sig)}`;
}

// --- Fixture seed/cleanup ----------------------------------------------------

export type Fixture = {
  tenantId: string;
  tenantSlug: string;
  adminUserId: string;
  adminUsername: string;
  adminEmail: string;
  adminJwt: string;
  /** Fresh UUID-suffixed subcontractor id available to tests that need one. */
  defaultSubId: string;
};

/** Generates a slug unique per test run to sidestep UNIQUE(tenants.slug). */
function runTag(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedTenant(): Promise<Fixture> {
  const tag = runTag();
  const tenantId = crypto.randomUUID();
  const tenantSlug = `test-${tag}`;
  const adminEmail = `admin-${tag}@test.invenio.local`;
  const adminUsername = `admin-${tag}`;
  const password = `test-${tag}-Pass!12345`;

  const { error: tErr } = await adminClient.from("tenants").insert({
    id: tenantId,
    name: `Test ${tag}`,
    slug: tenantSlug,
    email_from_address: "hr@test.invenio.local",
  });
  if (tErr) throw new Error(`seed tenants: ${tErr.message}`);

  const { data: authData, error: authErr } = await adminClient.auth.admin.createUser({
    email: adminEmail,
    password,
    email_confirm: true,
    user_metadata: {
      tenant_id: tenantId,
      app_role: "admin",
      username: adminUsername,
    },
  });
  if (authErr || !authData?.user) {
    throw new Error(`seed auth.users: ${authErr?.message ?? "no user"}`);
  }
  const adminUserId = authData.user.id;

  const { error: pubErr } = await adminClient.from("users").insert({
    id: adminUserId,
    tenant_id: tenantId,
    username: adminUsername,
    email: adminEmail,
    role: "admin",
    status: "active",
  });
  if (pubErr) {
    await adminClient.auth.admin.deleteUser(adminUserId).catch(() => {});
    await adminClient.from("tenants").delete().eq("id", tenantId).catch(() => {});
    throw new Error(`seed public.users: ${pubErr.message}`);
  }

  const { data: sub, error: subErr } = await adminClient
    .from("subcontractors")
    .insert({ tenant_id: tenantId, name: "Invenio", short_code: `INV-${tag}` })
    .select("id")
    .single();
  if (subErr || !sub) {
    throw new Error(`seed subcontractors: ${subErr?.message ?? "no row"}`);
  }

  const adminJwt = await mintJwt({
    sub: adminUserId,
    tenant_id: tenantId,
    app_role: "admin",
    username: adminUsername,
    email: adminEmail,
  });

  return {
    tenantId,
    tenantSlug,
    adminUserId,
    adminUsername,
    adminEmail,
    adminJwt,
    defaultSubId: sub.id,
  };
}

async function cleanupTenant(fx: Fixture): Promise<void> {
  // Order matters due to FK RESTRICT on tenants. Delete downstream first.
  const t = fx.tenantId;
  // Best-effort — don't let teardown fail the test.
  try {
    await adminClient.from("audit_events").delete().eq("tenant_id", t);
    await adminClient.from("notification_outbox").delete().eq("tenant_id", t);
    await adminClient.from("login_failure_counters").delete().eq("user_id", fx.adminUserId);
    await adminClient.from("user_unlock_markers").delete().eq("tenant_id", t);
    await adminClient.from("users").delete().eq("tenant_id", t);
    await adminClient.auth.admin.deleteUser(fx.adminUserId).catch(() => {});
    await adminClient.from("subcontractors").delete().eq("tenant_id", t);
    await adminClient.from("tenants").delete().eq("id", t);
  } catch (err) {
    console.warn(`cleanupTenant(${fx.tenantSlug}): ${err instanceof Error ? err.message : err}`);
  }
}

export async function withFixture<T>(
  fn: (fx: Fixture) => Promise<T>,
): Promise<T> {
  const fx = await seedTenant();
  try {
    return await fn(fx);
  } finally {
    await cleanupTenant(fx);
  }
}

// --- Edge Function invocation ------------------------------------------------

export type CallResponse<T = unknown> = {
  status: number;
  contentType: string;
  headers: Headers;
  json: T | null;
  text: string;
};

export async function callEdgeFunction<T = unknown>(
  name: string,
  body: unknown,
  opts: { jwt?: string | null; method?: string } = {},
): Promise<CallResponse<T>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    apikey: ANON_KEY,
  };
  if (opts.jwt) headers.authorization = `Bearer ${opts.jwt}`;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: opts.method ?? "POST",
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let json: T | null = null;
  if (contentType.includes("json") && text.length > 0) {
    try {
      json = JSON.parse(text) as T;
    } catch {
      // Leave json null; caller can inspect text.
    }
  }
  return { status: res.status, contentType, headers: res.headers, json, text };
}

// --- Re-exports --------------------------------------------------------------

export { assertEquals, assertExists };
