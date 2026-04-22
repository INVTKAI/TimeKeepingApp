# TimeKeepingApp v1 launch checklist

Living doc. Update status + dates as items land. Source of truth for "are we ready to cut over?"

**Prod Supabase project:** `TimeKeepingApp` · ref `rrgocxusfaxzwgnjxpdh` · East US (N. Virginia) · Pro tier · region matches customer's US location.

**Email domain:** `inveniotech.org` (DNS access confirmed user-side 2026-04-22). Supabase Auth emails from `noreply@inveniotech.org`; tenant notification default from-address same until per-tenant override.

Status key: ✅ done · 🟡 in flight · ⏳ not started · 🚫 blocked

---

## Blocking — must land before customer cutover

### Infrastructure

| #   | Item                                                          | Status | Owner   | Notes                                                                                                 |
| --- | ------------------------------------------------------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Pro-tier Supabase project provisioned                         | ✅     | Invenio | Confirmed 2026-04-22                                                                                  |
| 2a  | Migrations pushed (14 files, 2026-04-22)                      | ✅     | Claude  | Applied 2026-04-22 via `supabase db push`. `migration list --linked` confirms Local=Remote for all 14. Smoke: PostgREST live (anon SELECT tenants → 200 []); submit_timesheet RPC reachable and returns P0005 TENANT_CLAIM_MISSING on unauthenticated call (confirms assert helpers work) |
| 2b  | Auth hooks wired (custom_access_token + password_verification) | ⏳     | Invenio | Dashboard → Authentication → Hooks. Without `custom_access_token`, every RPC returns P0005 TENANT_CLAIM_MISSING |
| 2c  | pg_cron + pg_net extensions enabled                            | 🟡     | Invenio | Apply `backend/scripts/prod-bootstrap.sql` in Dashboard → SQL Editor (needs secret replacement first) |
| 2d  | pg_cron schedules registered                                   | 🟡     | Invenio | Same `prod-bootstrap.sql` registers all three. Idempotent on re-run                                   |
| 2e  | `NOTIFICATION_DRAIN_SECRET` set in prod EF env                 | ✅     | Claude  | Set 2026-04-22 via `supabase secrets set` (48-char random). Smoke: drain returns 403 on wrong secret + 200 + claimed:0 on correct |
| 3a  | Custom SMTP configured (Resend)                                | ⏳     | Invenio | Dashboard → Authentication → SMTP. Use the RESEND_API_KEY already in backend/.env                     |
| 3b  | DNS records for `inveniotech.org` email (SPF / DKIM / DMARC)  | ⏳     | Invenio | Resend provides the records to add. User has DNS access confirmed                                     |
| 3c  | `RESEND_API_KEY` set in prod EF env                            | ✅     | Claude  | Set 2026-04-22 alongside drain secret. drain-notifications will deliver real email from next cron tick after DNS + SMTP land |
| 4   | Supabase Auth email templates (invite, recovery) with customer branding | ⏳ | Invenio | Dashboard → Authentication → Email templates; at minimum customize subject + copy for `inveniotech.org` |

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
| 12  | Frontend Playwright happy-path test                           | ⏳     | Claude | Sign-in → dashboard → approve → export. 30 min setup                                                  |
| 13  | True multi-session P0002 concurrency test                     | ✅     | Claude | `backend/tests-integration/concurrency.test.ts` — two parallel `approve_run`; 5/5 reliable             |
| 14  | Import dashboards (frontend UI)                               | ⏳     | Claude | File upload driving `import-localstorage` + `import-spreadsheet`                                       |
| 15  | Monitoring / alerting                                         | ⏳     | Invenio | Alert on `notification_failures` spike, stuck `sending` rows > 15 min, drain failures                  |
| 16  | Service-role key rotation runbook (§11.7)                     | ✅     | Claude | `docs/ops/service-role-rotation-runbook.md`                                                           |
| 17  | Backup / restore procedure doc                                | ✅     | Claude | `docs/ops/backup-restore-runbook.md`                                                                  |

---

## v1.1 / nice-to-have (NOT blocking)

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

1. ✅ Push migrations to prod (#2a) — applied 2026-04-22
2. ✅ EF secrets set (#2e, #3c) + all 11 Edge Functions deployed
3. 🟡 Run prod-bootstrap.sql in Dashboard SQL Editor (#2c + #2d) — enables extensions + registers schedules
4. ⏳ Enable Auth hooks in Dashboard (#2b) — without this every RPC returns P0005
5. ⏳ Wire Resend SMTP + DNS for inveniotech.org (#3a + #3b) — unlocks real invite/recovery emails
6. ⏳ Customize Supabase email templates with branding (#4)
7. Build #12 (Playwright), #14 (import dashboards), #15 (monitoring queries) as parallel tracks
8. Customer data: #5 (Phase A real dump) → #6 (Phase B spreadsheets) → #7 (flow templates)
9. #8 go-live gate — run immediately before cutover to confirm all invariants green
