// RFC 7807 Problem Details helper for Edge Function responses.
// Spec §8 — Edge Functions return application/problem+json for errors, while
// PostgREST RPCs use their native error shape with P0* SQLSTATE codes.

export type Problem = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  [key: string]: unknown;
};

const ERROR_BASE = "https://api.invenio.example/errors";

export const Problems = {
  MissingAuth: (): Problem => ({
    type: `${ERROR_BASE}/missing-authorization`,
    title: "Missing Authorization header",
    status: 401,
  }),
  InvalidToken: (detail?: string): Problem => ({
    type: `${ERROR_BASE}/invalid-token`,
    title: "Invalid or expired token",
    status: 401,
    ...(detail ? { detail } : {}),
  }),
  TenantClaimMissing: (): Problem => ({
    type: `${ERROR_BASE}/tenant-claim-missing`,
    title: "Tenant claim missing from JWT",
    status: 403,
    detail:
      "Custom access-token hook did not inject tenant_id into this token. Re-authenticate; if persistent, contact support.",
  }),
  Forbidden: (detail?: string): Problem => ({
    type: `${ERROR_BASE}/forbidden`,
    title: "Forbidden",
    status: 403,
    ...(detail ? { detail } : {}),
  }),
  Internal: (detail?: string): Problem => ({
    type: `${ERROR_BASE}/internal`,
    title: "Internal Server Error",
    status: 500,
    ...(detail ? { detail } : {}),
  }),
};

export function problemResponse(p: Problem): Response {
  return new Response(JSON.stringify(p), {
    status: p.status,
    headers: { "content-type": "application/problem+json" },
  });
}
