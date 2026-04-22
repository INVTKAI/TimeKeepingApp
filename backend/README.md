# TimeKeepingApp Backend

Supabase backend implementing [`../docs/backend-spec.md`](../docs/backend-spec.md) v0.4.3. Postgres + Auth + PostgREST + Edge Functions (Deno/TypeScript); RLS as primary tenancy isolation; plpgsql RPCs for transactional logic; Edge Functions for side-effect work.

## Status

| Slice | State |
| --- | --- |
| 1. Foundation — scaffold + tenancy/users schema + auth hooks + assert helpers + withAdminContext | ✅ Batches 1 / 2a / 2b |
| 2. Core domain CRUD + admin Edge Functions + test gates | ✅ Batches 3a / 3b / 3c |
| 3. Approval subsystem — schema + state-machine RPCs + overrides + badge cascade | ✅ Batches 4a / 4b / 4c / 4d |
| 4. Notifications — outbox + delivery state + drain Edge Function + stall detection | ✅ Batches 5a / 5b / 5c |
| 5. Migration tooling — `import-localstorage`, `import-spreadsheet`, `release-queued-invites` | ✅ Batch 6 |
| 6. Export — `export-labor` Edge Function (CSV/XLSX) | ✅ Batch 7 |

All backend slices landed. Test suite: **241 pgTAP assertions** across 13 files; CI lint gate in place. Frontend rebuild against the v0.4 API surface lives at [`../frontend/`](../frontend/) and now covers auth + approve/reject/reassign mutations.

## Start here (fresh session)

1. **Read the spec** — [`../docs/backend-spec.md`](../docs/backend-spec.md) v0.4.3. Especially §3 (tenancy), §4 (auth), §6 (domain model), §7 (approval subsystem), §8 (API surface), §11 (stack + test gates + key rotation).
2. **Secrets** live in `.env` (gitignored). Rotation per spec §11.7.
3. **Install prereqs:** Docker Desktop + Supabase CLI (`brew install supabase/tap/supabase`).

## Local dev

Ports are offset by +10 from Supabase defaults (so this project coexists with other local Supabase stacks):

- API: `http://127.0.0.1:54331`
- Postgres: `postgresql://postgres:postgres@127.0.0.1:54332/postgres`
- Studio: `http://127.0.0.1:54333`
- Inbucket (email testing): `http://127.0.0.1:54334`

```bash
# First-time: pull images + boot local stack
supabase start

# Reset DB + re-apply all migrations (destroys local data)
supabase db reset

# Psql without a host-side client
docker exec -i supabase_db_invenio-timekeeping psql -U postgres -d postgres
```

## Running tests + CI gates

```bash
# Full pipeline — pgTAP suite + service-role-key usage lint
scripts/run-checks.sh

# Just the pgTAP suite
supabase test db

# Just one test file
supabase test db supabase/tests/60_state_machine_rpcs_test.sql

# Just the §11.6 lint
scripts/lint-service-role-usage.sh
```

The pgTAP suite covers: RLS isolation per tenant-scoped table; the custom access-token + password-verification-attempt hooks; assert helpers + `auth.sessions` pairing trigger; every mutating RPC's happy path + P0001/P0002/P0003/P0004/P0008 error branches; badge-override parent-run cascade; notification outbox enqueue + delivery state machine + stall/reconcile producers.

## Running the drain Edge Function

`drain-notifications` is not user-facing — it's invoked by pg_cron (prod) or manually (local/ops). Shared-secret-guarded via `NOTIFICATION_DRAIN_SECRET` (see `.env`).

```bash
# Start the Edge Runtime with env vars loaded (.env is NOT auto-loaded)
supabase functions serve --env-file .env

# In another terminal: drain one batch
curl -sS -X POST http://127.0.0.1:54331/functions/v1/drain-notifications \
  -H "Authorization: Bearer $(grep NOTIFICATION_DRAIN_SECRET .env | cut -d= -f2)" \
  -H "apikey: $(grep SUPABASE_ANON_KEY .env | cut -d= -f2-)" \
  -H "Content-Type: application/json" \
  -d '{"batch_size": 10}'
```

