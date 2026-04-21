# Backend Test Plan

Companion to [backend-spec.md](backend-spec.md) v0.3.0. Organized by subsystem; each test is tagged **P0/P1/P2** for scheduling. Tests get written alongside the code they cover — this document is the checklist, not the implementation.

## Conventions

- **P0** — must pass before any deploy; blocking.
- **P1** — must pass before go-live; may be written after initial implementation.
- **P2** — nice-to-have; edge cases.
- Integration tests run against a **real PostgreSQL** (Testcontainers or a dedicated test DB) — no ORM/DB mocks, per §11.5.
- Concurrency tests use `Promise.all` of concurrent requests; assertions cover both the winner's effects and the loser's 409 response.
- Multi-tenant isolation tests assert cross-tenant reads return **404 (not 403)** to avoid existence leaks.
- Test fixtures live in `test/fixtures/`; factories use `@faker-js/faker` with deterministic seeds for reproducibility.

---

## 1. Authentication & sessions (§4)

### Unit

- **P0** argon2id round-trip: same password + salt → same hash; verify accepts correct password, rejects wrong.
- **P0** Password policy validation: min length, complexity, not-in-history, not-equal-to-username/email.
- **P1** `password_history` eviction: on change, oldest of last N entries drops off.

### Integration

- **P0** `POST /auth/login` valid: returns 200 + opaque token + user payload.
- **P0** `POST /auth/login` invalid: returns 401 with generic message (no user-existence leak).
- **P0** Session token resolves to `user_id` + `tenant_id` on subsequent authenticated requests.
- **P0** Rate-limited login: after N failures within M minutes, account is locked; returns 429; admin `POST /users/:id/unlock` restores.
- **P0** `POST /auth/change-password`: caller's session remains valid; all other sessions for the same user are invalidated (`password_version` bumped; stale tokens return 401).
- **P0** `POST /invites/:token/accept`: consumes invite; user → `active`; invite not reusable; expired invites return 410.
- **P0** `POST /users/:id/reset-password` (admin): existing sessions invalidated immediately; new invite generated; pre-cutover invites stay queued.
- **P0** `POST /users/:id/revoke` (admin): login blocked; sessions invalidated; user soft-deleted (historical attribution preserved).
- **P0** `POST /users/:id/restore` (admin): requires new invite flow before login resumes.
- **P1** Session absolute expiry: after `session_absolute_hours`, token fails regardless of activity.
- **P1** Session idle expiry: after `session_idle_minutes` of no requests, next request returns 401.
- **P1** `auth_events` row written for every login (success/fail), password change, admin reset, invite consumption, revocation; includes `tenant_id`, `user_id` (nullable for failed logins), `event_type`, `ip`, `user_agent`, `ts`.

---

## 2. Multi-tenancy & isolation (§3)

### Integration

- **P0** User in tenant A attempting any read/write on tenant B's resource → 404.
- **P0** RLS policies reject cross-tenant access even via a privileged DB connection (defense in depth).
- **P0** List endpoints (`/users`, `/employees`, `/timesheets`, `/approval-flows`, `/projects`, etc.) return only the caller's tenant's rows.
- **P1** `tenant_id` correctly populated on every INSERT via repository methods; spot-check all tenant-scoped tables.
- **P1** Session tokens cannot be replayed against a different tenant (token claim mismatches the DB row).

---

## 3. Approval workflow (§7)

### State transitions (§7.4)

- **P0** Valid transitions from §7.4: `draft → submitted → in_review → approved`; `in_review → rejected`; `rejected → (edit) → submitted`; `in_review → recalled → draft`.
- **P0** Field-only: `open → draft (claimed)`; `draft → open (released)`.
- **P0** Invalid transitions (e.g., `approved → draft`) return 409 `INVALID_STATE_TRANSITION` with current state in the body.
- **P1** `timesheets.status` and `approval_runs.status` stay consistent across transitions (verified with paired assertions).

### Routing (§7.4)

- **P0** Submit with `PROJECT_NOT_READY` preconditions missing → 409 with `missing` array: missing `project_flow_assignment`, missing silo roles, missing project roles.
- **P0** Submit with full configuration: creates `approval_run` at node 1, notifies eligible approvers, timesheet → `in_review`.
- **P0** Submit while legacy data is still in `draft` state (historical import) → correctly allowed; creates fresh run.
- **P1** Silo-scoped and project-scoped role resolution exercised at submit; correct `missing` enumeration per failing check.

### Concurrency (§7.4) — critical

