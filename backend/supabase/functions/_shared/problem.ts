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
  ValidationError: (detail: string): Problem => ({
    type: `${ERROR_BASE}/validation-error`,
    title: "Request body failed validation",
    status: 400,
    detail,
  }),
  UserNotFound: (detail?: string): Problem => ({
    type: `${ERROR_BASE}/user-not-found`,
    title: "User not found in tenant",
    status: 404,
    ...(detail ? { detail } : {}),
  }),
  UserStateConflict: (detail: string): Problem => ({
    type: `${ERROR_BASE}/user-state-conflict`,
    title: "User state conflicts with requested operation",
    status: 409,
    detail,
  }),
  CannotTargetSelf: (): Problem => ({
    type: `${ERROR_BASE}/cannot-target-self`,
    title: "Admin cannot target their own account for this operation",
    status: 409,
    detail:
      "Revoke, demote, and password-reset of an admin's own account must be performed by a different admin to avoid lockout.",
  }),
  EmailAlreadyExists: (): Problem => ({
    type: `${ERROR_BASE}/email-already-exists`,
    title: "Email already exists in this tenant",
    status: 409,
  }),
  SupabaseAuthError: (detail: string): Problem => ({
    type: `${ERROR_BASE}/supabase-auth-error`,
    title: "Supabase Auth operation failed",
    status: 502,
    detail,
  }),
};

export function problemResponse(p: Problem): Response {
  return new Response(JSON.stringify(p), {
    status: p.status,
    headers: { "content-type": "application/problem+json" },
  });
}
