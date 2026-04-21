# TimeKeepingApp Backend

Implementation target for [`../docs/backend-spec.md`](../docs/backend-spec.md) v0.4.1 (Supabase-first). **No code yet** — this folder holds the Supabase project's connection secrets and the salvaged v0.3 init migration SQL. The next implementation step is scaffolding `backend/supabase/` via the Supabase CLI.

## Start here (fresh session)

1. **Read the spec** — [`../docs/backend-spec.md`](../docs/backend-spec.md) v0.4.1. Authoritative on schema, RLS, RPCs, Edge Functions, auth lifecycle. Especially §6.1 (schema), §8 (API surface + `withAdminContext` wrapper + error format split), §11 (stack, conventions, test gates, key rotation).
2. **Read the adversarial review** — [`../docs/adversarial-analysis-backend-spec-v0.4.md`](../docs/adversarial-analysis-backend-spec-v0.4.md) for why v0.4.1 closed the HSIs it did. Findings #7, #9, #11, #12 still open.
3. **Connection secrets** live in `.env` (gitignored). Don't paste them into code or markdown. Rotation policy: spec §11.7.

## Salvaged artifact

[`salvage/init-migration-v0.3.sql`](salvage/init-migration-v0.3.sql) — the hand-authored SQL from the aborted v0.3 Fastify scaffold. Reference only; not directly usable. What to carry forward into the first Supabase migration:

| Carry forward | Adapt | Drop |
| --- | --- | --- |
| `tenants` table structure | Add `login_max_attempts`, `login_lockout_minutes` (§4.7 / §6.1) | — |
| Enum definitions (`UserRole`, `UserStatus`, etc.) | Add `P0*` SQLSTATE conventions | `AuthEventType` — Supabase owns auth.audit_log_entries |
| UUID/timestamptz/jsonb conventions | — | — |
| RLS policy shape | Rewrite to `(auth.jwt() ->> 'tenant_id')::uuid` | `current_setting('app.tenant_id', true)` approach |
| — | Replace the `users` table with `public.users` linked 1:1 to `auth.users(id)` | `users` (auth-lifecycle flavor), `invites`, `password_history`, `sessions`, `auth_events` — Supabase Auth owns these |
| — | Add `public.user_unlock_markers`, `audit_events` | — |

## Next step: scaffold `supabase/`

```bash
# 1. Install the Supabase CLI (if not already)
brew install supabase/tap/supabase         # macOS
# or: https://supabase.com/docs/guides/cli

# 2. Initialize the project structure
cd backend
supabase init                               # creates supabase/config.toml + supabase/migrations/

# 3. Link to the cloud project (uses SUPABASE_PROJECT_REF from .env; you'll be
#    prompted for the DB password — it's *not* in .env, get it from the dashboard)
supabase link --project-ref "$(grep SUPABASE_PROJECT_REF .env | cut -d= -f2)"

# 4. Start the local stack (Docker required)
supabase start

# 5. Create the first migration — translate spec §6.1 + salvage into SQL
supabase migration new init_tenancy_and_users

# 6. Apply locally, test, then push to cloud
supabase db reset                           # local
supabase db push                            # cloud
```

## Build slicing

Per the build-framing memory (vertical slices from v0.3, preserved through the Supabase pivot):

1. **Foundation** — first migration (tenants, public.users, audit_events, user_unlock_markers, RLS policies), **custom access-token hook** (§4.2 JWT claims + §4.8 failure gates), **`before-login` hook** (§4.7 lockout), **`withAdminContext` wrapper** (§8), user-admin Edge Functions (invite / reset / revoke / restore / change-role / unlock), first-login status-transition trigger, P0 test gates (§11.6).
2. **Core domain CRUD** — employees, projects, subs, silos, areas, task codes, CWPs, FCOs. PostgREST + RLS policies.
3. **Approval subsystem** — plpgsql RPCs (`submit_timesheet`, `approve_run`, `reject_run`, `recall_run`, `reassign_run`, `override_run`); `my_pending_approvals`, `project_readiness` RPCs; idempotency_keys table; `assert_session_live` + `assert_tenant_claim_present` helpers on every mutating RPC.
4. **Badge override reconciliation** — `resolve_badge_override` RPC (§7.7).
5. **Notifications** — `notification_outbox` + pg_cron drain Edge Function; Resend + HMAC-signed webhooks.
6. **Migration tooling** — `import-localstorage`, `import-spreadsheet`, `release-queued-invites` Edge Functions.
7. **Export** — `export-labor` Edge Function.

## Layout after scaffolding

Expected after `supabase init` + first migration:

```
backend/
├── .env                 # secrets — gitignored
├── .gitignore
├── README.md            # this file
├── salvage/
│   └── init-migration-v0.3.sql
└── supabase/            # created by `supabase init`
    ├── config.toml
    ├── migrations/
    │   └── <ts>_init_tenancy_and_users.sql
    ├── functions/
    │   └── _shared/with-admin-context.ts
    └── seed.sql
```
