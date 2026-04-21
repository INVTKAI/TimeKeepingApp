# TimeKeepingApp — Backend Specification

**Status:** Draft v0.1.2 — design intent, not yet implemented. Adversarial review pass in progress: HSI-#1 and #2 resolved; HSI-#3, #4, #5, #6 still pending. See Revision Log at bottom.
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
| `tenants` | `id`, `name`, `slug`, `status`, `created_at` | `slug` unique; `status` ∈ {`active`,`suspended`} |

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
  employee_id, date,
  hours_st, hours_ot,
  reason, overridden_by_user_id, ts
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
| `foreman` | silo | Crew lead for the silo. Typically also a submitter. Notified on submit, reject, and stall. |
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

If no assignment exists, submission is blocked with error code `FLOW_UNCONFIGURED`. The strict-vs-grace tradeoff around this blocking behavior is **HSI-#4 (still open)**.

The silo concept (`(project, subcontractor)` pair — see §6.4) remains relevant for per-sub role resolution via `silo_role_assignments`; it does not participate in flow selection. Multiple concurrent silos per project (one per sub) is still the norm.

### 7.3 Runs (per-submission instances) & audit trail

```
approval_runs(
  id, tenant_id, timesheet_id, flow_id,
  status,                -- see §7.4
  current_node_id NULL,  -- NULL when terminal
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
draft → submitted → in_review → approved
                              ↘ rejected → (edit) → submitted (new cycle on same timesheet)
                              ↘ recalled  → draft  (submitter withdrew before terminal)
```

**Approval run status** (on `approval_runs.status`): `open | approved | rejected | recalled | abandoned`.

**Routing algorithm (on submit):**

```
1. Validate the submitter is authorized for (project, sub) per §5.
2. Compute subcontractor_id from the employee's current sub.
3. Resolve the active project_flow_assignment for (project_id, today).
   If none → 409 with error code FLOW_UNCONFIGURED.  (See HSI-#4 — still open.)
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

GET    /projects/:id/subcontractors
POST   /projects/:id/subcontractors       { subcontractor_id, start_date }  (admin)
PATCH  /project-subcontractors/:id        { end_date }                      (admin)
```

### Approval flows & silo flow assignments (admin only)
```
GET    /approval-flows
POST   /approval-flows             { name, nodes: [{ordinal, name, approvers: [...]}, ...] }
PATCH  /approval-flows/:id
POST   /approval-flows/:id/activate
POST   /approval-flows/:id/deactivate    -- existing open runs keep old flow

GET    /silo-assignments           ?project_id=&subcontractor_id=
POST   /silo-assignments           { project_id, subcontractor_id, flow_id, effective_from }
PATCH  /silo-assignments/:id       { effective_to }

GET    /silo-role-assignments      ?project_id=&subcontractor_id=
POST   /silo-role-assignments      { project_id, subcontractor_id, role_label, user_id, effective_from }
PATCH  /silo-role-assignments/:id  { effective_to }
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

### Approvals (approver + admin)
```
GET    /approvals/mine             ?status=pending|acted   -- runs where caller is currently eligible
POST   /approvals/:run_id/approve  { comment? }
POST   /approvals/:run_id/reject   { comment }             -- comment required
POST   /approvals/:run_id/reassign { to_user_id, reason }  (admin)
POST   /approvals/:run_id/override { decision, comment }   (admin)
```

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
4. **Preliminary role remapping** (full resolution pending HSI-#5): `role='admin'` → `admin`; `role='staff'` → `submitter` with `employee_id` populated; `role='timekeeper'` → `submitter` (proxy assignments populated in Phase B).

### Phase B — Domain configuration (Invenio-led, spreadsheet-mediated)

Net-new data collected via customer-filled spreadsheets. Invenio validates each and loads via admin API or direct DB population. All items required before go-live.

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
- Every legacy user has a corresponding new-system user with `status=pending` and a queued invite.

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

Still pending:

- **HSI-#3** — concurrency control on any-of node advance (optimistic vs pessimistic).
- **HSI-#4** — `FLOW_UNCONFIGURED` blocking behavior (keep strict, or add grace mode).
- **HSI-#5** — role remapping for existing `{admin, staff, timekeeper}` users. Partially addressed by the capability demotion and §9 preliminary remapping; full resolution still pending (e.g., which existing users additionally need approval-capability assignments seeded in Phase B).
- **HSI-#6** — foreman-as-approver fallback when the foreman has no user account.

### v0.1.2 — 2026-04-21 (HSI-#1 resolved)

Customer confirmed **big-bang cutover** (Phase A data import + Phase B domain configuration both complete before go-live) and **Invenio-led Phase B** (spreadsheet intake from customer; Invenio validates and loads). Post-go-live, admin UI access can be delegated to customer admins.

Concrete edits applied:

- §9 renamed "Re-platforming and go-live" and restructured into Phase A (scripted import) + Phase B (spreadsheet-mediated domain configuration).
- Phase B spreadsheet templates enumerated (subs, employee-subs, project-subs, project-flows, silo-roles, project-roles, timekeeper-assignments).
- Historical timesheet handling options (a/b) documented.
- Go-live gate added — explicit preconditions every tenant must clear before cutover.
- Invites queued at Phase A, released only at cutover (not sent on import).
