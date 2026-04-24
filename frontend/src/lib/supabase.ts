import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in .env.local. " +
      "Copy .env.local.example and fill in values from `supabase status`.",
  );
}

export const supabase: SupabaseClient = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Implicit flow (tokens in URL fragment) — not PKCE. PKCE requires the
    // client that INITIATED the flow to also consume the email link, which
    // is false for admin-generated invites and for resets opened on a
    // different device than where the reset was requested. Implicit flow
    // puts access_token / refresh_token in the URL hash; detectSessionInUrl
    // installs the session on page load, and AcceptInvite strips the hash
    // immediately so tokens don't linger in browser history. Access-token
    // TTL is 15 min (spec §4.2), bounding the exposure window.
    flowType: "implicit",
  },
});
