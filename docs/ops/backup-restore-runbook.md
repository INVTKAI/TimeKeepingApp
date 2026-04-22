# Backup + restore runbook

**Automatic backups (Supabase Pro):** daily snapshots with 7-day retention, configured at the project level. No action needed to enable. Upgrade to 14-day / 30-day retention in Dashboard → **Project Settings** → **Database** → **Backups** if the customer's compliance profile requires it.

## When you'd restore

- **Bad migration landed in prod** — a migration corrupted data, dropped a column that still had live readers, etc.
- **Bulk data mistake** — admin ran a `DELETE FROM timesheets WHERE …` that wiped more than intended.
- **Encryption / ransomware incident** — worst case; full restore to a last-known-good point.
- **Customer-requested undo** — "we imported the wrong spreadsheet, roll back the tenant."

Most customer-facing errors are better fixed with a targeted SQL patch than a full restore. Restore is the last resort.

## Backup formats available

| Path | Cadence | Retention | Use case |
| --- | --- | --- | --- |
| Supabase automated | Daily | 7 days (Pro default) | Full-project point-in-time recovery |
| Manual `supabase db dump` | Ad-hoc | Up to you | Pre-destructive-change snapshot |
| Migration history | Every PR | Git (forever) | Replay schema from scratch |

## Pre-restore checklist

- [ ] Written approval from the customer (restore reverts ALL tenant data to the backup point — any in-flight work is lost).
- [ ] Identified the exact backup timestamp to restore to (latest-good).
- [ ] Communication plan: users signed out / seeing a maintenance page during the restore window.
- [ ] Do you need ALL tenants restored or just one? Single-tenant restore requires staging + export + import (see below).

## Full-project restore (all tenants)

Supabase Pro dashboards offer Point-in-Time-Recovery (PITR). This is the sanctioned path for full restores.

1. Dashboard → **Database** → **Backups** → **Restore to this point**.
2. Supabase creates a **new project** restored to the chosen snapshot.
3. Verify the new project has the expected data.
4. Swap the application's `VITE_SUPABASE_URL` / `SUPABASE_URL` / `SUPABASE_PROJECT_REF` to the new project.
5. Invalidate any cached anon keys in frontend deployments.
6. The old project stays pausable / deletable as needed.

**Estimated downtime:** ~30 min end-to-end if nothing surprises you.

## Ad-hoc manual dump (pre-destructive-change snapshot)

Before running a risky migration or manual SQL against prod, take a local dump:

```bash
cd backend
# Dumps the entire linked project's schema + data to a plain-SQL file.
supabase db dump --linked --data-only -f dumps/prod-$(date -u +%Y%m%d-%H%M%S).sql

# Schema-only (handy for diffing migrations):
supabase db dump --linked --schema-only -f dumps/prod-schema-$(date -u +%Y%m%d-%H%M%S).sql
```

- `dumps/` is already gitignored via `backend/.gitignore` (confirm before committing). Dumps contain production data — NEVER commit.
- Store in an encrypted location (1Password vault, S3 with SSE) or delete after the change window.

## Single-tenant restore (targeted undo)

Full PITR restores everything. If only ONE tenant went bad, do this instead:

```bash
# 1. PITR-restore the project to a new "staging" project (same dashboard step
#    as Full-project restore above; stop after step 3).
# 2. From the staging project, dump just the tenant's data:
supabase db dump --linked --data-only \
  --schema public \
  -f /tmp/tenant-<uuid>.sql
#    (The CLI doesn't filter by tenant — you'll edit the SQL to keep only
#    rows with the target tenant_id.)

# 3. In a text editor, strip rows NOT matching the target tenant_id.
#    This is tedious — consider a pg_dump with COPY + a grep filter.

# 4. Against the live prod project, DELETE the bad tenant's rows in FK order:
#    notification_outbox, approval_actions, approval_runs, timesheet_lines,
#    timesheets, (the rest per backend/tests-integration/_helpers.ts cleanup
#    sequence), then re-apply from the filtered dump.

# 5. Run the go-live gate script against the restored tenant to confirm
#    integrity: `scripts/go-live-gate.sh <tenant-uuid> prod`.
```

**Estimated downtime (target tenant):** ~1 hour. Other tenants unaffected.

## Periodic restore drill

Every 6 months, verify the restore path actually works:

1. Use dashboard PITR to spin up a new-from-snapshot project (use the most recent snapshot).
2. Confirm row counts in `tenants`, `users`, `employees`, `timesheets` match expectations.
3. Run `supabase test db` on the new project (DB invariants still hold).
4. Tear down the drill project.
5. Note in `docs/ops/rotation-log.md` that the drill happened.

Skipping this drill means you'll discover your first restore failure during a real incident. Don't skip.

## Related docs

- Spec §11.7 — service-role rotation (separate concern, same `docs/ops/` dir).
- `backend/scripts/go-live-gate.sh` — invariant check you should run after any restore.
- `backend/tests-integration/end-to-end.test.ts` — happy-path smoke; runs against local, swap URLs to run against a staging restore.
