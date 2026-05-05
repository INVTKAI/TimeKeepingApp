# TimeKeepingApp v1 launch checklist

Living doc. Update status + dates as items land. Source of truth for "are we ready to cut over?"

**Prod Supabase project:** `TimeKeepingApp` · ref `rrgocxusfaxzwgnjxpdh` · East US (N. Virginia) · Pro tier · region matches customer's US location.

**Email domain:** `revfire.us` (DNS access confirmed user-side 2026-04-22). Supabase Auth emails from `noreply@revfire.us`; tenant notification default from-address same until per-tenant override.

**Last refresh:** 2026-05-05.

Status key: ✅ done · 🟡 in flight · ⏳ not started · 🚫 blocked

---

## Blocking — must land before customer cutover

### Infrastructure

| #   | Item                                                          | Status | Owner   | Notes                                                                                                 |
| --- | ------------------------------------------------------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Pro-tier Supabase project provisioned                         | ✅     | Invenio | Confirmed 2026-04-22                                                                                  |
| 2a  | Migrations pushed (14 files, 2026-04-22)                      | ✅     | Claude  | Applied 2026-04-22 via `supabase db push`. `migration list --linked` confirms Local=Remote for all 14. Smoke: PostgREST live (anon SELECT tenants → 200 []); submit_timesheet RPC reachable and returns P0005 TENANT_CLAIM_MISSING on unauthenticated call (confirms assert helpers work) |
| 2b.1 | `custom_access_token_hook` enabled in Dashboard               | ✅     | Invenio | Enabled 2026-04-22. Every JWT now carries tenant_id + app_role + username claims |
| 2b.2 | `password_verification_attempt_hook` — **v1.1, tier-gated**   | 🚫 v1.1 | Invenio | Team-tier Supabase only; Pro blocks with "plan type doesn't support". v1 falls back to built-in per-IP rate limit. Code deployed inert — enables immediately on tier upgrade. See spec §4.7 + §10 |
| 2c  | pg_cron + pg_net extensions enabled                            | ✅     | Invenio | Applied 2026-04-22 via `backend/scripts/prod-bootstrap.sql` in Dashboard SQL Editor                   |
| 2d  | pg_cron schedules registered                                   | ✅     | Invenio | All three active: `drain-notifications` (* * * * *), `reconcile-stuck-sending` (*/5 * * * *), `emit-stall-notifications` (0 * * * *). Drain secret in Vault; project URL inlined |
| 2e  | `NOTIFICATION_DRAIN_SECRET` set in prod EF env                 | ✅     | Claude  | Set 2026-04-22 via `supabase secrets set` (48-char random). Smoke: drain returns 403 on wrong secret + 200 + claimed:0 on correct |
| 3a  | Custom SMTP configured (Resend)                                | ✅     | Invenio+Claude | Wired 2026-04-22. Dashboard-set then synced via `supabase config push` from `[auth.email.smtp]` in config.toml (RESEND_API_KEY env-ref). Sender `noreply@revfire.us`, sender_name `Invenio Timekeeping` |
| 3b  | DNS records for `revfire.us` email (SPF / DKIM / DMARC)  | ✅     | Invenio | `revfire.us` was already a verified Resend domain on the user's account — no new DNS records required |
| 3c  | `RESEND_API_KEY` set in prod EF env                            | ✅     | Claude  | Set 2026-04-22 alongside drain secret. drain-notifications now delivers real email on every cron tick |
| 4   | Supabase Auth email templates (invite, recovery) with customer branding | ✅ | Claude  | All 6 templates (invite, recovery, confirmation, magic_link, email_change, reauthentication) synced via `supabase config push` 2026-04-22. Branded HTML at `backend/supabase/templates/*.html`. Live invite test from Dashboard Users tab arrived correctly |
| 4a  | Auth flow: PKCE → implicit (email-link compatibility)         | ✅     | Claude  | 2026-04-24, commit `6f320e4` — flowType 'pkce' broke admin invites + cross-browser resets ("PKCE code verifier not found in storage"). Switched to implicit + rewrote AcceptInvite to read session from URL fragment + strip hash. Deployed to prod 2026-05-05 (Netlify wasn't auto-deploying — see #18). Playwright regression test in `frontend/e2e/invite-flow.spec.ts` runs in fresh browser context. |
| 18  | Netlify ↔ GitHub auto-deploy linkage                          | ⏳     | Invenio | **Discovered 2026-05-05 broken:** Netlify site has no `repo_url` configured — every deploy since site creation has been manual `netlify deploy`. Caused commit `6f320e4` (auth fix) to sit undeployed for 11 days while users hit the bug. **Fix:** Netlify UI → site → Build & deploy → "Link site to Git" → authorize Netlify GitHub App for `INVTKAI` org → set base=`frontend`, cmd=`npm run build`, publish=`frontend/dist`, branch=`main`. CLI cannot do this — GitHub OAuth is browser-only. |

### Customer-side data

| #   | Item                                                          | Status | Owner   | Notes                                                                                                 |
| --- | ------------------------------------------------------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------- |
| 5   | Phase A import against real `tk_*` dump                       | ⏳     | Invenio | `import-localstorage` EF. Test blob is synthetic; this catches data-shape surprises                   |
| 6a  | `subs.xlsx` loaded                                            | ⏳     | Invenio | Phase B spreadsheet #1                                                                                |
| 6b  | `employee-subs.xlsx` loaded                                   | ⏳     | Invenio | #2                                                                                                    |
| 6c  | `project-subs.xlsx` loaded                                    | ⏳     | Invenio | #3                                                                                                    |
| 6d  | `project-flows.xlsx` loaded                                   | ⏳     | Invenio | #5 (flow templates #4 authored directly below)                                                        |
| 6e  | `silo-roles.xlsx` loaded                                      | ⏳     | Invenio | #6                                                                                                    |
| 6f  | `project-roles.xlsx` loaded                                   | ⏳     | Invenio | #7                                                                                                    |
| 6g  | `timekeeper-assignments.xlsx` loaded                          | ⏳     | Invenio | #8                                                                                                    |
| 7   | Approval flow templates authored for each project             | ⏳     | Invenio | Discovery session + `approval_flows` / `approval_nodes` / `approval_node_approvers` populated         |
| 8   | Go-live gate SQL checks all pass (§9.10)                      | ✅     | Claude  | `backend/scripts/go-live-gate.{sql,sh}` — 8-gate check. Runner supports local + prod targets. Run immediately before cutover with the target tenant_id |

### Missing UI features

| #   | Item                                                          | Status | Owner  | Notes                                                                                                  |
| --- | ------------------------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------ |
| 9   | Admin "New field timesheet" creator UI                        | ✅     | Claude | `/timesheets/field/new` — bulk-create shells for a date range up to 14 days                             |
| 10  | Flow-template CRUD UI (admin)                                 | ✅     | Claude | `/admin/flows` list + `/admin/flows/:id` editor. Up to 5 nodes; ↑/↓ reorder; approver pickers for user + role_on_silo + role_on_project |

---

## Strongly recommend — would be embarrassing to miss

| #   | Item                                                          | Status | Owner  | Notes                                                                                                  |
| --- | ------------------------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------ |
| 11  | End-to-end smoke script (seed tenant → invite → submit → approve → drain → Mailpit verify) | ✅ | Claude | `backend/tests-integration/end-to-end.test.ts` — runs as part of the EF test suite |
| 12  | Frontend Playwright happy-path test                           | ✅     | Claude | 16 tests across 5 specs in `frontend/e2e/` (sign-in, invite-flow regression guard, dashboard, admin-surfaces). Wired into CI 2026-05-05 (`.github/workflows/checks.yml` `e2e` job). Signed-in tests need GH secrets `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `PW_ADMIN_EMAIL`, `PW_ADMIN_PASSWORD`. Unauth tests pass against prod without secrets. |
| 13  | True multi-session P0002 concurrency test                     | ✅     | Claude | `backend/tests-integration/concurrency.test.ts` — two parallel `approve_run`; 5/5 reliable             |
| 14  | Import dashboards (frontend UI)                               | ✅     | Claude | `/admin/imports` (411 lines) wires both `import-localstorage` + `import-spreadsheet` with file upload + JSON paste + Phase B template downloads |
| 15  | Monitoring / alerting                                         | 🟡     | Invenio | SQL queries done at `backend/scripts/monitoring/` (4 files: cron_health, stuck_sending, notification_failures_spike, open_runs_aging) — emit `ok/WARN/ALERT/BLOCKED` status column for alert-tool matching. Alert target wiring (PagerDuty / Slack / email digest) still pending — needs decision |
| 16  | Service-role key rotation runbook (§11.7)                     | ✅     | Claude | `docs/ops/service-role-rotation-runbook.md`                                                           |
| 17  | Backup / restore procedure doc                                | ✅     | Claude | `docs/ops/backup-restore-runbook.md`                                                                  |
| 19  | CI gate on every PR + push to main                            | ✅     | Claude | `.github/workflows/checks.yml` — service-role lint + frontend tsc/build + pgTAP (241 assertions) + Playwright e2e. EF integration job stubbed (commented out, awaiting CI secrets plan) |
| 20  | Pre-deploy UAT spec + prod-smoke.sh                           | ✅     | Claude | `docs/pre-deploy-uat-spec.md` (5 layers: CI / staging / prod-env / client-data / manual). `backend/scripts/prod-smoke.sh` chains 6 non-destructive checks (migration parity, PostgREST, redirect URLs, go-live gate, pg_cron health, drain auth) |

---

## v1.1 / nice-to-have (NOT blocking)

- **Per-account lockout** — activate `password_verification_attempt_hook` in Dashboard once the project is on Team tier (Pro doesn't expose this hook). Code is deployed inert in v1; one click away from live. Spec §4.7.
- Badge-override resolution UI (RPCs exist, no frontend yet)
- Supabase Vault for `tenants.webhook_signing_secret_ref` (only matters when real webhooks ship)
- Dark-mode toggle
- Stackable toast system
- SOC 2 Type II audit (v1 targets *readiness*; actual audit is on-demand when an enterprise customer asks)

## Documented v1 won't-fix (cope items)

- Automatic badge-override detection at `submit_timesheet` — needs `badge_records` schema; customer conversation required
- 1× vs 2× SLA stall escalation split (current code includes admins at 1×; spec says 2×)
- Idempotency-key concurrent-race hardening (current P0008 on PK conflict is acceptable)

---

## Execution order

All infrastructure + Claude-owned code items are ✅ as of 2026-05-05. Remaining
gates before client cutover, in order:

1. **#18 — Wire Netlify ↔ GitHub auto-deploy** (Invenio, ~5 min UI clicks).
   Until this lands, every commit needs a manual `netlify deploy --prod`.
2. **#5 — Phase A import** against the real `tk_*` dump from the customer.
3. **#6a–#6g — Phase B spreadsheets** (subs, employee-subs, project-subs,
   project-flows, silo-roles, project-roles, timekeeper-assignments).
4. **#7 — Approval flow templates** authored per active project.
5. **#15 — Monitoring alert target** wiring (SQL queries exist; just pick a
   destination).
6. **#8 — Go-live gate SQL** run immediately before cutover with the customer's
   tenant_id. Must show all gates green.
7. **Pre-cutover smoke:** `backend/scripts/prod-smoke.sh --tenant <uuid>` — 6
   non-destructive checks; pass = ready to send the URL to the customer.
