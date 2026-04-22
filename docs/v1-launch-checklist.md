# TimeKeepingApp v1 launch checklist

Living doc. Update status + dates as items land. Source of truth for "are we ready to cut over?"

**Prod Supabase project:** `TimeKeepingApp` · ref `rrgocxusfaxzwgnjxpdh` · East US (N. Virginia) · Pro tier · region matches customer's US location.

Status key: ✅ done · 🟡 in flight · ⏳ not started · 🚫 blocked

---

## Blocking — must land before customer cutover

### Infrastructure

| #   | Item                                                          | Status | Owner   | Notes                                                                                                 |
| --- | ------------------------------------------------------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Pro-tier Supabase project provisioned                         | ✅     | Invenio | Confirmed 2026-04-22                                                                                  |
| 2a  | Migrations pushed (14 files, 2026-04-22)                      | 🟡     | Claude  | Project linked; `supabase migration list --linked` confirms 0 remote. `supabase db push` — awaits user confirm  |
| 2b  | Auth hooks wired (custom_access_token + password_verification) | ⏳     | Claude  | `config.toml` wires these locally; prod requires enabling in Dashboard → Auth → Hooks                 |
| 2c  | pg_cron extension enabled + `pg_net` extension enabled        | ⏳     | Claude  | Dashboard → Database → Extensions                                                                     |
| 2d  | pg_cron schedules: `drain-notifications`, `reconcile-stuck-sending`, `emit-stall-notifications` | ⏳ | Claude | SQL in `backend/README.md` "Production deployment notes" |
| 2e  | `NOTIFICATION_DRAIN_SECRET` set in prod Edge Function env     | ⏳     | Claude  | Rotate the local-dev value; store in Vault or Edge Function secrets                                   |
| 3a  | Custom SMTP configured (Resend)                               | ⏳     | Invenio | Needs `RESEND_API_KEY` as a platform secret; Dashboard → Auth → SMTP                                  |
| 3b  | DNS records for `invenio-tek.com` email (SPF / DKIM / DMARC)  | ⏳     | Invenio | Resend provides the records to add                                                                    |
| 3c  | `RESEND_API_KEY` set in `drain-notifications` Edge Function env | ⏳   | Claude  | For domain-notification emails (separate from Supabase Auth SMTP)                                     |
| 4   | Supabase Auth email templates (invite, recovery) with customer branding | ⏳ | Invenio | Dashboard → Auth → Email templates; at minimum customize subject + copy             |

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
| 11  | End-to-end smoke script (seed tenant → invite → submit → approve → drain → Mailpit verify) | ⏳ | Claude | ~100 lines of shell/Deno. Ops runs before every release                             |
| 12  | Frontend Playwright happy-path test                           | ⏳     | Claude | Sign-in → dashboard → approve → export. 30 min setup                                                  |
| 13  | True multi-session P0002 concurrency test                     | ⏳     | Claude | Two psql sessions racing `approve_run`; exactly one should get P0002                                   |
| 14  | Import dashboards (frontend UI)                               | ⏳     | Claude | File upload driving `import-localstorage` + `import-spreadsheet`                                       |
| 15  | Monitoring / alerting                                         | ⏳     | Invenio | Alert on `notification_failures` spike, stuck `sending` rows > 15 min, drain failures                  |
| 16  | Service-role key rotation runbook (§11.7)                     | ⏳     | Claude | Document annual + post-incident + post-personnel rotation procedure                                    |
| 17  | Backup / restore procedure doc                                | ⏳     | Invenio | Supabase Pro = 7-day automated backups; document the `db dump` restore path                            |

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

1. Push migrations to prod (#2a) — unblocks everything downstream
2. Enable extensions + wire Auth hooks (#2b, #2c)
3. Build #9 + #10 (missing admin UIs) while #3, #4 are Invenio-gated
4. Register pg_cron schedules (#2d) — requires #3 be ready for the drain to actually deliver email
5. #11 + #13 + #16 + #17 (runbooks + tests) — runnable against the local stack
6. #12 (Playwright) once any stable UI is live
7. Customer data (#5 #6 #7) — the actual go-live sequence
8. #8 go-live gate — run immediately before cutover