In local dev without a real `RESEND_API_KEY`, the drain logs each email and marks the row `sent` (no outbound SMTP). Set `RESEND_API_KEY=re_...` in `.env` for live delivery.

## Layout

```
backend/
├── .env                 # secrets — gitignored
├── .gitignore
├── README.md            # this file
├── salvage/
│   └── init-migration-v0.3.sql   # reference only; from the pre-Supabase era
├── scripts/
│   ├── run-checks.sh               # CI entry
│   └── lint-service-role-usage.sh  # §11.6 P0 gate
└── supabase/
    ├── config.toml
    ├── migrations/     # 15 files; each batch has its own
    ├── functions/
    │   ├── _shared/
    │   │   ├── with-admin-context.ts   # mandatory wrapper for admin EFs (§8)
    │   │   ├── admin-helpers.ts        # body parse, tenant-scoped lookup, audit, session invalidation
    │   │   └── problem.ts              # RFC 7807 error helper
    │   ├── invite-user/
    │   ├── reset-password/
    │   ├── revoke-user/
    │   ├── restore-user/
    │   ├── change-role/
    │   ├── unlock-user/
    │   ├── import-localstorage/        # §9 Phase A — legacy blob → tenant
    │   ├── import-spreadsheet/         # §9 Phase B — dispatch on file_type
    │   ├── release-queued-invites/     # §9 cutover — generate invite links
    │   ├── export-labor/               # §8 CSV / XLSX labor export
    │   └── drain-notifications/       # system-triggered; not withAdminContext
    └── tests/          # pgTAP; numbered for execution order
```

## Production deployment notes

These aren't local-dev concerns but are worth capturing near the code:

- **pg_cron schedules** — three jobs to register after deploy. Example:
  ```sql
  -- Drain every minute
  SELECT cron.schedule('drain-notifications', '* * * * *', $$
    SELECT net.http_post(
      url := '<PROJECT_URL>/functions/v1/drain-notifications',
      headers := jsonb_build_object('Authorization','Bearer '||current_setting('app.drain_secret')),
      body := '{}'::jsonb
    );
  $$);
  -- Reconcile stuck-sending every 5 min
  SELECT cron.schedule('reconcile-stuck-sending', '*/5 * * * *', $$
    SELECT public._reconcile_stuck_sending(5);
  $$);
  -- Stall detection daily
  SELECT cron.schedule('emit-stall-notifications', '0 * * * *', $$
    SELECT public._emit_stall_notifications();
  $$);
  ```
- **Supabase Vault** — `tenants.webhook_signing_secret_ref` is treated as raw text in v1; wire it to Vault before going live with real webhooks.
- **Service-role key rotation** — spec §11.7. Annual + post-incident + post-personnel-change.

## Known gaps tracked for v1 close-out

- **Automatic badge-override detection** at `submit_timesheet` time — needs a `badge_records` table not in the spec. Customer conversation before building.
- **True multi-session concurrency tests** — `approve+approve` P0002 race etc. — needs `pg_background` or shell-level parallel psql. Current pgTAP exercises the single-session P0002 branch via manual state mutation.
- **1× vs 2× SLA stall escalation** — `_emit_stall_notifications` always includes tenant admins; spec §7.6 says admins only at 2× SLA. Refine to two-event distinction when wiring production.
- **Idempotency-key concurrent-race hardening** — current behavior is P0008 on PK conflict; acceptable for the common retry-after-network-blip case.

## Salvaged artifact

[`salvage/init-migration-v0.3.sql`](salvage/init-migration-v0.3.sql) is the hand-authored SQL from a pre-Supabase scaffold attempt. Kept for historical reference only; not applied and not part of the build.