- **P0** Two approvers POST `/approvals/:id/approve` concurrently: exactly one wins (run advances once; one `approval_actions` row); loser receives 409 `RUN_STATE_CHANGED` with latest state.
- **P0** Approve + reject race on same node: one wins, one gets 409; no inconsistent state.
- **P0** Same-actor retry with identical `Idempotency-Key`: second POST returns cached response; no extra `approval_actions` row.
- **P0** Different actors with same key value: treated as independent (keys are scoped to `(actor_user_id, key)`).
- **P0** Admin `/override` races with a regular `/approve`: exactly one wins.
- **P1** Targeted reassignment races with an approval: version check covers both; one succeeds.
- **P1** `approval_actions` insert is in the same transaction as the run UPDATE — a failed version check leaves no `approval_actions` row.

### Run lifecycle (§7.3, §7.4)

- **P0** `approval_actions` is append-only: UPDATE and DELETE statements rejected.
- **P0** Run terminates correctly on reject at any node; no further actions accepted; `closed_at` set.
- **P0** Recall by original submitter while run is open: run → `recalled`, timesheet → `draft`.
- **P0** Recall by non-original-submitter: 403.
- **P0** Admin override writes `approval_actions` with `action='admin_override'`; separate `approval_reassignments` row when a reassignment is involved.
- **P1** Reject fanout: submitter + silo foreman + silo timekeeper_admin all receive email + webhook.

### Admin reassignment (§7.5)

- **P0** Targeted reassignment writes both `approval_reassignments` and `approval_actions`; new user can act.
- **P0** Structural reassignment (editing `silo_role_assignments`): existing open runs pick up new user on next poll.
- **P1** Reassignment on a non-open run returns 409.

---

## 4. Timesheets (§6.6)

### Staff

- **P0** `POST /timesheets` with `kind=staff` creates draft; `PATCH` allowed while draft; `PATCH` rejected once submitted.
- **P0** Submit splits multi-project weeks into N `timesheets` rows + N `approval_runs`.
- **P0** Partial state: project A approved + B rejected + C pending; submitter can only edit B's rows; A and C locked read-only.
- **P0** Resubmit scope: editing only B's rows and resubmitting creates a new run for B only; A and C untouched.
- **P1** Period-end payroll export treats each `(employee, week, project)` row independently.

### Field (including `open` state)

- **P0** Admin/timekeeper creates field timesheet in `open` state with crew, project, area, task, day.
- **P0** Any submitter with `submitter_assignments` on that silo can claim: status → `draft`, `submitter_user_id` = caller.
- **P0** Claimer releases: status → `open`, `submitter_user_id` cleared.
- **P0** Non-claimer attempting to edit a `draft`: 403.
- **P0** Non-silo-assignee attempting to claim: 403.
- **P0** Submit by claimer: status → `submitted`; routing algorithm runs per §7.4.

---

## 5. Badge override reconciliation (§7.7)

### Detection

- **P0** On field-timesheet submit: mismatch between `timesheet_lines.hours_*` and `badge_records` → one `badge_overrides` row per mismatched line.
- **P0** No mismatch → no override rows.
- **P1** Retroactive override (manual POST by timekeeper/admin): creates row with or without `timesheet_line_id`; opens its own run.

### Parallel flow

- **P0** Override run is independent of parent timesheet's approval run: parent can advance/approve while override is open.
- **P0** Override resolved `submitted_canonical`: parent run unaffected; override closes; `reason` required.
- **P0** Override resolved `badge_canonical` while parent still open: parent transitions to `rejected` with `HOURS_RECONCILED_TO_BADGE`; standard reject fanout fires.
- **P0** Override resolved `badge_canonical` after parent approved: writes `parent_approval_invalidated` audit event; tenant admins notified.
- **P1** Payroll export: `pending_reconciliation=true` flag present on approved timesheet lines with still-open overrides.
- **P1** Concurrency: override resolution and parent run transitions follow the same optimistic-version pattern; races on either produce 409 with `RUN_STATE_CHANGED`.

---

## 6. Notifications (§7.6)

### Integration

- **P0** `submit` event: submitter gets ack; foreman + timekeeper_admin receive; current-node approvers receive "your turn."
- **P0** `reject` event: submitter + silo foreman + silo timekeeper_admin receive emails with rejecting user + comment.
- **P0** Stall detection: scheduled job flags runs where `current_node` has been idle > `tenant.stall_hours`; sends reminders; second notification at 2× SLA escalates to tenant admins.
- **P0** Webhook signing: outbound POST includes `X-TK-Signature` HMAC over body; signature verifies on a test receiver.
- **P1** Webhook retry: 3 attempts with exponential backoff; persistent failures write to `notification_failures` and alert tenant admins.
- **P1** Recipient deduplication: a user holding both `foreman` and `timekeeper_admin` on a silo receives one email per event.
- **P2** Email delivery failures log to `auth_events`; do not retry in-app (SMTP queue absorbs).

---

## 7. Migration / re-platforming (§9)

### Phase A — data import

