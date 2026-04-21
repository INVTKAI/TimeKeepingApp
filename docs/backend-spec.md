# TimeKeepingApp — Backend Specification

**Status:** Draft v0.3.0 — design intent, not yet implemented. Adversarial review complete (all 6 HSI resolved). Implementation-readiness additions in this revision: badge override parallel flow (§7.7), `open` state for field timesheets (§6.6, §7.4), partial-state UX for split staff timesheets (§6.6), tenants schema completion (§3), and new §11 Implementation stack & conventions. Companion: [backend-test-plan.md](backend-test-plan.md). See Revision Log at bottom.
**Scope:** A multi-tenant backend to replace the current localStorage-only prototype. Adds authentication with full password lifecycle, role-based access control, subcontractor modeling, and a configurable multi-node approval workflow for submitted hours.

This document specifies the **what** and the **data/API shape**. It is deliberately implementation-agnostic (no framework lock-in) but assumes an HTTP/JSON API backed by a relational store (Postgres-style) with bcrypt/argon2 password hashing and signed session tokens (JWT or opaque).

---

## 1. Goals

1. Replace in-browser localStorage with a real persistent backend.
2. Support **multi-tenancy** — each customer organization isolated at the row level.
3. Full **password lifecycle** (issue, change, admin-reset, revoke) with hashed storage.
4. **Three roles** (`admin`, `approver`, `submitter`) with scoped permissions.
5. **Subcontractor modeling** as a first-class entity, M:N with projects, time-bounded.
6. **Configurable approval workflow** — up to 5 ordered nodes per flow, any-of approvers per node.
7. **Approval routing** — one flow template per project; flow nodes resolve approvers by role label. Silo-scoped roles (e.g. `foreman`, `timekeeper_admin`) vary per subcontractor; project-scoped roles (e.g. `pm`, `accounting`, `prime_rep`) are stable across the project.
8. **Full audit trail** for every approval action and admin override.

## 2. Non-goals (v1)

- Cost/rate calculations and billing (flagged for v2 — `test_export.xlsx` shows the shape).
- Cross-tenant user membership.
- External SSO / OAuth (local credentials only; can be layered later).
- Mobile-specific APIs (reuse the same endpoints).
- Real-time push / websockets for approval notifications (email/webhook only in v1).

---

## 3. Multi-tenancy

Every domain row carries a non-null `tenant_id`. All queries filter by the tenant of the authenticated principal. Enforcement:

- **Application-level**: every repository method takes `tenant_id` and includes it in the `WHERE` clause.
- **Defense-in-depth**: Postgres Row-Level Security policies on every tenant-scoped table keyed off a `current_setting('app.tenant_id')` GUC set at session start.

A user belongs to exactly one tenant. Session tokens embed `tenant_id` — all requests for rows in a different tenant return 404 (not 403, to avoid leaking existence).

Tenants are provisioned by a **super-admin** out of band (seed script / ops runbook). The three user-facing roles are scoped *within* a tenant; the super-admin is a separate concept and does not have a normal login.

| Table | Column | Notes |
| --- | --- | --- |
| `tenants` | `id`, `name`, `slug`, `status`, `created_at`, `timezone`, `locale`, `email_from_address`, `webhook_url` NULL, `webhook_signing_secret_ref` NULL, `session_absolute_hours`, `session_idle_minutes`, `stall_hours` | `slug` unique; `status` ∈ {`active`,`suspended`}. Defaults: `timezone='UTC'`, `locale='en-US'`, `session_absolute_hours=12`, `session_idle_minutes=30`, `stall_hours=48`. `webhook_signing_secret_ref` points at a secrets-manager key, not the raw secret. |

---

## 4. Authentication & password lifecycle

### 4.1 Password storage

- `argon2id` with per-user salt. No plaintext anywhere, ever — including logs and error messages.
- `password_hash` column on `users`.
- Old password hashes retained in `password_history` (last N=5) to block reuse on self-change.

### 4.2 Sessions

- On successful login, issue a session token (JWT signed with tenant-rotating key, or opaque token stored in `sessions` table — recommend opaque for revocability).
- Token includes `user_id`, `tenant_id`, `role`, `issued_at`, `expires_at`.
- Sliding expiration: 12h absolute, 30min idle. Configurable per tenant.
- On password change, admin reset, or user revocation: **all existing sessions invalidated** (tracked by `password_version` column on `users`; token claim must match).

### 4.3 Allocation (new user creation)

1. `admin` creates user with username + email + role + (optional) `employee_id`. No password set.
2. Backend generates a one-time invite token (`invites` table: `user_id`, `token_hash`, `expires_at`, `consumed_at`) valid for 7 days.
3. Email/deliver the invite link: `/accept-invite?token=…`.
4. User POSTs a new password; backend validates token, hashes password, marks invite consumed, marks user `status='active'`.

### 4.4 Self-service update

- User provides current password + new password.
- Policy enforced: minimum length, complexity, not in `password_history`, not equal to username/email.
- On success: bump `password_version` → all other sessions invalidated, current session kept alive with a re-issued token.

### 4.5 Admin reset

- `admin` triggers reset for a user → generates a new invite token, emails it, and marks the user's password as expired (`password_expired_at=now()`).
- All existing sessions for that user invalidated immediately.
- User must complete the invite flow before next login.

### 4.6 Revocation

- `admin` sets user `status='revoked'`.
- All sessions invalidated; login blocked.
- User is **soft-deleted**: historical approval actions, timesheet submissions, and audit rows still attribute to this user for auditability.
- Revocation is reversible by another admin (`status` → `active`); however, a new password must be issued (invite flow) before login resumes.

### 4.7 Audit

- Every login attempt (success/fail), password change, admin reset, invite consumption, and revocation writes to `auth_events` with `tenant_id`, `user_id` (nullable on failed login), `event_type`, `ip`, `user_agent`, `ts`.
- Rate limit failed logins: lock account after N failures within M minutes; admin can unlock.

---

## 5. Roles & permissions

The system has **two roles** — set per user, single-valued:

