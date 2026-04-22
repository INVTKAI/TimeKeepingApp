# Service-role key rotation runbook

Spec §11.7 — the service-role key is the root credential. Leaking it bypasses all RLS tenancy isolation.

## When to run

- **Annual** — always, even absent incident, to bound credential lifetime.
- **Post-incident** — suspected leak, compromised laptop, accidental commit to a public repo.
- **Post-personnel change** — when someone with production credential access leaves or changes role.

## Pre-rotation checklist

- [ ] Confirm you have an Owner role in the Supabase project (rotation requires dashboard access).
- [ ] Confirm the customer is not mid-cutover — rotation briefly invalidates outstanding server-side sessions using the old key.
- [ ] Identify every consumer of the current service-role key:
  - `backend/.env` (local dev, gitignored)
  - Edge Function project secrets (`SUPABASE_SERVICE_ROLE_KEY` auto-injected by Supabase at runtime — rotated automatically on dashboard rotation)
  - Any CI/CD secret vault entries (GitHub Actions, etc.)
  - Any ops runbooks that have the value inlined (search the docs repo)

## Rotation procedure

### 1. Generate the new key

Supabase Dashboard → **Settings** → **API** → **Project API keys** → **Rotate service_role key**.

This immediately invalidates the old key. Anything using it will start returning `401 Unauthorized` from PostgREST and other Supabase services.

**Copy the new key** into your password manager before clicking away — Supabase does NOT store it retrievable.

### 2. Update local dev

```bash
# backend/.env
SUPABASE_SERVICE_ROLE_KEY=<new key>
```

No-op for Edge Functions locally — they read env from `supabase functions serve --env-file .env`, so the above update covers them too.

### 3. Update prod Edge Function secrets

The `SUPABASE_SERVICE_ROLE_KEY` env var inside deployed Edge Functions is automatically injected by Supabase — the dashboard rotation handles it. But if any function has OVERRIDDEN it via Dashboard → Edge Functions → Secrets (check each function), update there too.

```bash
# Verify via
supabase secrets list --project-ref rrgocxusfaxzwgnjxpdh
```

### 4. Update CI/CD

Wherever `SUPABASE_SERVICE_ROLE_KEY` is stored as a pipeline secret — GitHub Actions, any hosted CI. Roll it forward before the next pipeline run.

### 5. Verify

```bash
# 5a. EF smoke against prod — exercises an admin EF using the new key.
#     Needs a prod-provisioned admin user; skip if you don't want to test in prod.
#
# 5b. Minimum: confirm the service-role client can read tenants.
export SUPABASE_URL=https://rrgocxusfaxzwgnjxpdh.supabase.co
curl -sS "${SUPABASE_URL}/rest/v1/tenants?select=id" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" | jq
# Expected: JSON array. Any 401 or empty-array-from-RLS-accident means the
# rotation broke something.
```

### 6. Record the rotation

Append to `docs/ops/rotation-log.md` (create if absent):

```markdown
## YYYY-MM-DD — annual rotation
- Rotated by: <you>
- Old key prefix: `eyJhb…` (last 6: `xxxxxx`)
- New key prefix: `eyJhb…` (last 6: `yyyyyy`)
- Consumers updated: backend/.env, GitHub Actions secret TKAPP_SERVICE_KEY
- Verified: curl tenants on prod → 200
```

**Do NOT** paste the full key into the log.

## Rollback

There is no rollback — the old key is gone the moment you clicked rotate. If something breaks in step 5:

1. Identify the broken consumer (grep your logs for `401 Unauthorized` or `JWSError`).
2. Update its secret with the new key.
3. If you can't quickly identify the consumer, the fastest recovery is to rotate AGAIN, redo steps 2-5 more carefully, and flag the gap in next-cycle's pre-rotation checklist.

## Notification-drain secret rotation

`NOTIFICATION_DRAIN_SECRET` is a separate secret with its own rotation cadence. It's lower-blast-radius than the service-role key (leak lets an attacker trigger already-enqueued notification deliveries, not bypass RLS), so rotation is only required:

- Post-incident (suspected drain-secret leak).
- Post-personnel change where someone had access to prod env.

Procedure: generate a new random string (32+ bytes), update both the Edge Function env and whatever is calling drain-notifications (pg_cron job — see [../../backend/README.md](../../backend/README.md#production-deployment-notes)), verify via one manual drain call. No rotation log entry needed for this one — just note it in your ops channel.
