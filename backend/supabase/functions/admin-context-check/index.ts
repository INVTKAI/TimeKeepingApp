// admin-context-check — Batch 2b smoke function for withAdminContext.
// Returns the verified admin context as JSON so callers (and tests) can
// confirm the wrapper's gates fire correctly. Not a production function;
// Batch 3's real admin Edge Functions (invite-user, revoke-user, etc.)
// will replace this as the canonical examples.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withAdminContext } from "../_shared/with-admin-context.ts";

Deno.serve(
  withAdminContext(async (_req, ctx) => {
    return new Response(
      JSON.stringify({
        ok: true,
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        email: ctx.user.email,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }),
);
