// CORS helpers shared by all Edge Functions.
//
// Browsers block cross-origin fetches unless the server responds to the
// preflight OPTIONS with the right Access-Control-* headers. Our Netlify
// frontend calls the Supabase-hosted Edge Functions cross-origin; without
// this, every POST fails with "Response to preflight request doesn't pass
// access control check."
//
// Wildcard Access-Control-Allow-Origin is safe here because our EFs use
// Bearer-token auth (Authorization header), not cookies/credentials.
// Supabase's own REST + Auth endpoints respond `Access-Control-Allow-Origin: *`
// for the same reason — this keeps our surface consistent.

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Max-Age": "86400",
};

// Short-circuit OPTIONS preflight: return 204 No Content with headers.
export function preflightResponse(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return null;
}

// Merge CORS headers into an existing Response. Use when a handler already
// built a Response (with its own content-type, body, status) and we just
// need to add the CORS headers.
export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
