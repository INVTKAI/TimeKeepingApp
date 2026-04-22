# Backend test harness

pgTAP tests live here; static-analysis lint lives in `../scripts/`. The
top-level runner is [`../scripts/run-checks.sh`](../scripts/run-checks.sh) —
CI invokes that; locally run the same.

## Running

```bash
# Prereq: local stack is up.
cd backend
supabase start                      # if not already running

# Run everything (pgTAP + service-role-key usage lint).
scripts/run-checks.sh

# Or individual pieces:
supabase test db                                         # full pgTAP suite
supabase test db supabase/tests/10_rls_isolation_test.sql  # single file
scripts/lint-service-role-usage.sh                       # only the lint
```

## What's covered (tracking spec §11.5 and §11.6)

| File | Covers |
| --- | --- |
| `00_sanity_test.sql` | Core tables exist (migrations applied) |
| `10_rls_isolation_test.sql` | RLS policies on every tenant-scoped table; cross-tenant SELECT/INSERT/UPDATE/DELETE rejection; admin-vs-submitter write gating; audit_events self-insert policy; fail-closed behavior when JWT lacks `tenant_id` |
| `20_access_token_hook_test.sql` | §11.6 P0 gate — custom_access_token_hook shapes claims correctly across 6 profiles (admin, submitter, pending, revoked, orphan, multi-tenant) |
| `30_auth_guards_test.sql` | `assert_tenant_claim_present` + `assert_session_live` SQLSTATE contract; `auth.sessions` pairing trigger; §11.6 P0 static gate enumerating state-mutating RPCs (currently empty set; fires when Batch 4 lands) |
| `40_password_verification_hook_test.sql` | Per-account lockout hook — failure accumulation, 429 at threshold, lockout persists on valid password (credential-stuffing defense), unlock marker reset, per-tenant `login_max_attempts` |
| `../scripts/lint-service-role-usage.sh` | §11.6 P0 gate — service-role key may only appear in `_shared/with-admin-context.ts` |

## Test-writing notes

- Every `.sql` test file wraps its assertions in `BEGIN; SELECT plan(N); … SELECT * FROM finish(); ROLLBACK;` — state from one file does not leak into another.
- Supabase's pgTAP runner sorts by filename. The `NN_` prefix controls order.
- **Same-transaction `now()` gotcha.** Inside a pgTAP file, `now()` returns transaction-start time for every call — so timestamps set via `DEFAULT now()` all collapse. For tests that need time ordering (lockout, unlock, revoke-denylist), either use `clock_timestamp()` (the `password_verification_attempt_hook` does, post-Batch-3c), or set timestamps explicitly in the test fixture.
- `SELECT set_config('role', 'authenticated', true)` switches the current role within the transaction so RLS fires; `RESET role` undoes it. For service-role operations, `set_config('role', 'service_role', true)` works, but be aware that stock Supabase doesn't grant `service_role` INSERT on `auth.sessions` (admin imports go through `supabase_auth_admin` instead via the Auth Admin API).
- To simulate a JWT, set `request.jwt.claims` as a JSON text:
  ```sql
  SELECT set_config('request.jwt.claims',
    '{"sub":"…","tenant_id":"…","app_role":"admin","iat":1700000000}', true);
  ```

## Adding new test files

Prefix with a two-digit number matching the conceptual grouping:
- `0x` — sanity / setup
- `1x` — RLS / isolation
- `2x` — auth hooks
- `3x` — auth guards + triggers
- `4x` — lockout + session lifecycle
- `5x+` — subsystems landing in future batches (timesheets, approvals, notifications, …)