- `admin` — tenant operator.
- `submitter` — anyone who enters hours (their own, their crew's, or as a proxy across silos).

**Approval authority is not a role.** It is a *capability* derived from a user's presence in one or more assignment tables (`silo_role_assignments`, `project_role_assignments`, or `approval_node_approvers`). This matches the customer's operating reality: the same person is commonly a worker who submits their own hours *and* an approver on someone else's runs — a sub's foreman enters their crew's time *and* signs off at node 1; a prime rep who is sub-employed submits their own timesheet *and* acts as final approver on that project.

### `admin`
- Full CRUD on tenant-scoped resources: users, employees, subcontractors, projects, project↔sub assignments, areas, task codes, CWPs, FCOs, approval flow templates, silo/project role assignments, flow assignments.
- Issue/reset/revoke credentials.
- **Reassign** a stalled approval node to a different approver (see §7.5).
- View any timesheet, any approval run, any audit trail.
- Cannot approve hours themselves *unless* explicitly named in a flow's approver pool or assigned to a role that resolves onto a node (admin role ≠ auto-approver).

### `submitter`
- Creates and submits time entries.
- Scope is determined by two signals:
  - `employee_id` set on the user → can submit for **self** (the staff-timesheet flow).
  - `submitter_assignments` rows → can submit **on behalf of others** on specified `(project, subcontractor)` silos (the field-timesheet / foreman / timekeeper flow).
- A single user may have both: self + proxy scopes.
- UI filters the pickable employees and projects to match the user's scope.

### Approval capabilities (overlay on any role)

Any non-revoked user — `admin` or `submitter` — may gain approval authority by being referenced in:

- `approval_node_approvers` with `approver_type='user'` (named directly in a flow template),
- `silo_role_assignments` matching a node's `(role_label, 'role_on_silo')` reference, or
- `project_role_assignments` matching a node's `(role_label, 'role_on_project')` reference.

At run time, the backend resolves the eligible-actor set for a given node by querying these tables. "Can user X act on run Y at node Z?" is strictly derived from assignment membership — there is no `approver` role flag to check.

A user may hold approval authority on some runs while having none on others. Users with no assignments and no admin role simply have no approval responsibilities.

### Foreman vs. timekeeper vs. self-entering staff vs. prime rep

All are `submitter`; they differ in `submitter_assignments` and in which assignment tables grant them approval capability:

| Pattern | `employee_id`? | `submitter_assignments` | Approval-capability source | Effect |
| --- | --- | --- | --- | --- |
| Staff (self-entry) | yes | none | none (typically) | Self timesheets only |
| Foreman | yes (field) | 1 row: their (project, sub) | `silo_role_assignments` with `role_label='foreman'` | Self + crew within silo; signs off at node 1 |
| Timekeeper | usually no | many rows across projects/subs | optional — may hold `timekeeper_admin` | Proxy submission; may also be a node-1 approver where assigned |
| Prime rep | yes (their sub) | none (typically) | `project_role_assignments` with `role_label='prime_rep'` | Self timesheets + final approver on the project |

Foreman UI is restricted by the backend returning only data within their submitter + silo-role assignments — no client-side trust.

### Role change
- Only `admin` can change another user's role (`admin` ↔ `submitter`).
- Role change invalidates sessions (forces re-login); audit row written.
- Adding or removing approval capability (via assignment-table edits) does **not** invalidate sessions; it just changes what the user sees on their next `GET /approvals/mine` poll.

---

## 6. Core domain model

### 6.1 Tenants & users

```
tenants(id, name, slug, status, created_at)

users(
  id, tenant_id, username, email, role,  -- role ∈ {admin, submitter}  (approval authority is a capability, not a role — see §5)
  employee_id NULL,                       -- FK to employees; NULL for admins or non-worker oversight users
  password_hash NULL,                     -- NULL until invite consumed
  password_version,                       -- bumped on any password change/reset/revoke
  password_expired_at NULL,
  status,                                 -- {pending, active, revoked}
  created_at, created_by,
  UNIQUE(tenant_id, username),
  UNIQUE(tenant_id, email)
)

invites(id, user_id, token_hash, expires_at, consumed_at NULL, created_by)
password_history(user_id, password_hash, created_at)
sessions(id, user_id, token_hash, issued_at, expires_at, revoked_at NULL, ip, user_agent)
auth_events(id, tenant_id, user_id NULL, event_type, ip, user_agent, ts, details JSONB)
```

### 6.2 Employees

Migrated from the current `DB.employees`:

```
employees(
  id, tenant_id,
  external_id,          -- original 'E001' etc., preserved for migration
  first_name, last_name, type,   -- type ∈ {field, staff}
  craft, active,
  subcontractor_id,     -- current employer; historical moves tracked separately
  created_at
)

employee_subcontractor_history(
  employee_id, subcontractor_id, started_at, ended_at NULL
)
```

**Rule:** every employee must have a current `subcontractor_id`. Internal Invenio employees belong to the "Invenio" subcontractor row — there is no special-case for internal (per §7 below).

### 6.3 Subcontractors

```
subcontractors(
  id, tenant_id,
  name, short_code,
  active,
  created_at
)
```

"Invenio" (the prime) is inserted as a subcontractor row during tenant provisioning. For approval routing purposes it is treated identically to any other sub — its silo flow just happens to be the all-internal one.

### 6.4 Projects, areas, and project↔subcontractor silos

```
projects(id, tenant_id, number, name, active, created_at)

areas(id, tenant_id, project_id, code, name)

project_subcontractors(
  id, tenant_id, project_id, subcontractor_id,
  start_date, end_date NULL,             -- subs come and go
  UNIQUE(tenant_id, project_id, subcontractor_id, start_date)
)
```

A **silo** is a `(project_id, subcontractor_id)` pair. It may have multiple historical `project_subcontractors` rows (sub left and came back). The flow assignment (§7.2) is keyed on this pair with its own effective-dating, independent of the engagement dates.

### 6.5 Reference data

```
task_codes(id, tenant_id, code, name)
cwps(id, tenant_id, code, description)
fcos(id, tenant_id, code, description)
```

### 6.6 Time entries

Two submission types, unified by a parent `timesheet` record so approval runs attach cleanly.

```
timesheets(
  id, tenant_id,
  kind,                          -- {staff, field}
  status,                        -- see §7 state machine
  submitter_user_id,             -- who pressed submit
  employee_id NULL,              -- for kind=staff (the worker); NULL for field
  project_id,                    -- denormalized for silo lookup (field: from parent; staff: one per line, see note)
  subcontractor_id,              -- snapshotted from employee's current sub at submit; stable for the timesheet's lifetime (mid-period sub transitions produce separate timesheets)
  period_start, period_end,      -- week for staff; day for field
  created_at, submitted_at NULL
)
```

**Staff-timesheet note:** the current frontend allows multiple projects per weekly timesheet. For backend sanity and to make approval routing unambiguous, the backend will split a weekly submission into **one `timesheets` row per `(employee, week, project)`** — each routes through its own silo. The frontend can still present one weekly grid; the submit handler is responsible for the split.

**Field-timesheet `open` state:** field timesheets have an additional pre-submission state, `open`, not present on staff timesheets. An admin (or timekeeper with appropriate `submitter_assignments`) creates a field timesheet in `open` — pre-filled with project/area/task/day/crew but zero hours, no `submitter_user_id`. Any submitter with `submitter_assignments` on that silo can **claim** the timesheet into `draft` (setting `submitter_user_id` to themselves); once in `draft`, only the claimer may edit, until they submit or **release** it back to `open` for another submitter to pick up. State flow: `open → draft → submitted → …`. Staff timesheets skip `open` and start at `draft`.

**Partial-state handling for split staff timesheets:** the `(employee, week, project)` split means one weekly submission becomes N independent `timesheets` rows and N independent `approval_runs`. Each routes through its own project's flow and reaches its own terminal state. The frontend renders the weekly grid with per-project status badges; if project A is approved and project B rejected, the submitter edits only B's rows — project A and pending-project C rows are locked read-only. Resubmit scope is the rejected project only: a new `approval_run` is opened for that single `timesheets` row, leaving approved rows untouched. Payroll downstream treats each `(employee, week, project)` row independently for period-end summation.

```
timesheet_lines(
  id, timesheet_id, tenant_id,
  date,
  area_id NULL, task_code_id NULL, cwp_id NULL, fco_id NULL,
  employee_id,                   -- for field: each crew member; for staff: same as parent
  hours_st, hours_ot,
  comment
)

badge_overrides(
  id, tenant_id,
  timesheet_line_id NULL,        -- FK: which line triggered the mismatch; NULL if retroactive
  employee_id, date,
  submitted_hours_st, submitted_hours_ot,
  badge_hours_st, badge_hours_ot,
  reason,                         -- free-text explanation, required at resolution
  status,                         -- {open, resolved_submitted_canonical, resolved_badge_canonical}
  resolved_by_user_id NULL, resolved_at NULL,
  opened_at, opened_by_user_id
)
```

---

## 7. Approval system

### 7.1 Flow templates

A flow is a reusable template. Up to **5 ordered nodes**. Flows are assigned to projects (not silos — see §7.2); a node resolves approvers via one of three mechanisms: specific named user, silo-scoped role, or project-scoped role.

```
approval_flows(
  id, tenant_id, name, description, active, created_at
)

approval_nodes(
  id, flow_id, tenant_id,
  ordinal,         -- 1..5
  name,            -- e.g. "Foreman", "Super", "PM", "Accounting"
  UNIQUE(flow_id, ordinal)
)

approval_node_approvers(
  id, node_id, tenant_id,
  approver_type,       -- {user, role_on_silo, role_on_project}
  user_id NULL,        -- when approver_type='user'
  role_label NULL,     -- when approver_type='role_on_silo' or 'role_on_project'
  UNIQUE(node_id, approver_type, user_id, role_label)   -- use NULLS NOT DISTINCT or per-branch partial indexes
)
```

**Approver resolution at run time:**
- `approver_type='user'` → that specific user (must still be `active`; approval authority is granted purely by this membership — see §5).
- `approver_type='role_on_silo'` → look up `silo_role_assignments` by `(project_id, subcontractor_id, role_label)` and return any active user.
- `approver_type='role_on_project'` → look up `project_role_assignments` by `(project_id, role_label)` and return any active user.

The eligible-approver list for a node is the **union** of the three mechanisms' results; the node advances on the **first** action (`any-of`, per §1 requirement).

```
silo_role_assignments(
  id, tenant_id,
  project_id, subcontractor_id, role_label, user_id,
  effective_from, effective_to NULL,
  UNIQUE(tenant_id, project_id, subcontractor_id, role_label, user_id, effective_from)
)

project_role_assignments(
  id, tenant_id,
  project_id, role_label, user_id,
  effective_from, effective_to NULL,
  UNIQUE(tenant_id, project_id, role_label, user_id, effective_from)
)
```

Admins populate these tables to declare things like "for project X sub Y, the foreman is Alice" (`silo_role_assignments`) and "for project X, the PM is Bob" (`project_role_assignments`) without editing flow templates when people change roles.

**Scope rule:** use `silo_role_assignments` when the role varies per subcontractor on the project (`foreman`, `timekeeper_admin`). Use `project_role_assignments` when the role is constant across all subs on the project (`pm`, `accounting`, `prime_rep`). A given `role_label` is used at one scope only; mixing (the same label appearing in both assignment tables) is rejected by admin UI validation.

Role labels are free-form strings, but the following are **reserved** and carry notification semantics (see §7.6):

| Reserved label | Scope | Meaning |
| --- | --- | --- |
| `foreman` | silo | Node-1 approver for the silo. Always a user — foremen submit their own hours for payroll, so they necessarily have accounts. Multiple foremen per silo are supported (the `silo_role_assignments` UNIQUE constraint permits multiple rows per silo+label). Notified on submit, reject, and stall. |
| `timekeeper_admin` | silo | Oversight user accountable for clean intake on this silo. Notified on submit, reject, stall, and reassign. |
| `pm` | project | Project manager. No implicit notifications beyond being on a node's approver pool. |
| `super` | silo | Project superintendent — per-sub in practice. |
| `accounting` | project | Accounting / payroll approver. |
| `prime_rep` | project | Prime contractor's representative on the project. Typically a sub-employed user wearing a prime-oversight hat. |

### 7.2 Project flow assignments — "which flow does this submission use?"

```
project_flow_assignments(
  id, tenant_id,
  project_id,
  flow_id,
  effective_from, effective_to NULL,
  UNIQUE(tenant_id, project_id, effective_from)
)
```

At submit time the backend resolves the active assignment for `(project_id, submitted_at)`. Flow templates are **project-scoped** — all subs submitting on a project share the same template; resolved approvers vary per silo at nodes that use `role_on_silo` references (§7.1).

If no assignment exists (or any required role resolution is empty at submit time), submission is blocked with error code `PROJECT_NOT_READY`. The backend is **strict by design**: every project must be fully configured (flow + `silo_role_assignments` for each active silo's reserved labels + `project_role_assignments` for reserved project labels) before submissions are accepted against it. No tenant-level default flow; no draft-as-grace mode.

Two UX tweaks make the strict stance workable:

1. **Structured error body.** The 409 response includes a `missing` array enumerating the specific preconditions not yet met (e.g., `["project_flow_assignment", "silo_role_assignments:sub=S003:role=foreman", "project_role_assignments:role=pm"]`) so the submitter sees a meaningful "not set up yet" message rather than a bare error code.

2. **Admin UI gate.** Every project exposes a derived `is_ready_for_submission` flag — true only when flow, silo roles, and project roles are all in place. Until true, the project does not appear in submitter dropdowns (`GET /projects/:id/readiness` in §8 returns the detail for the admin UI).

The silo concept (`(project, subcontractor)` pair — see §6.4) remains relevant for per-sub role resolution via `silo_role_assignments`; it does not participate in flow selection. Multiple concurrent silos per project (one per sub) is still the norm.

### 7.3 Runs (per-submission instances) & audit trail

```
approval_runs(
  id, tenant_id, timesheet_id, flow_id,
  status,                -- see §7.4
  current_node_id NULL,  -- NULL when terminal
  version INT NOT NULL DEFAULT 0,   -- optimistic concurrency; bumped on every state transition (see §7.4 "Concurrency")
  opened_at, closed_at NULL
)

approval_actions(
  id, tenant_id, run_id, node_id,
  actor_user_id,
  action,                -- {approve, reject, reassign, recall, admin_override}
  comment,
  ts
)                        -- append-only; no updates, no deletes

approval_reassignments(
  id, tenant_id, run_id, node_id,
  from_user_id NULL,     -- may be the whole pool if node stalled generically
  to_user_id,
  reason, admin_user_id, ts
)
```

Every user-visible approval event writes one `approval_actions` row. Admin reassignments also write to `approval_reassignments` for targeted reporting.

### 7.4 Status & routing algorithm

**Timesheet status** (on `timesheets.status`):

```
(field only)  open ⇄ draft → submitted → in_review → approved
(staff only)         draft → submitted → in_review → approved
                                                    ↘ rejected → (edit) → submitted (new cycle on same timesheet)
                                                    ↘ recalled  → draft  (submitter withdrew before terminal)

Field-only transitions involving `open`:
    open → draft   (any silo submitter claims an admin-pre-created timesheet; sets submitter_user_id)
    draft → open   (claimer releases; clears submitter_user_id; another silo submitter may re-claim)
```

**Approval run status** (on `approval_runs.status`): `open | approved | rejected | recalled | abandoned`.

**Concurrency (optimistic):** every state transition on `approval_runs` — advance on approve, terminate on reject/recall, reassignment, admin override — is performed as a conditional UPDATE keyed on the current `version`:

```sql
UPDATE approval_runs
SET status = ..., current_node_id = ..., version = version + 1
WHERE id = :run_id AND version = :current_version
```

If 0 rows are affected, another actor already changed the run — the transaction rolls back and the API returns 409 with error code `RUN_STATE_CHANGED` and the latest run state in the body. The `approval_actions` insert and any dependent `timesheets.status` update happen in the **same transaction** as the run UPDATE, so the audit log never contains an action for a transition that didn't happen. Clients don't pass the version — the server reads it atomically at the start of the transaction. Retried requests (e.g., network blips) should include an `Idempotency-Key` header (§8) so duplicates return the cached first-request response rather than racing as a new actor.

**Routing algorithm (on submit):**

```
1. Validate the submitter is authorized for (project, sub) per §5.
2. Compute subcontractor_id from the employee's current sub.
3. Resolve the active project_flow_assignment for (project_id, today) plus the role assignments for every `role_on_silo` / `role_on_project` reference in the flow's nodes (silo-scoped references resolved against this submission's silo).
   If any required configuration is missing → 409 with error code `PROJECT_NOT_READY` and a `missing` array enumerating specifics (see §7.2).
4. Create approval_run with current_node_id = node ordinal 1.
5. Notify eligible approvers (§7.6).
```

**On approve:**
- Authorize the actor is an eligible approver on `current_node_id`.
- Write `approval_actions` (action=`approve`).
- If `current_node_id.ordinal < max_ordinal`: advance to next node, notify its approvers.
- Else: mark run `approved`, timesheet `approved`.

**On reject:**
- Authorize as above.
- Write `approval_actions` (action=`reject`, comment required).
- Mark run `rejected`, timesheet `rejected`.
- **Notify three recipients** (see §7.6 for delivery mechanics):
  1. The original **submitter** — so they can edit and resubmit.
  2. The silo's **foreman** (user with `role_label='foreman'` on this `(project, sub)`) — accountable for the crew's hours even when a timekeeper pressed submit on their behalf.
  3. The silo's **timekeeper admin** (user with `role_label='timekeeper_admin'` on this `(project, sub)`) — accountable for clean intake.
  All three receive the same payload: rejecting user, node name, comment, and a link to the timesheet for edit/resubmit.
- Resubmit creates a **new run** on the same timesheet (preserves audit history of the prior rejection).
- Rejection at any node terminates the run; there is no "bounce back one node". (Rationale: simpler mental model. Configurable bounce-to-node is a v2 enhancement.)

**On recall (submitter before terminal):**
- Only allowed while run is `open` and submitter is the original submitter.
- Run → `recalled`, timesheet → `draft`.

### 7.5 Admin reassignment

Since there is no delegation, a stalled node is the admin's problem. Triggered two ways:

1. **Targeted**: admin names a new user for this specific run/node. Effect: on this run only, the approver pool for the current node is temporarily replaced by `to_user_id`. Writes `approval_reassignments` and `approval_actions` (action=`reassign`).

2. **Structural**: admin edits `silo_role_assignments` to change the role-on-silo mapping (e.g. replace the PM for this project/sub). Existing open runs targeting that role pick up the new user on their next poll; no run-level override needed.

Admin can also exercise **`admin_override`**: approve or reject any open node directly, writing an `approval_actions` row with action=`admin_override`. Restricted to `role='admin'`. Audited heavily.

### 7.6 Notifications

Every approval state transition fires notifications to a resolved recipient set. v1 delivery channels: **email** + **outbound webhook** (tenant-configured URL). No in-app inbox; approvers poll `GET /api/approvals/mine?status=pending`.

**Recipient resolution** combines the run's submitter and actor(s) with users matched via `silo_role_assignments` on the run's `(project, subcontractor)`. Reserved role labels (see §7.1) drive implicit routing.

**Events × recipients:**

| Event | Submitter | Foreman (silo) | Timekeeper admin (silo) | Current node approvers | Tenant admins |
| --- | :-: | :-: | :-: | :-: | :-: |
| Submitted | ack | ✓ | ✓ | ✓ (your turn) | — |
| Node advanced (mid-flow approve) | ✓ | — | — | ✓ (your turn) | — |
| Approved (terminal) | ✓ | ✓ | ✓ | — | — |
| **Rejected** | **✓** | **✓** | **✓** | — | — |
| Recalled by submitter | — | ✓ | ✓ | ✓ (cancellation) | — |
| Reassigned (admin, run-level) | — | — | ✓ | ✓ new + old | ✓ (audit copy) |
| Admin override | ✓ | ✓ | ✓ | ✓ if bypassed | — |
| Stalled past SLA | ✓ | ✓ | ✓ | ✓ (reminder) | — (1×) / ✓ (2×) |

**Stall detection:** daily job scans `approval_runs` where `current_node` has been unchanged longer than `tenant.stall_hours` (default 48). A second notification at 2× SLA escalates to tenant admins. No DB row is written for a stall event — it's a recurring notification trigger.

**Deduplication:** a user holding multiple reserved labels on a silo (e.g., foreman *and* timekeeper_admin) receives **one** email per event — recipient set is unioned before delivery.

**Delivery details:**
- **Email:** per-tenant from-address; subject format `[TK] {event}: {project} / {sub} — {period}`; body includes rejecting user and comment on rejection events.
- **Webhook:** POST to `tenant.webhook_url` with `X-TK-Signature` HMAC header. JSON payload:
  ```json
  {
    "event": "timesheet.rejected",
    "tenant_id": "...", "run_id": "...", "timesheet_id": "...",
    "project_id": "...", "subcontractor_id": "...",
    "actor": { "user_id": "...", "role_label": "super" },
    "comment": "Hours don't match badge report",
    "ts": "2026-04-21T14:02:11Z"
  }
  ```
- **Failure handling:** webhook retries 3× with exponential backoff; persistent failure writes to `notification_failures` and alerts tenant admins. Email failures log to `auth_events` but do not retry (rely on SMTP queue).

### 7.7 Badge override reconciliation flow

Badge overrides run through a **parallel, independent** approval flow — they do not gate the parent timesheet's approval run. Rationale: badge-system data quality is a separate concern from authorization of submitted hours. A timekeeper_admin's reconciliation of a missed badge-punch should not stall payroll for a crew whose hours are otherwise attested by their foreman.

**Creation.** A `badge_overrides` row (§6.6) is created:

1. **Automatically on submit:** when any `timesheet_line.hours_*` for a field timesheet disagrees with the employee's `badge_records` for that `(employee, date)` tuple. Strict comparison; zero tolerance in v1. One `badge_overrides` row per mismatched line.
2. **Retroactively by a timekeeper or admin:** when a badge gap is noticed post-submission (e.g., the badge terminal was offline for 90 minutes that morning). The row may or may not reference an original line.

**Flow.** Each `badge_overrides` row spawns its own single-node `approval_run` (same `approval_runs` table; `flow_id` points at the tenant's built-in override-reconciliation flow — a one-node flow whose approver is `role_on_silo:timekeeper_admin`). This uses the standard version-based concurrency contract (§7.4).

**Resolution actions** (written to `approval_actions` with the run's `run_id`):

- `resolved_submitted_canonical` — submitted hours stand; badge data discarded or annotated. No effect on the parent timesheet's approval run. `reason` required.
- `resolved_badge_canonical` — badge data stands; submitted hours were wrong. Side effects depend on the parent run's current state:
  - Parent still open → transition parent to `rejected` with reason `HOURS_RECONCILED_TO_BADGE`, pulling the submitter back into an edit loop (standard reject fanout per §7.4).
  - Parent already approved → write an audit event `parent_approval_invalidated` on the parent run; notify tenant admins; admin resolves via `admin_override` on a replacement run or via a follow-on correction timesheet.

**Independence from the parent run.** Possible terminal combinations:

| Parent run | Override outcome | Result |
| --- | --- | --- |
| approved | `resolved_submitted_canonical` | Clean terminal. |
| approved | `resolved_badge_canonical` | Parent retroactively invalidated; admin handles. |
| rejected (any reason) | any | Submitter edits and resubmits; new run spawns fresh mismatch checks. |
| still open at override-resolution time | `resolved_badge_canonical` | Parent → rejected with reconciliation reason. |
| approved, override still open | — | Payroll export flags `pending_reconciliation=true` on the affected lines. |

**Audit.** Override runs are addressable via the same `GET /approvals/:run_id` endpoint; the full audit trail per-timesheet spans both the authorization flow and any overlapping reconciliation flow(s).

---

## 8. API surface (sketch)

All endpoints are under `/api/v1`. All require a session token except `POST /auth/login` and `POST /invites/:token/accept`. All responses are scoped to the caller's tenant.

### Auth
```
POST   /auth/login                 { username, password } → { token, user }
POST   /auth/logout                → 204
POST   /auth/change-password       { current, new } → 204 (invalidates other sessions)
POST   /invites/:token/accept      { password } → 204
```

### Users (admin only, except /me)
```
GET    /users                      ?role=&status=&q=
POST   /users                      { username, email, role, employee_id? } → creates + sends invite
GET    /users/:id
PATCH  /users/:id                  { role?, employee_id?, status? }
POST   /users/:id/reset-password   → generates new invite
POST   /users/:id/revoke           → status=revoked
POST   /users/:id/restore          → status=active, triggers new invite
GET    /users/me
```

### Subcontractors, projects, project-sub silos
```
GET    /subcontractors
POST   /subcontractors             (admin)
PATCH  /subcontractors/:id         (admin)

GET    /projects
POST   /projects                   (admin)
PATCH  /projects/:id               (admin)
GET    /projects/:id/readiness     → { ready: bool, missing: [...] }   -- drives the submit-UI gate

GET    /projects/:id/subcontractors
POST   /projects/:id/subcontractors       { subcontractor_id, start_date }  (admin)
PATCH  /project-subcontractors/:id        { end_date }                      (admin)
```

### Approval flows & role/flow assignments (admin only)
```
GET    /approval-flows
POST   /approval-flows             { name, nodes: [{ordinal, name, approvers: [...]}, ...] }
PATCH  /approval-flows/:id
POST   /approval-flows/:id/activate
POST   /approval-flows/:id/deactivate    -- existing open runs keep old flow

GET    /project-flow-assignments   ?project_id=
POST   /project-flow-assignments   { project_id, flow_id, effective_from }
PATCH  /project-flow-assignments/:id  { effective_to }

GET    /silo-role-assignments      ?project_id=&subcontractor_id=
POST   /silo-role-assignments      { project_id, subcontractor_id, role_label, user_id, effective_from }
PATCH  /silo-role-assignments/:id  { effective_to }

GET    /project-role-assignments   ?project_id=
POST   /project-role-assignments   { project_id, role_label, user_id, effective_from }
PATCH  /project-role-assignments/:id  { effective_to }
```

### Timesheets (submitter + approver + admin)
```
GET    /timesheets                 ?kind=&status=&employee_id=&project_id=&from=&to=
POST   /timesheets                 { kind, ... }           -- creates draft
PATCH  /timesheets/:id             { lines, ... }          -- while draft
POST   /timesheets/:id/submit      → runs routing algorithm
POST   /timesheets/:id/recall      → only while open, by submitter
GET    /timesheets/:id/run         → approval run details + history
```

### Approvals (any user with approval capability; reassign/override admin-only)
```
GET    /approvals/mine             ?status=pending|acted   -- runs where caller is currently eligible
POST   /approvals/:run_id/approve  { comment? }            -- supports Idempotency-Key header
POST   /approvals/:run_id/reject   { comment }             -- comment required; supports Idempotency-Key
POST   /approvals/:run_id/reassign { to_user_id, reason }  (admin)
POST   /approvals/:run_id/override { decision, comment }   (admin; supports Idempotency-Key)
```

**Idempotency-Key header** — clients may include `Idempotency-Key: <uuid>` on POSTs to `/approve`, `/reject`, and `/override`. Server stores `(actor_user_id, key) → response` for 24h; a retried POST with the same key returns the cached response without re-executing. Keyed on `actor_user_id` so two different users sending the same key don't collide. See §7.4 "Concurrency" for the interaction with optimistic concurrency — different actors with different keys race normally through the version check; same-actor retries are absorbed by idempotency.

### Export (admin, with v2 cost enrichment)
```
GET    /exports/labor              ?from=&to=&project_id=&status=approved
                                   → CSV or XLSX; same schema as current export_labor.py plus
                                     (v2) base_rate, burdened_rate, billable_rate, *_amount
```

---

## 9. Re-platforming and go-live

This is a **re-platforming**, not a pure migration. The current frontend's localStorage model covers only a subset of the v1 backend's concepts — employees, projects, reference data (task codes, CWPs, FCOs), and historical timesheets can be imported mechanically, but **subcontractors, per-employee sub assignments, project↔sub engagements, flow templates, and per-silo/per-project role assignments are net-new domain entities** that the current system has no record of. They must be designed with the customer and populated before go-live.

**Rollout model: big-bang cutover.** Phase A (data import) and Phase B (domain configuration) both complete before any user touches the new system. The legacy localStorage app remains the system of record until cutover day; invites are queued during setup and released only at cutover.

**Ownership:** Phase B is **Invenio-led**. Until the new app is live, the customer does not touch the admin UI — they receive spreadsheet templates from Invenio, fill them in, and send them back. Invenio validates and loads. (Post-go-live, admin UI access can be delegated to customer-side admins for ongoing changes; the spreadsheet workflow is a setup-phase convenience, not a permanent constraint.)

### Phase A — Data import (scripted)

Mechanical, one-time ingestion of data that already exists in the customer's localStorage dump. Invenio runs this against a freshly provisioned tenant.

1. **Stable external IDs.** The backend issues UUIDs for all entities. `employees.external_id`, `projects.external_id`, etc. preserve the old `E001`/`P001` strings for reference and to let the import map old → new.
2. **Import endpoint** `POST /admin/import-localstorage` (admin-only, idempotent per tenant) accepts the full `tk_*` JSON blob and loads:
   - `employees` (without `subcontractor_id` — assigned in Phase B);
   - `projects`, `areas`, `task_codes`, `cwps`, `fcos`;
   - Historical `staff_timesheets` and `field_timesheets` as `draft` status (no approval runs — see "Historical timesheet handling" below).
3. **User records** imported with `password_hash=NULL`, `status=pending`. No plaintext passwords cross the boundary. Invites are created but **not sent** until go-live.
4. **Role remapping.** Legacy `{admin, staff, timekeeper}` roles map to the new `{admin, submitter}` model as follows:
   - `role='admin'` → `admin`.
   - `role='staff'` → `submitter` with `employee_id` populated (from the current app's `empId`).
   - `role='timekeeper'` → `submitter`; `submitter_assignments` populated in Phase B.
   - No legacy user maps to the old `approver` role — that role no longer exists. Approval capability is overlaid via Phase B spreadsheets (see §5 "Approval capabilities" and Phase B items 6–7).

### Phase B — Domain configuration (Invenio-led, spreadsheet-mediated)

Net-new data collected via customer-filled spreadsheets. Invenio validates each and loads via admin API or direct DB population. All items required before go-live.

Phase B is also where **approval capability** is assigned to existing users: the legacy `role` column (`staff`/`timekeeper`) doesn't carry enough information to identify who approves what. For example, a current `staff` user may turn out to be a project's PM — discovered during Phase B, recorded in `project-roles.xlsx` as a `pm` row, loaded into `project_role_assignments`. Existing users are referenced in the role-assignment spreadsheets by `external_id` or username.

| # | Data | Spreadsheet template | Target table |
| --- | --- | --- | --- |
| 1 | Subcontractor list | `subs.xlsx` — name, short code | `subcontractors` (Invenio inserted at tenant provisioning) |
| 2 | Per-employee sub assignment | `employee-subs.xlsx` — `external_id`, sub | `employees.subcontractor_id` + `employee_subcontractor_history` |
| 3 | Project ↔ sub engagement | `project-subs.xlsx` — project, sub, start_date | `project_subcontractors` |
| 4 | Approval flow templates | Designed in discovery session; authored by Invenio via admin API | `approval_flows`, `approval_nodes`, `approval_node_approvers` |
| 5 | Project → flow assignment | `project-flows.xlsx` — project, flow name | `project_flow_assignments` |
| 6 | Per-silo reserved roles | `silo-roles.xlsx` — project, sub, role_label (`foreman`, `timekeeper_admin`), user | `silo_role_assignments` |
| 7 | Per-project reserved roles | `project-roles.xlsx` — project, role_label (`pm`, `prime_rep`, `accounting`), user | `project_role_assignments` |
| 8 | Timekeeper proxy scope | `timekeeper-assignments.xlsx` — user, assigned silos | `submitter_assignments` |

### Historical timesheet handling

All historical timesheets land as `draft` in Phase A. Choose one policy with the customer:

- **(a) Leave as draft.** Cleanest; no approval history carried into the new system.
- **(b) Retro-create approval runs in `approved` status** with a synthetic `admin_override` action — marks them clearly as migrated, not organically approved. Requires the project's flow template to exist (Phase B item 4).

### Go-live gate

Cutover is allowed only when every active tenant entity clears these checks:

- Every active employee has a non-null `subcontractor_id`.
- Every active project has an active `project_flow_assignments` row.
- Every active silo (`project_subcontractors` with no `end_date`) has `foreman` and `timekeeper_admin` populated in `silo_role_assignments`.
- Every active project has `pm` and `prime_rep` populated in `project_role_assignments` (`accounting` optional per customer policy).
- Every flow template's nodes resolve to at least one eligible user at run time.
- Every legacy user from the source `tk_users` blob is either (a) present in the new tenant with appropriate role and `employee_id` per the Phase A item 4 mapping, or (b) explicitly marked as archived by Invenio and documented in the migration notes log. No legacy user is silently dropped.
- Every imported user has `status=pending` and a queued invite.

On cutover: invites are released, users authenticate via the invite flow (§4.3), and the legacy app goes read-only.

### Frontend transition

At cutover the frontend switches from `DB.*` localStorage calls to a thin API client. Status handling expands from `{draft, submitted, open}` to the full vocabulary in §7.4. The `badge-approved` CSS class (currently dead) comes to life. (The current app's `open` status for admin-pre-created field timesheets needs explicit preservation or collapse — see adversarial-analysis item M-10.)

## 10. Open questions / out of scope (park for v2)

- **n-of-m quorum per node.** Current spec is any-of (quorum=1). Field already present in design (`approval_nodes.quorum`, default 1) — left unused to keep v1 simple.
- **Bounce-to-node on reject.** v1 rejects terminate the run. v2 could allow "reject back to node 2".
- **Cost/rate/billing enrichment.** Per `test_export.xlsx` — needs `rates` and `burden_multipliers` tables keyed by `(craft, project, date)` or similar. Scope this separately.
- **Parallel nodes.** v1 nodes are strictly sequential (1 → 2 → 3). Parallel (e.g. node 3a and 3b both required) is a v2 feature.
- **External SSO.** Add OAuth / SAML as a pluggable auth source; don't redesign session model for it — it can produce the same session tokens.
- **In-app notifications / inbox.** v1 uses email + polling. WebSocket push is deferrable.
- **Real-time collaborative editing of a field timesheet.** Not in scope.
- **Delegation.** Explicitly excluded — admin reassignment covers the requirement per §1.3. Revisit only if operational load on admins becomes a pain point.

---

## 11. Implementation stack & conventions

Concrete technology choices and API conventions. Picks optimize for AI-assisted development leverage (mainstream frameworks with strong training coverage, AI-friendly declarative schema formats, opinionated conventions that guide generation).

### 11.1 Stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript (strict mode) | Used in the backend service and for any shared types with the frontend. |
| Runtime | Node.js LTS (22.x) | |
| HTTP framework | Fastify | TypeScript-first, plugin architecture, fast. |
| ORM | Prisma | Declarative single-file `schema.prisma`; built-in migrations; strong TS integration. Free and OSS (Apache 2.0). |
| Database | PostgreSQL 15+ | Needed for `NULLS NOT DISTINCT` in UNIQUE constraints. RLS used for tenant isolation. |
| Migration tool | Prisma Migrate | Versioned forward/reverse migration scripts, integrated with the ORM. |
| Job queue | BullMQ (Redis-backed) | Stall detection, webhook delivery with retry, email sending, invite release. |
| Cache / queue backend | Redis | Backs BullMQ and stores Idempotency-Key responses (24h TTL). |
| Password hashing | `argon2` (argon2id variant) | Per-user salt. |
| Session tokens | Opaque, DB-backed in `sessions` | Enables revocation; avoids cross-tenant JWT key rotation complexity. |
| Email delivery | Resend | Transactional email API. |
| Testing framework | Vitest | TypeScript-first, Jest-compatible API. |
| API integration tests | Supertest | Standard for Fastify/Express. |
| Secrets | Env vars in dev; secrets manager (AWS Secrets Manager or equivalent) in prod | Never in `tenants` directly — `webhook_signing_secret_ref` points at a key. |

### 11.2 API conventions

**Versioning.** All endpoints under `/api/v1`. Breaking changes roll to `/api/v2`; `v1` remains available for a deprecation window (≥ 6 months).

**Error responses** follow **RFC 7807 Problem Details**:

```json
{
  "type": "https://api.invenio.example/errors/project-not-ready",
  "title": "Project not ready for submission",
  "status": 409,
  "detail": "Project P123 is missing required configuration",
  "instance": "/api/v1/timesheets/abc/submit",
  "missing": ["project_flow_assignment", "silo_role_assignments:sub=S003:role=foreman"]
}
```

- `type` — stable URL-shaped identifier per error code (doesn't need to resolve).
- `title` — short human label.
- `status` — matches HTTP status code.
- `detail` — specific, human-readable message.
- `instance` — the request path.
- Error-specific extension fields (`missing`, `run_state`, `conflicting_version`, etc.) — free-form on the response body.

Content type: `application/json; charset=utf-8`. Error responses use `application/problem+json`.

**Pagination.** All collection endpoints support cursor-based pagination: `?limit=<int>&cursor=<opaque>` (default limit 50, max 200). Response: `{ data: [...], next_cursor: string | null }`.

**Authentication header.** `Authorization: Bearer <opaque-token>`. Tokens are issued by `POST /auth/login` and resolved against the `sessions` table server-side.

**Idempotency.** `Idempotency-Key` header is honored on POSTs to `/approve`, `/reject`, `/override`, and bulk import endpoints. Responses cached for 24h keyed on `(actor_user_id, key)` (§7.4, §8).

### 11.3 Data types

| Column kind | Type | Notes |
| --- | --- | --- |
| All IDs | `UUID` | No integer sequences exposed; no record-count leakage. |
| Timestamps | `TIMESTAMPTZ` | Always timezone-aware. |
| Hours | `NUMERIC(5,2)` | Max 999.99 — more than a week. |
| Money (v2) | `NUMERIC(10,2)` | |
| Stable enums | Postgres `CREATE TYPE … AS ENUM (...)` | `users.role`, `timesheets.kind`, `timesheets.status`, `approval_runs.status`, etc. |
| Evolving labels | `TEXT` + optional CHECK | `role_label` — free-form with reserved values (see §7.1). |
| Free-form strings | `TEXT` | No arbitrary length limits except at UX boundaries. |
| JSON payloads | `JSONB` | `auth_events.details`, `notification_failures.payload`, etc. |

### 11.4 Index strategy

Required indexes on every tenant-scoped table:

- Composite `(tenant_id, …)` on primary query paths — matches the RLS filter pattern.
- All foreign keys (Prisma creates these automatically; verify).

Table-specific required indexes:

| Table | Index | Purpose |
| --- | --- | --- |
| `users` | `UNIQUE (tenant_id, username) WHERE status != 'revoked'` | Allow username reuse after revoke (addresses M-13). |
| `users` | `UNIQUE (tenant_id, email) WHERE status != 'revoked'` | Same for email. |
| `timesheets` | `(tenant_id, employee_id, period_start, period_end)` | "My timesheets" queries. |
| `timesheets` | `(tenant_id, project_id, status)` | Admin listings, project dashboards. |
| `approval_runs` | `(tenant_id, current_node_id, status)` | `GET /approvals/mine`. |
| `approval_runs` | `(tenant_id, timesheet_id)` | Run-attach lookup. |
| `approval_actions` | `(run_id, ts)` | Run history timeline. |
| `auth_events` | `(tenant_id, user_id, ts DESC)` | Audit queries. |
| `auth_events` | `(ip, ts DESC)` | Rate-limit lookups on failed login. |
| `sessions` | `(user_id, revoked_at)` | Active session lookup. |
| `project_flow_assignments` | `(tenant_id, project_id, effective_from DESC, effective_to)` | Active-flow resolution at submit. |
| `silo_role_assignments` | `(tenant_id, project_id, subcontractor_id, role_label, effective_from DESC)` | Approver resolution. |
| `project_role_assignments` | `(tenant_id, project_id, role_label, effective_from DESC)` | Approver resolution. |
| `badge_overrides` | `(tenant_id, status)` | Open-overrides dashboard. |

Unique constraints with NULL-able columns use `NULLS NOT DISTINCT` (Postgres 15+) or per-branch partial indexes — see §7.1 note on `approval_node_approvers`.

### 11.5 Testing conventions

- Every PR ships tests for the code it adds or changes.
- Integration tests hit a real Postgres via Testcontainers (or a dedicated test DB) — no ORM/DB mocks; per the authoritative-source principle, we don't want mocks passing while production integrations fail.
- Concurrency tests simulate racing actors with `Promise.all` of concurrent requests; assert both winner effect and loser 409.
- Multi-tenant isolation tests cover every write endpoint: caller in tenant A cannot observe/modify tenant B's data; responses are 404 (not 403) to avoid existence leaks.
- See `docs/backend-test-plan.md` for the full test-plan checklist, organized by subsystem with P0/P1/P2 priorities.

---

## Appendix A: state machine diagram

```
          ┌──────────────┐
          │   draft      │◀──────────────┐
          └──────┬───────┘               │
                 │  submit                │ recall
                 ▼                        │
          ┌──────────────┐                │
          │  submitted   │                │
          └──────┬───────┘                │
                 │  routing creates run   │
                 ▼                        │
          ┌──────────────┐                │
          │  in_review   │────────────────┘
          │ (node 1..N)  │
          └──────┬───────┘
        approve │        │ reject
                ▼        ▼
          ┌──────────┐ ┌──────────┐
          │ approved │ │ rejected │──(edit)──▶ submitted (new run)
          └──────────┘ └──────────┘
```

## Appendix B: permissions matrix

Columns reflect the user's *role*. Approval authority is orthogonal — any user with the requisite assignment-table entries gains the capabilities in the "approval-capable user (overlay)" column, regardless of role (see §5 "Approval capabilities").

| Action | admin | submitter (self) | submitter (proxy) | Approval-capable user (overlay) |
| --- | :-: | :-: | :-: | :-: |
| CRUD users | ✅ | — | — | — |
| Reset/revoke user | ✅ | — | — | — |
| CRUD projects/subs/flows | ✅ | — | — | — |
| Submit own hours | — | ✅ | ✅ | — |
| Submit hours for others in silo | — | — | ✅ (assigned silos only) | — |
| Approve / reject a node | on any* | — | — | eligible nodes only (resolved from assignments) |
| Reassign a stalled node | ✅ | — | — | — |
| Admin-override a run | ✅ | — | — | — |
| Export approved labor | ✅ | — | — | — |
| View any timesheet | ✅ | own | own + proxied | runs they're on |

\* admins can only approve a node if they are explicitly on the approver pool for it (via `approval_node_approvers`, `silo_role_assignments`, or `project_role_assignments`), *or* via `admin_override`.

---

## Revision Log

### v0.1.1 — 2026-04-21 (partial — HSI-#2 resolved)

Edits in this revision address HSI-#2 (silo / role model) from the adversarial review ([adversarial-analysis-backend-spec.md](adversarial-analysis-backend-spec.md)). Customer discovery confirmed:

- **Same project → same approval chain template.** Flow templates are project-scoped; per-sub variance lives entirely at approver resolution.
- **No joint ventures, no loaned labor, no craft-based routing, no zone-based routing.**
- **Owner-operators** modeled as sub-of-one.
- **Mid-period sub transitions** produce separate timesheets (sub is snapshotted at submit, not re-derived later).
- **Cross-contract OT calculation** parked for v2.
- **The prime's embedded rep** is a sub-employed user (could be any sub, including Invenio-as-sub) who acts as the project's prime rep. Modeled as a `project_role_assignments` entry with `role_label='prime_rep'`.
- **Organizational structure** prevents the same user from appearing at two nodes on one run (the prime rep is never also the sub's node-1 approver) — so no "same user twice" rule is required in the spec.

Concrete edits applied:

- §1 goal #7 rewritten — silo-scoped vs project-scoped approver resolution.
- §5 restructured — roles collapsed to `{admin, submitter}`; `approver` demoted from role to capability derived from assignment-table membership. "Foreman vs timekeeper vs self-entering staff" table gained a Prime-rep row.
- §6.1 `users.role` enum narrowed.
- §6.6 timesheet `subcontractor_id` comment clarified (snapshot-at-submit semantics).
- §7.1 — added `approver_type='role_on_project'`, added `project_role_assignments` table, reserved-label table gained a scope column and `prime_rep`.
- §7.2 — `silo_flow_assignments` replaced with `project_flow_assignments` (keyed on `project_id` only).
- §7.4 routing algorithm — step 3 resolves project flow; error code `SILO_UNCONFIGURED` → `FLOW_UNCONFIGURED`.
- Appendix B permission matrix — approver column converted to an overlay capability.

All 6 high-severity adversarial-review issues resolved. Four medium-severity items addressed in v0.3.0 (below); remaining medium/low items from [adversarial-analysis-backend-spec.md](adversarial-analysis-backend-spec.md) deferred to a subsequent pass.

### v0.3.0 — 2026-04-21 (Implementation readiness)

Moves the spec from "design intent" to "ready to build." Four medium-severity items from the adversarial analysis addressed; stack and conventions picked.

Addressed:

- **M-9 `badge_overrides` orphan** — §6.6 schema expanded (submitted vs. badge hours, status, resolution metadata). New §7.7 specifies the **parallel, independent** reconciliation flow (single-node, `role_on_silo:timekeeper_admin` approver). Resolution can retroactively invalidate an approved parent run via the `resolved_badge_canonical` outcome; parallel independence preserves payroll flow for data-quality-only issues (e.g., dropped badge events).
- **M-10 field-timesheet `open` state** — §6.6 documents the `open → draft → submitted → …` flow for field timesheets; claim / release semantics specified. §7.4 state machine diagram updated.
- **M-8 staff-timesheet partial state** — §6.6 adds an explicit partial-state handling paragraph: per-project status badges, edit-scope limited to rejected rows, independent resubmit, payroll-downstream row independence.
- **M-11 tenants schema incomplete** — §3 tenants table expanded with `timezone`, `locale`, `email_from_address`, `webhook_url`, `webhook_signing_secret_ref`, `session_absolute_hours`, `session_idle_minutes`, `stall_hours`.

Stack & conventions:

- New **§11 Implementation stack & conventions** — TypeScript + Fastify + Prisma + PostgreSQL 15+ + BullMQ/Redis + Resend + argon2 + Vitest + Supertest. RFC 7807 error format, cursor-based pagination, `UUID`/`TIMESTAMPTZ`/`NUMERIC` type rules, required-index inventory.

Companion document:

- **[backend-test-plan.md](backend-test-plan.md)** — structured test-plan checklist organized by subsystem (auth, tenancy, approval, timesheets, badge override, notifications, migration, export, integration scenarios, non-functional). P0/P1/P2 priority flags.

### v0.2.0 — 2026-04-21 (HSI-#5 resolved; adversarial review complete)

HSI-#5 was largely resolved by HSI-#2's approver-as-capability demotion and §9's preliminary role-remapping rules. This revision finalizes the wording and tightens the go-live gate, closing the adversarial review milestone.

Concrete edits applied:

- §9 Phase A item 4 — role remapping rule finalized (dropped "preliminary / pending" language). Explicit note that no legacy user maps to the old `approver` role; approval capability is assigned in Phase B.
- §9 Phase B intro — clarified that approval-capability assignment for existing users is discovered in Phase B (legacy `role` column alone is insufficient to identify approvers).
- §9 Go-live gate — added an explicit legacy-user audit check: no legacy user is silently dropped; each either is imported (per the Phase A mapping) or explicitly archived and documented.

### v0.1.5 — 2026-04-21 (HSI-#4 resolved)

Adopted **strict blocking with UX tweaks**: no tenant default flow, no grace mode. Given the Invenio-led operational model (HSI-#1), strict is workable; the pain point is localized to post-cutover project onboarding, which Invenio controls. The combined error code is now `PROJECT_NOT_READY` (subsuming the earlier `FLOW_UNCONFIGURED`) and covers missing flow assignment, missing silo roles, or missing project roles.

Concrete edits applied:

- §7.2 — strict-by-design language; structured error body + admin UI readiness gate as UX tweaks.
- §7.4 — routing step 3 expanded to check flow + all referenced silo/project role assignments; unified error code `PROJECT_NOT_READY` with `missing` array enumerating specifics.
- §8 — added `GET /projects/:id/readiness → { ready, missing }`. Renamed stale `/silo-assignments` endpoints to `/project-flow-assignments`. Added `/project-role-assignments` CRUD endpoints (missing since HSI-#2 schema changes). Section heading updated from "silo flow assignments" to "role/flow assignments".

### v0.1.4 — 2026-04-21 (HSI-#3 resolved)

Adopted **optimistic concurrency** for approval state transitions. Approval races are rare in practice and the 409 UX is clean; pessimistic row locks would introduce needless serialization.

Concrete edits applied:

- §7.3 — `approval_runs` gained `version INT NOT NULL DEFAULT 0` column.
- §7.4 — new "Concurrency (optimistic)" subsection specifies the conditional-UPDATE pattern, same-transaction action insertion, and `RUN_STATE_CHANGED` 409 response. Applies uniformly to approve, reject, recall, reassign, and admin_override transitions.
- §8 — Idempotency-Key header support added to `/approvals/:run_id/approve`, `/reject`, and `/override`. Keyed on `(actor_user_id, key)` with 24h TTL; absorbs client-retry duplicates without conflicting with the optimistic-concurrency version check.
- §8 — Approvals endpoint heading updated ("approver + admin" was stale post-HSI-#2) to reflect the capability model.

### v0.1.3 — 2026-04-21 (HSI-#6 resolved)

Customer confirmed: **every foreman will have a user account** because they are required to submit their own hours for payroll. This removes the "foreman without login" edge case entirely — no fallback notification path needed, no separate crew-metadata field required.

Concrete edits applied:

- §7.1 reserved-labels table — `foreman` description updated to state that the role is always held by a user (foremen necessarily have accounts to get paid). Multi-foreman-per-silo support noted (already permitted by the existing UNIQUE constraint on `silo_role_assignments`).
- No schema changes required — `silo_role_assignments.user_id` is already a FK to `users`; the existing go-live gate (every active silo has `foreman` and `timekeeper_admin` populated) enforces this automatically.

### v0.1.2 — 2026-04-21 (HSI-#1 resolved)

Customer confirmed **big-bang cutover** (Phase A data import + Phase B domain configuration both complete before go-live) and **Invenio-led Phase B** (spreadsheet intake from customer; Invenio validates and loads). Post-go-live, admin UI access can be delegated to customer admins.

Concrete edits applied:

- §9 renamed "Re-platforming and go-live" and restructured into Phase A (scripted import) + Phase B (spreadsheet-mediated domain configuration).
- Phase B spreadsheet templates enumerated (subs, employee-subs, project-subs, project-flows, silo-roles, project-roles, timekeeper-assignments).
- Historical timesheet handling options (a/b) documented.
- Go-live gate added — explicit preconditions every tenant must clear before cutover.
- Invites queued at Phase A, released only at cutover (not sent on import).
