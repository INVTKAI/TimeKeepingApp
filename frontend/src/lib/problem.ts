// Error shapes returned by the backend.
//
// Two surfaces per spec §8:
//
// 1. PostgREST / RPC errors — native Supabase shape. `code` is a Postgres
//    SQLSTATE; we use the P0* custom codes from the spec to distinguish
//    validation / state / version conflicts.
//
// 2. Edge Function errors — RFC 7807 `application/problem+json` with stable
//    `type` URLs at https://api.invenio.example/errors/*.

export type PostgrestError = {
  code: string;
  message: string;
  details?: string;
  hint?: string;
};

export type Problem = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  [key: string]: unknown;
};

export function isProblem(x: unknown): x is Problem {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Problem).type === "string" &&
    typeof (x as Problem).status === "number"
  );
}

// Common P0* codes from the spec. Add more here as flows grow to use them.
export const P_CODES = {
  RUN_STATE_CHANGED: "P0002",
  VALIDATION: "P0001",
  UNAUTHORIZED: "P0003",
  NOT_FOUND: "P0004",
  IDEMPOTENCY_CONFLICT: "P0008",
  USER_NOT_PROVISIONED: "P0010",
} as const;

export type PCode = (typeof P_CODES)[keyof typeof P_CODES];

export function humanizeError(err: unknown): string {
  if (isProblem(err)) {
    return err.detail ?? err.title;
  }
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Unknown error";
}

// Invoke an Edge Function and normalize the response: resolve with data on 2xx,
// reject with the Problem (RFC 7807) on 4xx/5xx so callers can branch on
// problem.type or problem.status without re-parsing.
export async function invokeEdgeFunction<T>(
  supabaseUrl: string,
  functionName: string,
  body: unknown,
  accessToken: string,
  anonKey: string,
): Promise<T> {
  const res = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      apikey: anonKey,
    },
    body: JSON.stringify(body ?? {}),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("json");
  const payload = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    if (isJson && isProblem(payload)) {
      throw payload;
    }
    throw {
      type: "https://api.invenio.example/errors/unknown",
      title: `Edge function ${functionName} failed`,
      status: res.status,
      detail: typeof payload === "string" ? payload : JSON.stringify(payload),
    } satisfies Problem;
  }
  return payload as T;
}