- **P0** `POST /admin/import-localstorage` is idempotent on a freshly provisioned tenant.
- **P0** External-ID preservation: `employees.external_id='E001'`, `projects.external_id='P001'`, etc., match source.
- **P0** Role remapping correctness: `admin → admin`; `staff → submitter` with `employee_id` populated; `timekeeper → submitter`.
- **P0** User records imported with `password_hash=NULL`, `status=pending`; invites queued but not sent.
- **P1** Historical timesheets imported as `draft` with no approval runs attached.

### Phase B — spreadsheet ingestion

- **P0** Each spreadsheet validates before loading: unknown user/project/sub references → upload rejected with row-level error detail.
- **P0** Idempotent ingestion: re-uploading identical content is a no-op; diffs are explicit and shown before applying.
- **P0** Referential integrity on load: `silo_role_assignments.user_id` must resolve to an active user; mismatched → rejected.
- **P1** Phase B readiness endpoint (`GET /projects/:id/readiness`) returns accurate `missing` list per active tenant resource.

### Go-live gate

- **P0** Every check in §9 go-live gate is reflected in a programmatic readiness endpoint.
- **P0** Cutover cannot proceed while any gate check fails; clear error identifying what's missing.
- **P0** Legacy-user audit: every entry in the source `tk_users` blob is either imported or explicitly archived; no silent drops.
- **P1** Invite release at cutover: transitions all queued invites to sent; legacy app marked read-only.

---

## 8. Export (§8)

- **P0** `GET /exports/labor?status=approved&from=&to=&project_id=`: returns CSV or XLSX matching the `test_export.xlsx` shape.
- **P0** Admin-only; all other roles → 403.
- **P1** Pagination/chunking for large tenants: >10k-row exports don't time out synchronously (switch to async job pattern if needed).
- **P2** v2 rate-enrichment fields (`base_rate`, `burdened_rate`, `billable_rate`, `*_amount`) — deferred.

---

## 9. End-to-end scenarios

### Happy paths

- **P0** Staff submit → node 1 approves → node 2 approves → terminal `approved` → labor export includes the line.
- **P0** Field admin creates `open` timesheet → foreman claims → fills hours → submits → approval chain runs to terminal.

### Unhappy paths

- **P0** Submit → reject at node 2 → submitter edits → resubmit → new run created → chain runs to `approved`.
- **P0** Submit → node 1 stalls > 48h → stall notification → admin reassigns → new approver acts → chain continues.
- **P0** Admin override: admin approves a mid-flow run directly; audit shows `admin_override` action.

### Badge reconciliation overlay

- **P0** Submit with mismatch → parent run starts + override opens → timekeeper_admin resolves as `submitted_canonical` → parent run approves normally.
- **P0** Submit with mismatch → parent run approves before override resolved → override resolved as `badge_canonical` → parent run audit-invalidated; admin alerted.

---

## 10. Non-functional

### Performance

- **P1** `GET /approvals/mine` polling load: 200 concurrent approvers at 30s intervals — p99 response time < 200ms.
- **P1** Submit latency: < 500ms p99 including routing + readiness check + notification enqueue.
- **P2** Labor export: 10k-row tenant completes synchronously within 30s; beyond that, async job pattern.

### Security

- **P0** Tenancy isolation tested on every write endpoint (see §2).
- **P0** Session replay: revoked-session tokens rejected immediately (tested by revoking, then retrying with captured token).
- **P0** SQL injection smoke tests on every endpoint accepting user-controlled strings (ORM handles; verify).
- **P0** Webhook signature verification resistance: capture + replay → rejected (timestamp in signed payload enforces freshness).
- **P1** Rate limits enforced on login, invite acceptance, password reset.
- **P1** `Idempotency-Key` storage never leaks response bodies cross-tenant or cross-user.

### Observability

- **P1** Structured logs include `tenant_id`, `user_id`, `request_id` on every request; PII fields scrubbed.
- **P1** Metrics: request count + latency per endpoint; DB query timings; BullMQ queue depth.
- **P2** Distributed tracing via OpenTelemetry.

---

## 11. Known gaps & TODO

Items deferred from the adversarial analysis ([adversarial-analysis-backend-spec.md](adversarial-analysis-backend-spec.md)) that will spawn additional tests once addressed:

- **M-12** `approval_node_approvers` NULL-in-UNIQUE — verify `NULLS NOT DISTINCT` or partial-index implementation prevents duplicates.
- **M-14** Silo flow reassignment mid-run — verify open runs retain original flow; new submissions pick up new flow.
- **L-15** Polling load at larger scale (500+ approvers) — measure, decide if pubsub (Postgres LISTEN/NOTIFY) is warranted.
- **L-16** Role-dependent idle timeout for submitters — if adopted, add tests for field-role tokens not expiring at 30min.

These are tracked as open items; tests are added when the corresponding spec/implementation is added.
