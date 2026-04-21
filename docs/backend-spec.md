# TimeKeepingApp — Backend Specification

**Status:** Draft v0.4.1 — Supabase-first pivot + HSI closure. Closes findings #1–#6 from [adversarial-analysis-backend-spec-v0.4.md](adversarial-analysis-backend-spec-v0.4.md): mandatory `withAdminContext` wrapper, shorter access-token TTL + revocation denylist, tenancy-hook failure mitigations, error-shape split (PostgREST native + RFC 7807), per-account lockout reinstated as v1, service-role key rotation policy. Companions: [backend-test-plan.md](backend-test-plan.md), [adversarial-analysis-backend-spec-v0.4.md](adversarial-analysis-backend-spec-v0.4.md). See Revision Log for changelog.
**Scope:** A multi-tenant backend to replace the current localStorage-only prototype. Adds authentication with full password lifecycle, role-based access control, subcontractor modeling, and a configurable multi-node approval workflow for submitted hours.

**Platform:** Built on **Supabase** — Postgres, Auth, PostgREST, Storage, and Edge Functions as one managed bundle. The backend is the combination of (a) schema + RLS policies in Supabase Postgres, (b) transactional plpgsql functions exposed as PostgREST RPCs, and (c) Edge Functions (Deno/TypeScript) for side-effect work (email, webhooks, exports, admin-bypass flows). There is no bespoke HTTP service. See §11 for stack details.

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

Every domain row carries a non-null `tenant_id`. Isolation is enforced by **Postgres Row-Level Security as the primary mechanism**, reading the authenticated principal's tenant from a JWT claim.

- **RLS policies** on every `public.*` tenant-scoped table filter rows by `(auth.jwt() ->> 'tenant_id')::uuid`. A policy template (one per write verb) is applied uniformly so any new tenant-scoped table gets isolation by default.
- **JWT tenant claim** is injected at token-mint time by a **custom access-token hook** (spec §4.2) — a plpgsql function Supabase calls when issuing / refreshing a token, reading `public.users.tenant_id` for the authenticating user and adding it to the token's claims. The same hook adds the caller's `role` so RBAC policies can read it cheaply.
- **Service-role bypass** is reserved for admin-path Edge Functions (tenant provisioning, migration import, cutover, user admin). Every admin Edge Function MUST extend the shared **`withAdminContext`** wrapper (§8), which extracts the caller's JWT, verifies `app_role='admin'`, extracts `tenant_id`, and only then passes a tenant-pinned service-role client to the inner handler. A CI gate rejects any Edge Function that uses the service-role key outside `withAdminContext`. Service-role keys live only in a single Supabase **project-level** secret (not duplicated per-Function) and are rotated per §11.7 — never exposed to clients.

A user belongs to exactly one tenant. Cross-tenant reads / writes return empty result sets (PostgREST surfaces this as 404 for single-row lookups, `[]` for collections), avoiding existence leaks.

Tenants are provisioned by a **super-admin** out of band — the Supabase service-role key via a `provision-tenant` Edge Function (ops runbook). There is no normal login for the super-admin concept; the two user-facing roles (`admin`, `submitter`) are scoped within a tenant.

| Table | Column | Notes |
| --- | --- | --- |
| `tenants` | `id`, `name`, `slug`, `status`, `created_at`, `timezone`, `locale`, `email_from_address`, `webhook_url` NULL, `webhook_signing_secret_ref` NULL, `stall_hours`, `login_max_attempts`, `login_lockout_minutes` | `slug` unique; `status` ∈ {`active`,`suspended`}. Defaults: `timezone='UTC'`, `locale='en-US'`, `stall_hours=48`, `login_max_attempts=5`, `login_lockout_minutes=15`. `webhook_signing_secret_ref` points at a secrets-manager (Supabase Vault) key, not the raw secret. Session-lifetime knobs (access-token TTL, refresh-token TTL) are Supabase-project-level (not per-tenant) — see §4.2. |

---

## 4. Authentication & password lifecycle

Handled by **Supabase Auth**. This section documents how our v0.3 lifecycle requirements map to Supabase features, and lists accepted deviations from v0.3.

### 4.1 Password storage

- **bcrypt** — Supabase Auth default. **Deviation from v0.3** (which specified argon2id). Supabase does not currently expose a hash-algorithm choice. Accepted: modern bcrypt cost factor is adequate against current hardware given a reasonable password policy; password policy defends the primary attack surface (weak passwords). No plaintext anywhere, ever.
- Hashes live in `auth.users.encrypted_password`; not readable from the application (not exposed via PostgREST).
- **Password history (last N=5) is dropped from v1.** Supabase Auth has no built-in history; enforcement would require a custom `pre-password-change` hook reading our own `password_history_hashes` table, which is meaningful work for a low-value defense. Tracked in §10.

### 4.2 Sessions

- **JWT access tokens + refresh tokens.** **Deviation from v0.3** (which specified opaque DB-backed tokens for revocability). Supabase is JWT-native; revocation is achieved by a two-layer mechanism described below, closing the token-staleness gap v0.4.0 initially accepted.
- **Access token TTL:** **15 minutes** (Supabase project config: `JWT_EXP=900`). **Reduced from Supabase's 1h default** to bound the residual window where a token minted pre-revocation remains cryptographically valid. Shorter TTL pays a modest refresh-call tax (~4× more `auth.refreshSession` calls); `supabase-js` handles this transparently.
- **Refresh token TTL:** Supabase-project-level. Recommended: 12h for office staff; up to 30d for field users where re-auth friction is real. Set per deployment environment based on the dominant user mix.
- **JWT claims** — the access token carries `sub` (= `auth.users.id`), `email`, `role` (Supabase-internal), plus our custom claims `tenant_id`, `app_role` (= our `public.users.role`), and `iat` (issued-at; stock JWT claim). Attached by the custom access-token hook (plpgsql function registered with Supabase). RLS policies read claims cheaply via `auth.jwt()`.
- **Revocation denylist (`public.users.sessions_revoked_at`).** To bound the ≤15-min access-token-staleness window even further on sensitive operations, every **state-mutating RPC** (`submit_timesheet`, `approve_run`, `reject_run`, `reassign_run`, `override_run`, `resolve_badge_override`, `recall_timesheet`, and all admin Edge Functions' inner handlers) calls a plpgsql helper `assert_session_live(auth.jwt())` that compares the token's `iat` claim against `public.users.sessions_revoked_at` for the caller; if `iat < sessions_revoked_at`, it raises `SESSION_REVOKED` (HTTP 401). The column is set by the same Edge Functions that call `auth.admin.signOut` (see below). Effect: post-revocation RPCs reject immediately; read paths tolerate the 15-min tail (acceptable — reads don't move money). Implementation cost: one column + one helper function + one line per RPC.
- **Session invalidation paths** (all set `public.users.sessions_revoked_at = now()` in the same Edge Function that calls `auth.admin.signOut`):
  - Self logout — `supabase.auth.signOut()` (client-side). No `sessions_revoked_at` update (user-initiated, not a security event).
  - Password change — Supabase automatically rotates the JWT; post-hook Edge Function calls `auth.admin.signOut(user_id, 'others')` and updates `sessions_revoked_at`.
  - Admin reset — `auth.admin.generateLink({ type: 'recovery' })` + `auth.admin.signOut(user_id, 'global')` + `sessions_revoked_at = now()`.
  - Admin revoke — `auth.admin.updateUserById(user_id, { banned_until: 'infinity' })` + `auth.admin.signOut(user_id, 'global')` + `sessions_revoked_at = now()`.
  - Role change — Edge Function updates `public.users.role`, calls `auth.admin.signOut(user_id, 'global')`, sets `sessions_revoked_at`. Next login's token carries the new claims.

### 4.3 Allocation (new user creation)

1. `admin` calls Edge Function `POST /functions/v1/invite-user` with `{ username, email, role, employee_id? }`.
2. The function, using the service-role key:
   - Inserts a `public.users` row (`status='pending'`).
   - Calls `auth.admin.inviteUserByEmail(email, { data: { tenant_id, app_role: role } })` — Supabase generates the one-time invite token (valid 24h by default; configurable) and sends the invite email from the project-configured from-address.
3. User clicks the invite link → completes password setup via Supabase's hosted accept-invite flow (or our own page that calls `supabase.auth.exchangeCodeForSession()` + `updateUser({ password })`).
4. On first successful sign-in, a database trigger updates `public.users.status='active'`.
5. **Queued-until-cutover invites** (§9 Phase A) use `auth.admin.createUser({ email_confirm: false })` without emitting an invite; at cutover, a batch Edge Function calls `auth.admin.generateLink({ type: 'invite' })` per user and sends.

### 4.4 Self-service update

- Client calls `supabase.auth.updateUser({ password })`.
- **Policy enforcement:** Supabase project's `min_password_length` + a custom `password_strength` plpgsql hook that rejects passwords matching username or email (case-insensitive) and requires at least one letter and one digit. Registered via Supabase's password-strength hook API.
- On success Supabase rotates the caller's JWT automatically; a post-update Edge Function (or client-side call) invokes `auth.admin.signOut(user_id, 'others')` to invalidate refresh tokens on other devices.

### 4.5 Admin reset

- `admin` calls Edge Function `POST /functions/v1/reset-password/:user_id`, which:
  1. `auth.admin.generateLink({ type: 'recovery', email })` — Supabase sends the recovery email.
  2. `auth.admin.signOut(user_id, 'global')` — revokes existing refresh tokens.
- User completes the recovery flow to set a new password; login resumes automatically.

### 4.6 Revocation

- `admin` calls Edge Function `POST /functions/v1/revoke-user/:user_id`, which:
  1. `auth.admin.updateUserById(user_id, { banned_until: 'infinity' })` — blocks future logins at Supabase.
  2. `auth.admin.signOut(user_id, 'global')` — revokes current refresh tokens.
  3. `UPDATE public.users SET status='revoked' WHERE id = …` — our domain marker, retained for attribution of historical approval actions.
- User is **soft-deleted**: historical approval actions, timesheet submissions, and audit rows still reference the user.
- Reversal via `POST /functions/v1/restore-user/:user_id`: clears `banned_until`, sets `status='pending'`, generates and emails a fresh recovery link (new password required before next login).

### 4.7 Audit & rate limiting

- **Auth events** (login success/fail, password change, invite consumption, admin reset, signOut) are captured by Supabase Auth in `auth.audit_log_entries`. Accessible via the Supabase dashboard and Admin API. No custom `auth_events` table.
- **Domain events** — approval actions, admin overrides, reassignments, user revokes/restores, flow-template edits, account lockouts — are written to our own `audit_events` table (§6.1) by the plpgsql RPCs and Edge Functions that perform the action.
- **Global per-IP rate limiting.** Supabase Auth applies this on `signInWithPassword` (configurable per Supabase project). Defeats unsophisticated single-source brute force; does not defend against credential stuffing.
- **Per-account lockout (v1 requirement).** Enforced via a custom **`before-login` hook** (plpgsql function registered with Supabase). On each sign-in attempt the hook counts `login_failure` entries in `auth.audit_log_entries` for the target email within the last `tenants.login_lockout_minutes` (default 15); if count ≥ `tenants.login_max_attempts` (default 5), the hook raises `P0007 RATE_LIMITED`, causing Supabase to reject the attempt with HTTP 429. Tenant resolution: the hook looks up `public.users` by email to find `tenant_id`, then reads the lockout config from `tenants`. Specifically addresses credential-stuffing attacks using leaked password corpora — the modern-era dominant account-takeover vector, which per-IP rate limiting does not meaningfully mitigate.
- **Admin unlock.** `POST /functions/v1/unlock-user/:user_id` (extending `withAdminContext`, §8) writes a `user.unlock` row to `audit_events` and inserts a corresponding marker into `public.user_unlock_markers(user_id, unlocked_at)` that the `before-login` hook treats as a reset of the failure window for that user (it only counts failures after the latest unlock marker). No stored state on `auth.users` is mutated by the unlock (that's Supabase-owned).

### 4.8 Tenancy hook failure modes & mitigations

The custom access-token hook (§4.2) is the tenancy mechanism's root dependency. The failure modes, each with a named mitigation:

- **Hook raises an exception at token mint.** Supabase fails the sign-in / refresh. Result: affected users cannot obtain a valid token. *Mitigation:* the hook is deployed behind a ramp (1% → 10% → 100% over a week) against a no-op fallback that rejects issuance entirely (fail-closed — better than issuing a token missing custom claims, see next). Metrics alarm on any spike in `auth.audit_log_entries` where `event_type='login_failure'` with hook-related error codes.

- **Hook returns a token missing `tenant_id` and/or `app_role`.** Every RLS check against `(auth.jwt() ->> 'tenant_id')::uuid` yields NULL; `NULL = <any>` is always false, so every tenant-scoped table returns zero rows. RLS appears to function, but the user sees an empty system — indistinguishable from a legitimately unprovisioned tenant. *Mitigation:* every state-mutating RPC (and every Edge Function) begins with a plpgsql helper `assert_tenant_claim_present()` that raises `P0005 TENANT_CLAIM_MISSING` (HTTP 403, `type=https://api.invenio.example/errors/tenant-claim-missing`) when the claim is absent. Read paths accept empty results (safer to show empty than error), but clients observing an empty response on a known-populated tenant should surface a "system configuration error" banner — the explicit error on writes gives the fast escalation path.

- **`auth.users` row exists without a matching `public.users` row.** Result: hook returns NULL claims; behaves as the previous point. Occurs if an external signup path bypasses the Edge Function wrapper, or during a migration-batch race. *Mitigation:* a `BEFORE INSERT` trigger on `auth.sessions` raises if no `public.users(id = NEW.user_id)` row exists — forces the paired-row invariant at the database layer on first session creation. Admin-bypass flows (imports) run under `SET LOCAL role = 'service_role'` to skip the trigger during batches; batches complete by inserting `public.users` before any `auth.sessions` row is minted (enforced by import script ordering).

- **Hook is redeployed incorrectly.** Supabase's hook registration is at project scope; a bad deploy affects all tenants immediately. *Mitigation:* every hook deploy runs the `test/integration/access-token-hook.test.ts` suite (P0) verifying the hook returns correctly-shaped claims for representative user profiles (admin, submitter, pending, revoked, banned). A deploy that doesn't pass the suite is a CI gate failure. Rollback is `supabase functions deploy --no-verify-jwt` of the previous hook version.

- **Hook performance regression.** Hook runs on every token mint / refresh (15-min cycle per §4.2). Slow hook → slow logins and slow refresh storms. *Mitigation:* the hook is benchmarked in CI with a synthetic profile (p99 < 10ms); a regression fails the build.

---

## 5. Roles & permissions

The system has **two roles** — stored on `public.users.role`, mirrored into the JWT as the `app_role` claim by the custom access-token hook (§4.2) so RLS policies can gate writes by role cheaply:

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
- Only `admin` can change another user's role (`admin` ↔ `submitter`) — via an Edge Function that updates `public.users.role` and calls `auth.admin.signOut(user_id, 'global')` so the next login's JWT carries the new `app_role` claim.
- Role change invalidates sessions (forces re-login); `audit_events` row written.
- Adding or removing approval capability (via assignment-table edits) does **not** invalidate sessions; the approver set is resolved at run time from `silo_role_assignments` / `project_role_assignments`, so the next `GET /rest/v1/rpc/my_pending_approvals` poll reflects the change.

---

## 6. Core domain model

### 6.1 Tenants & users

```
tenants(
  id, name, slug, status, timezone, locale, email_from_address,
  webhook_url NULL, webhook_signing_secret_ref NULL,
  stall_hours,
  login_max_attempts        integer NOT NULL DEFAULT 5,
  login_lockout_minutes     integer NOT NULL DEFAULT 15,
  created_at
)

public.users(
  id                   uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  username             text NOT NULL,
  email                text NOT NULL,          -- denormalized mirror of auth.users.email for RLS/readability
  role                 user_role NOT NULL,     -- {admin, submitter}; mirrored into JWT as app_role
  employee_id          uuid NULL REFERENCES employees(id),  -- NULL for admins or non-worker oversight users
  status               user_status NOT NULL DEFAULT 'pending',  -- {pending, active, revoked}
  sessions_revoked_at  timestamptz NULL,       -- revocation denylist marker; compared against JWT `iat` in sensitive RPCs (§4.2)
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  UNIQUE(tenant_id, username),
  UNIQUE(tenant_id, email)
)

public.user_unlock_markers(
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  unlocked_at     timestamptz NOT NULL DEFAULT now(),
  unlocked_by     uuid NULL REFERENCES public.users(id) ON DELETE SET NULL
)
-- The `before-login` hook (§4.7) only counts auth.audit_log_entries
-- failures after the latest unlock marker for the user.

audit_events(
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  actor_user_id   uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  action_type     text NOT NULL,          -- e.g. user.revoke, user.restore, user.unlock, flow.create, flow.edit
  subject_type    text NULL,              -- e.g. user, flow, project
  subject_id      uuid NULL,
  ts              timestamptz NOT NULL DEFAULT now(),
  details         jsonb
)
```

**Tables owned by Supabase Auth** (in the `auth` schema, not ours): `auth.users`, `auth.sessions`, `auth.refresh_tokens`, `auth.identities`, `auth.audit_log_entries`. The v0.3 `invites`, `password_history`, `sessions`, `auth_events` tables are **dropped** — subsumed by Supabase Auth features (§4). `approval_actions` and `approval_reassignments` (§7.3) remain the dedicated audit tables for approval-subsystem events; `audit_events` captures everything else.

**On first login** (invite acceptance or recovery), a database trigger on `auth.users` updates `public.users.status` from `pending` to `active`. Implemented as `AFTER UPDATE OF last_sign_in_at ON auth.users` with a `SECURITY DEFINER` trigger function.

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

**Implementation mapping (v0.4):** the behavior in this section is unchanged from v0.3. Transitions (`approve`, `reject`, `recall`, `reassign`, `admin_override`, badge-override resolution) are implemented as **plpgsql functions exposed as PostgREST RPCs** — each function performs version-check + run UPDATE + action INSERT + dependent timesheet UPDATE in a single transaction (§7.4 "Concurrency"). Notification fan-out happens via an `AFTER` trigger on `approval_actions` that inserts into the `notification_outbox` table; a pg_cron-scheduled Edge Function drains the outbox and delivers (§7.6). Endpoint naming in §8.

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

Every approval state transition fires notifications to a resolved recipient set. v1 delivery channels: **email** (Resend via Edge Function) + **outbound webhook** (tenant-configured URL). No in-app inbox; approvers poll the `my_pending_approvals` RPC.

**Implementation (v0.4):** an `AFTER INSERT` trigger on `approval_actions` (plus `AFTER UPDATE` on `approval_runs` status transitions) inserts one row per recipient into a `notification_outbox` table with `status='pending'`. A pg_cron-scheduled Edge Function drains the outbox every minute, sending email + webhook per row; on success marks `status='sent'`, on failure increments `attempts` and reschedules per the retry policy below. Stall detection (below) is a separate pg_cron job scanning `approval_runs` and inserting outbox rows.

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
- **Failure handling:** webhook retries 3× with exponential backoff via the outbox worker; persistent failure writes to `notification_failures` and alerts tenant admins. Email failures surface in Supabase Auth's audit log (auth-flow emails) or in `notification_failures` (domain notifications sent via Resend).

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

**Audit.** Override runs are addressable via the same `approval_runs` table (`GET /rest/v1/approval_runs?id=eq.<run_id>&select=*,approval_actions(*)`); the full audit trail per-timesheet spans both the authorization flow and any overlapping reconciliation flow(s).

---

## 8. API surface

The API surface is three layers:

1. **Supabase Auth endpoints** — hosted by Supabase; clients call via `supabase-js`. No bespoke auth endpoints in this spec.
2. **PostgREST auto-generated table endpoints** — one URL per `public.*` table, gated by RLS policies. Cursor-based pagination via the `Range` header. Default base path: `/rest/v1/<table>`.
3. **Custom endpoints** — transactional operations as **PostgREST RPCs** (plpgsql functions; path `/rest/v1/rpc/<function_name>`) and side-effect operations as **Edge Functions** (Deno/TS; path `/functions/v1/<function_name>`).

All clients send the user's Supabase JWT in `Authorization: Bearer <access_token>` (automatic when using `supabase-js`). RLS reads `tenant_id` and `app_role` from the JWT claims; cross-tenant access returns empty results (single-row reads → 404, collections → `[]`).

### Auth (Supabase-hosted; via `supabase-js`)

Use the client library directly — no custom endpoints:
```
supabase.auth.signInWithPassword({ email, password })
supabase.auth.signOut()
supabase.auth.updateUser({ password })
supabase.auth.exchangeCodeForSession(code)   // invite / recovery link
supabase.auth.resend({ type: 'recovery', email })
```

(Sign-in uses email + password, not `tenant_slug` + `username`. Because `public.users.username` is unique-within-tenant only, sign-in keys off the globally-unique email. Username remains available for display / identification.)

### `withAdminContext` — mandatory wrapper for admin Edge Functions

Every admin Edge Function MUST extend this shared handler — the sole authorized path from a caller's JWT to a service-role client. The pattern:

```ts
// supabase/functions/_shared/with-admin-context.ts
export async function withAdminContext<T>(
  req: Request,
  handler: (ctx: AdminContext) => Promise<T>,
): Promise<Response> { … }

export interface AdminContext {
  readonly actor:   { user_id: string; tenant_id: string; };
  readonly sb:      SupabaseClient;    // tenant-pinned service-role client
  readonly request: Request;
}
```

The wrapper: (a) extracts the caller's JWT from the `Authorization` header; (b) rejects with 401 if absent / invalid / missing required claims (`tenant_id`, `app_role`, `iat`); (c) calls `assert_session_live(jwt)` against the revocation denylist (§4.2); (d) rejects with 403 if `app_role !== 'admin'`; (e) initializes a service-role Supabase client with `tenant_id` attached for the inner handler's reads/writes; (f) invokes the inner handler inside a try/catch that maps PostgREST / plpgsql errors to RFC 7807 (Error format below).

The inner handler **never receives a raw service-role key or SDK** — only the tenant-pinned wrapper. `AdminContext.sb`'s underlying request headers include `X-Tenant-Pin: <tenant_id>`, allowing an optional RLS bypass-check policy to verify the pin against writes (defense in depth).

**CI gate.** A linter rule rejects any Edge Function source file that imports `createClient` from `supabase-js` directly; admin Functions MUST import the wrapper factory. Non-admin Edge Functions (e.g., future unauthenticated public endpoints, if any) must use the anon-key path and are not eligible to hold the service-role key.

### User admin (Edge Functions — all extend `withAdminContext`)

```
POST  /functions/v1/invite-user            { username, email, role, employee_id? }
POST  /functions/v1/reset-password/:user_id
POST  /functions/v1/revoke-user/:user_id
POST  /functions/v1/restore-user/:user_id
POST  /functions/v1/change-user-role       { user_id, role }
POST  /functions/v1/unlock-user/:user_id
```

Each function performs admin operations on `auth.users` via the Supabase service-role SDK (supplied by `AdminContext.sb`) and the corresponding `public.users` row update. Password change / reset / revoke / role change also update `public.users.sessions_revoked_at = now()` to poison any in-flight access tokens per §4.2.

### Tables (PostgREST, RLS-scoped)

Auto-exposed per table. Admin-gated tables restrict write verbs via RLS policy to `app_role='admin'`; read is tenant-wide:

| Table | Read | Write |
| --- | --- | --- |
| `tenants` | self tenant only | service-role only (provisioning) |
| `users` | tenant-wide | admin |
| `employees` | tenant-wide | admin |
| `subcontractors` | tenant-wide | admin |
| `projects`, `areas`, `project_subcontractors` | tenant-wide | admin |
| `task_codes`, `cwps`, `fcos` | tenant-wide | admin |
| `approval_flows`, `approval_nodes`, `approval_node_approvers` | tenant-wide | admin |
| `project_flow_assignments` | tenant-wide | admin |
| `silo_role_assignments`, `project_role_assignments` | tenant-wide | admin |
| `timesheets`, `timesheet_lines` | scope-filtered (submitter sees own + proxy silos; admin sees all) | submitter within scope while `draft`; RPCs mutate post-submit |
| `approval_runs` | scope-filtered (submitter of the parent timesheet + eligible approvers + admin) | read-only; state changes via RPCs |
| `approval_actions` | same scope as parent run | read-only; append path is via RPCs |
| `badge_overrides` | scope-filtered | read-only; mutation via RPC |
| `audit_events` | admin | service-role only |

### Timesheet lifecycle (RPCs)

Transactional; all return the canonical post-transition row(s) or a Problem Details error.

```
POST /rest/v1/rpc/submit_timesheet          { timesheet_id }
POST /rest/v1/rpc/recall_timesheet          { timesheet_id }
POST /rest/v1/rpc/claim_field_timesheet     { timesheet_id }      -- open → draft
POST /rest/v1/rpc/release_field_timesheet   { timesheet_id }      -- draft → open
```

### Approvals (RPCs; transactional state machine)

```
POST /rest/v1/rpc/approve_run               { run_id, comment?, idempotency_key? }
POST /rest/v1/rpc/reject_run                { run_id, comment,  idempotency_key? }
POST /rest/v1/rpc/reassign_run              { run_id, to_user_id, reason }      -- admin
POST /rest/v1/rpc/override_run              { run_id, decision, comment, idempotency_key? }  -- admin
POST /rest/v1/rpc/resolve_badge_override    { override_id, outcome, reason }
```

Each function: authorizes the caller via `auth.jwt()` + assignment-table lookups, enforces the `approval_runs.version` check (§7.4), writes `approval_actions` + any dependent updates, bumps version — all in one transaction. Returns 409 with `{ run_state, latest_version }` on version mismatch, 403 if not an eligible actor, 404 if run not visible to caller's tenant.

**Idempotency:** `idempotency_key` is a body parameter (rather than a header) because PostgREST RPCs don't give the function direct access to custom request headers. Stored in an `idempotency_keys` table keyed on `(actor_user_id, key)`, 24h TTL, cleaned by pg_cron. Same-actor retries return the cached response; different actors with the same key value race normally through the version check.

### Composed reads (RPCs)

```
GET  /rest/v1/rpc/my_pending_approvals            → runs where caller is currently eligible
GET  /rest/v1/rpc/project_readiness?project_id=…  → { ready, missing: [...] }
```

### Export & migration (Edge Functions)

```
POST /functions/v1/export-labor              { from, to, project_id?, status? }  -- returns CSV or XLSX
POST /functions/v1/import-localstorage       (multipart; §9 Phase A; admin + service-role-scoped)
POST /functions/v1/import-spreadsheet        (multipart; §9 Phase B; admin + service-role-scoped)
POST /functions/v1/release-queued-invites    (cutover step; §9 Phase A)
```

### Error format

Two error conventions coexist. (v0.4.0 implied uniform RFC 7807 across both; that was infeasible — PostgREST has no hook for reshaping its native error envelope. v0.4.1 names both shapes.)

- **PostgREST auto-generated endpoints** — including `/rest/v1/<table>` and `/rest/v1/rpc/<function>` called directly — return PostgREST's **native error envelope**: `{ code, details, hint, message }`. plpgsql RPCs raise custom SQLSTATE codes that PostgREST surfaces in `code`. We standardize on SQLSTATE class `P0` for domain errors:

  | Code    | Meaning                       |
  | ------- | ----------------------------- |
  | `P0001` | `PROJECT_NOT_READY`           |
  | `P0002` | `RUN_STATE_CHANGED`           |
  | `P0003` | `INVALID_STATE_TRANSITION`    |
  | `P0004` | `APPROVER_NOT_ELIGIBLE`       |
  | `P0005` | `TENANT_CLAIM_MISSING`        |
  | `P0006` | `SESSION_REVOKED`             |
  | `P0007` | `RATE_LIMITED`                |
  | `P0008` | `IDEMPOTENCY_CONFLICT`        |

  Structured extension data (e.g. the `missing` array for `PROJECT_NOT_READY`) travels in PostgREST's `details` field as JSON.

- **Edge Functions** return **RFC 7807 Problem Details** (`application/problem+json`). The `withAdminContext` wrapper (and its non-admin equivalents) catches PostgREST errors from nested calls and reshapes `code` → stable `type` URI (`https://api.invenio.example/errors/project-not-ready`, etc.), lifts `details` into the appropriate extension fields, and sets `title`, `status`, `instance`. Clients consuming both surfaces branch on response `content-type`.

**Recommended client posture.** Mutating state changes go through Edge Functions (which wrap the RPC and return RFC 7807). Direct PostgREST table/RPC calls are reserved for read-heavy and low-stakes-write paths where PostgREST-native errors are acceptable; for those, the client parses the `P0*` code space into domain semantics.

---

## 9. Re-platforming and go-live

This is a **re-platforming**, not a pure migration. The current frontend's localStorage model covers only a subset of the v1 backend's concepts — employees, projects, reference data (task codes, CWPs, FCOs), and historical timesheets can be imported mechanically, but **subcontractors, per-employee sub assignments, project↔sub engagements, flow templates, and per-silo/per-project role assignments are net-new domain entities** that the current system has no record of. They must be designed with the customer and populated before go-live.

**Rollout model: big-bang cutover.** Phase A (data import) and Phase B (domain configuration) both complete before any user touches the new system. The legacy localStorage app remains the system of record until cutover day; invites are queued during setup and released only at cutover.

**Ownership:** Phase B is **Invenio-led**. Until the new app is live, the customer does not touch the admin UI — they receive spreadsheet templates from Invenio, fill them in, and send them back. Invenio validates and loads. (Post-go-live, admin UI access can be delegated to customer-side admins for ongoing changes; the spreadsheet workflow is a setup-phase convenience, not a permanent constraint.)

### Phase A — Data import (scripted)

Mechanical, one-time ingestion of data that already exists in the customer's localStorage dump. Invenio runs this against a freshly provisioned Supabase project / tenant.

1. **Stable external IDs.** Supabase issues UUIDs for all entities. `employees.external_id`, `projects.external_id`, etc. preserve the old `E001`/`P001` strings for reference and to let the import map old → new.
2. **Import endpoint** `POST /functions/v1/import-localstorage` (admin + service-role-scoped; idempotent per tenant) accepts the full `tk_*` JSON blob and loads:
   - `employees` (without `subcontractor_id` — assigned in Phase B);
   - `projects`, `areas`, `task_codes`, `cwps`, `fcos`;
   - Historical `staff_timesheets` and `field_timesheets` as `draft` status (no approval runs — see "Historical timesheet handling" below).
3. **User records** imported via `auth.admin.createUser({ email, email_confirm: false })` — creates the `auth.users` row with no password set, plus the linked `public.users` row (`status='pending'`). No plaintext passwords cross the boundary. No invite email is sent; the user's tenant+role metadata is attached via `user_metadata` so the custom access-token hook picks it up at first login. **Cutover** is a separate step (`POST /functions/v1/release-queued-invites`) that iterates over pending users and calls `auth.admin.generateLink({ type: 'invite' })` to send.
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
- Every imported user has `auth.users` row (no password set) + `public.users.status='pending'`; no invite link has yet been generated.

On cutover: `POST /functions/v1/release-queued-invites` runs, invite emails go out, users authenticate via the invite flow (§4.3), and the legacy app goes read-only.

### Frontend transition

At cutover the frontend switches from `DB.*` localStorage calls to **supabase-js** against the project URL + anon key. Status handling expands from `{draft, submitted, open}` to the full vocabulary in §7.4. The `badge-approved` CSS class (currently dead) comes to life. (The current app's `open` status for admin-pre-created field timesheets needs explicit preservation or collapse — see adversarial-analysis item M-10.) The existing vanilla-JS frontend is a communication / reference artifact; a replacement frontend is rebuilt from scratch against the v0.4 API surface.

## 10. Open questions / out of scope (park for v2)

- **n-of-m quorum per node.** Current spec is any-of (quorum=1). Field already present in design (`approval_nodes.quorum`, default 1) — left unused to keep v1 simple.
- **Bounce-to-node on reject.** v1 rejects terminate the run. v2 could allow "reject back to node 2".
- **Cost/rate/billing enrichment.** Per `test_export.xlsx` — needs `rates` and `burden_multipliers` tables keyed by `(craft, project, date)` or similar. Scope this separately.
- **Parallel nodes.** v1 nodes are strictly sequential (1 → 2 → 3). Parallel (e.g. node 3a and 3b both required) is a v2 feature.
- **External SSO.** Supabase supports OAuth / SAML / OIDC providers as drop-in alternatives to password auth; enabling them is a config change, not a redesign. Deferred until the customer asks.
- **In-app notifications / inbox.** v1 uses email + polling. Supabase Realtime subscriptions are available for push when wanted — deferrable.
- **Real-time collaborative editing of a field timesheet.** Not in scope.
- **Delegation.** Explicitly excluded — admin reassignment covers the requirement per §1.3. Revisit only if operational load on admins becomes a pain point.
- **Password history (last N=5).** Dropped from v1 (§4.1). Reinstating requires a custom `pre-password-change` hook reading a `password_history_hashes` table. **Compliance-dependent**: if the customer is subject to SOX, HIPAA, ISO 27001, or NIST 800-53 (common in construction primes bidding on federal / utility contracts), password history may be audit-mandated and the dropped-from-v1 stance needs reversal. Resolve before implementation begins (see §10a below).

### 10a. Compliance posture (pre-implementation question)

The v0.4.1 spec defers the following to an explicit customer conversation. Answers affect v1 scope:

| Question                                                               | If YES                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Customer is subject to SOX                                             | Password history + audit-log retention policy (years) become v1 requirements                            |
| Customer is subject to HIPAA                                           | Audit-log retention ≥ 6 years; encryption-at-rest verification; BAA required with Supabase              |
| Customer is subject to ISO 27001                                       | Password history, lockout cool-down policy, access-review cadence documented                            |
| Customer imports NIST 800-53 (common for federal / utility contracts)  | Password history, account lockout, session timeout, audit-log integrity (tamper-evident) all in v1      |
| Customer requires MFA on admin accounts                                | Scope MFA into v1; Supabase Auth supports TOTP / WebAuthn                                               |
| Customer has a data-residency constraint (EU, Canada, etc.)            | Supabase project region chosen accordingly; may block self-hosted / may block certain Supabase tiers    |

**Default posture** if the customer has no stated compliance obligations: v0.4.1 as specified. Per-account lockout (§4.7) is always v1; password history remains parked.

---

## 11. Implementation stack & conventions

Concrete technology choices and API conventions. Picks optimize for leverage — lean on **Supabase's managed bundle** (Postgres, Auth, PostgREST, Storage, Edge Functions) rather than build a bespoke HTTP service.

### 11.1 Stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Backend platform | **Supabase** (cloud or self-hosted) | Single integrated bundle. Replaces the v0.3 custom Fastify + Prisma + Redis stack. |
| Supabase tier | **Pro or higher** (cloud) / any (self-hosted) | Required for `pg_cron`, custom SMTP at project level, and the rate-limit headroom migration imports need. Free tier is acceptable only for prototype / eval; production must be Pro+. |
| Database | **PostgreSQL 15+** (via Supabase) | Needed for `NULLS NOT DISTINCT` in UNIQUE constraints. RLS primary tenant enforcement. |
| Auth | **Supabase Auth** | JWT access (15-min TTL, §4.2) + refresh tokens; bcrypt hashing. See §4 for deviations from v0.3 (argon2id, opaque sessions). |
| CRUD API | **PostgREST** (auto-generated by Supabase) | One REST endpoint per `public.*` table; RLS-gated. Cursor pagination via `Range` header. |
| Transactional logic | **plpgsql functions** exposed as PostgREST RPCs | Approval state machine, submit routing, readiness check, timesheet lifecycle. `SECURITY INVOKER` so RLS applies. Sensitive mutations call `assert_session_live` + `assert_tenant_claim_present` (§4.2, §4.8). |
| Side-effect logic | **Supabase Edge Functions** (Deno, TypeScript) | Email, webhooks, exports, admin-bypass operations (invite, revoke, reset, unlock), spreadsheet import. Admin Functions extend the shared `withAdminContext` wrapper (§8); a CI lint gate rejects direct service-role key usage. |
| Background jobs | **pg_cron** + a `notification_outbox` table + Edge Functions | Stall detection, notification delivery with retry, idempotency-key cleanup, invite release, `sessions_revoked_at` denylist cleanup (pruned after 15-min access-token TTL elapses). Replaces v0.3's BullMQ/Redis. |
| HTTP transport | Handled by Supabase | No custom HTTP framework; no bespoke service to host, scale, or monitor. |
| Schema migrations | **Supabase CLI** (`supabase migration new` / `supabase db push`) | Versioned SQL files in `supabase/migrations/`. |
| Password hashing | Supabase Auth default (**bcrypt**) | Deviation from v0.3 (argon2id). See §4.1. |
| Session tokens | Supabase-issued **JWTs** | Deviation from v0.3 (opaque DB-backed). See §4.2. |
| JWT tenant/role claims | **Custom access-token hook** (plpgsql) | Reads `public.users.tenant_id` and `role`; Supabase calls the hook when minting tokens. |
| Email delivery | Supabase Auth built-in templates (auth flow) + **Resend** via Edge Functions (domain notifications) | Webhook delivery for domain events uses `X-TK-Signature` HMAC (§7.6). |
| Language (custom code) | **TypeScript (strict)** for Edge Functions, **plpgsql** for RPCs | Edge Functions target the Deno runtime Supabase ships. |
| Testing framework | **Vitest** | TypeScript-first. |
| Local integration stack | **Supabase CLI** (`supabase start`) | Spins up local Postgres + Auth + PostgREST + Functions + Storage in Docker. Integration tests hit the local stack — no mocks. |
| Client library | `supabase-js` | Used by the (future) frontend and by Edge Functions for cross-function calls. |
| Secrets | Supabase Edge Function secrets (`supabase secrets set`) for Function env; Supabase Vault for DB-side secrets | `webhook_signing_secret_ref` points at a Vault key, not the raw secret. |

### 11.2 API conventions

**Versioning.** PostgREST endpoints live under `/rest/v1/`; Edge Functions under `/functions/v1/`. Breaking changes roll to `v2` per-surface; `v1` remains for a deprecation window (≥ 6 months).

**Error responses** — two shapes coexist (authoritative treatment in §8 "Error format"; summary here):

- **PostgREST endpoints** (tables + RPC-called-directly): native `{code, details, hint, message}` envelope. Our plpgsql RPCs raise SQLSTATE class `P0` codes (`P0001 PROJECT_NOT_READY` … `P0008 IDEMPOTENCY_CONFLICT`).
- **Edge Functions**: RFC 7807 Problem Details (`application/problem+json`). `withAdminContext` and non-admin Edge Function wrappers catch PostgREST errors from nested calls, map `P0*` codes to stable `type` URIs, lift `details` into structured extensions, and return the Problem Details body:

  ```json
  {
    "type": "https://api.invenio.example/errors/project-not-ready",
    "title": "Project not ready for submission",
    "status": 409,
    "detail": "Project P123 is missing required configuration",
    "instance": "/functions/v1/submit-timesheet",
    "missing": ["project_flow_assignment", "silo_role_assignments:sub=S003:role=foreman"]
  }
  ```

Clients consuming both surfaces branch on response `content-type`. The v0.4.0 commitment to uniform RFC 7807 was infeasible (PostgREST has no error-mapping hook); v0.4.1 names both shapes explicitly rather than pretending.

**Pagination.** PostgREST tables use `Range` header pagination (its native convention). Custom RPCs returning collections use `?limit=<int>&cursor=<opaque>` with default 50 / max 200, returning `{ data: [...], next_cursor: string | null }`.

**Authentication header.** `Authorization: Bearer <supabase_jwt>`. `supabase-js` attaches the current session's access token automatically. Server-side (Edge Functions) extract claims via `getUser()` on the supabase client.

**Idempotency.** RPC calls that mutate state (`approve_run`, `reject_run`, `override_run`, bulk import) accept an optional `idempotency_key` **body parameter** (not header — PostgREST RPCs can't easily read custom headers). Responses cached for 24h in an `idempotency_keys` table keyed on `(actor_user_id, key)`; pg_cron prunes rows older than 24h hourly.

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
| JSON payloads | `JSONB` | `audit_events.details`, `notification_failures.payload`, etc. |

### 11.4 Index strategy

Required indexes on every tenant-scoped table:

- Composite `(tenant_id, …)` on primary query paths — matches the RLS filter pattern.
- All foreign keys (verify; Postgres doesn't create these automatically).

Table-specific required indexes:

| Table | Index | Purpose |
| --- | --- | --- |
| `public.users` | `UNIQUE (tenant_id, username) WHERE status != 'revoked'` | Allow username reuse after revoke (addresses M-13). |
| `public.users` | `UNIQUE (tenant_id, email) WHERE status != 'revoked'` | Same for email. |
| `timesheets` | `(tenant_id, employee_id, period_start, period_end)` | "My timesheets" queries. |
| `timesheets` | `(tenant_id, project_id, status)` | Admin listings, project dashboards. |
| `approval_runs` | `(tenant_id, current_node_id, status)` | `my_pending_approvals` RPC. |
| `approval_runs` | `(tenant_id, timesheet_id)` | Run-attach lookup. |
| `approval_actions` | `(run_id, ts)` | Run history timeline. |
| `audit_events` | `(tenant_id, ts DESC)` | Admin audit browsing. |
| `project_flow_assignments` | `(tenant_id, project_id, effective_from DESC, effective_to)` | Active-flow resolution at submit. |
| `silo_role_assignments` | `(tenant_id, project_id, subcontractor_id, role_label, effective_from DESC)` | Approver resolution. |
| `project_role_assignments` | `(tenant_id, project_id, role_label, effective_from DESC)` | Approver resolution. |
| `badge_overrides` | `(tenant_id, status)` | Open-overrides dashboard. |
| `notification_outbox` | `(status, scheduled_for) WHERE status='pending'` | Outbox worker pickup. |
| `idempotency_keys` | `(actor_user_id, key)` PK; `(created_at)` for pg_cron cleanup | RPC idempotency. |

Indexes on Supabase-owned auth tables (`auth.users`, `auth.sessions`, etc.) are managed by Supabase; do not modify.

Unique constraints with NULL-able columns use `NULLS NOT DISTINCT` (Postgres 15+) or per-branch partial indexes — see §7.1 note on `approval_node_approvers`.

### 11.5 Testing conventions

- Every PR ships tests for the code it adds or changes.
- Integration tests hit the **Supabase local stack** (`supabase start` — Postgres + Auth + PostgREST + Functions + Storage in Docker). No mocks — per the authoritative-source principle, we don't want mocks passing while production integrations fail.
- plpgsql RPC tests assert the transactional contract: version-check + action insert + dependent updates all commit together, or all roll back.
- Concurrency tests simulate racing actors with `Promise.all` of concurrent requests; assert both winner effect and loser 409.
- Multi-tenant isolation tests cover every write path (PostgREST table, RPC, Edge Function): caller in tenant A cannot observe/modify tenant B's data; responses are 404 (or empty collection) to avoid existence leaks.
- Edge Function tests run under Deno via the Supabase CLI test harness.
- See `docs/backend-test-plan.md` for the full test-plan checklist, organized by subsystem with P0/P1/P2 priorities.

### 11.6 Security-critical test gates

Some v0.4.1 controls fail silently when broken (no error, just empty responses). These MUST have dedicated CI gates that block deploys:

- **Access-token hook.** `test/integration/access-token-hook.test.ts` (P0): for each representative user profile (admin, submitter, pending, revoked, banned, multi-tenant sanity), verify the hook returns a JWT with correctly-shaped `tenant_id` and `app_role` claims. A deploy that mutates the hook without passing this suite is a CI gate failure.
- **`withAdminContext` lint.** AST-level lint rule rejects Edge Function source files that import `createClient` from `supabase-js` directly, or that reference `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` outside the `_shared/with-admin-context.ts` file. A merge that violates this is a CI gate failure.
- **Revocation denylist coverage.** Static-analysis test enumerates all plpgsql functions in state-mutating categories (`approve_*`, `reject_*`, `reassign_*`, `override_*`, `submit_*`, `resolve_*`, `recall_*`) and asserts each begins with a call to `assert_session_live(auth.jwt())`. A new RPC added without the call is a CI gate failure.
- **Tenant-claim presence.** Same pattern as above for `assert_tenant_claim_present()` on every tenant-scoped state-mutating RPC.

### 11.7 Service-role key rotation

The Supabase service role is the tenancy-isolation boundary; compromise = full-project bypass of RLS on every tenant.

**Storage.** One **project-level** secret (`SUPABASE_SERVICE_ROLE_KEY`) referenced by Edge Functions via `Deno.env.get(...)`. Never copied per-Function. Never committed to version control. Never pasted into chat or markdown. Local development uses `backend/.env` (gitignored); CI uses the CI provider's secret store; production uses Supabase's project secrets.

**Rotation cadence.**

- **Annual.** Calendar-bound ops task.
- **Post-incident.** Any suspected exposure — a commit to a repository, a paste in chat, a share with a party who should not have it.
- **Post-personnel-change.** When a team member with service-role access leaves.

**Runbook (grace-period rotation).**

1. In the Supabase dashboard, generate a new service-role key. Supabase retains the old key active during the transition.
2. `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<new>` at project scope.
3. Redeploy all Edge Functions (`supabase functions deploy <each>`) so they pick up the new env var.
4. Verify: `supabase functions logs` confirms Functions are operating. A synthetic admin call against each admin Function passes.
5. In the dashboard, revoke the old key.
6. Record the rotation event in the team's change log; reset the annual calendar.

**Runbook (emergency rotation — confirmed compromise).** Revoke the old key in the dashboard first (Functions will 500 during the gap). Push the new key. Accept ~30s outage. Then redeploy.

**On local-dev hygiene.** `backend/.env` holds the service-role key for local `supabase start` parity; **never** a companion markdown file, never a git-tracked file. If the key is found in a tracked location, rotate immediately.

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

### v0.4.1 — 2026-04-21 (HSI closure for v0.4)

Surgical revision closing findings #1–#6 from [adversarial-analysis-backend-spec-v0.4.md](adversarial-analysis-backend-spec-v0.4.md). No behavior change; security posture tightened and platform-seam failure modes named. Test-plan updates (§11.6 gates, pgTAP naming in §11.5) deferred to a companion test-plan revision.

Addressed:

- **HSI-#1 Service-role bypass.** New mandatory **`withAdminContext` wrapper** (§8) is the sole authorized path from a caller's JWT to a service-role client. CI lint gate rejects direct `createClient` / service-role-key imports in Edge Function source (§11.6). Service-role key consolidated to **one project-level secret**, not duplicated per-Function (§3, §11.7).
- **HSI-#2 JWT access-token TTL.** **Reduced to 15 minutes** (from Supabase default 1h) — §4.2. Introduced **revocation denylist** via `public.users.sessions_revoked_at` (compared against JWT `iat` by `assert_session_live()`) on every state-mutating RPC and every admin Edge Function's inner handler. Net effect: sensitive writes reject immediately after revocation; read-path staleness bounded to 15 min.
- **HSI-#3 Tenancy hook silent failure.** New **§4.8 "Tenancy hook failure modes & mitigations"**: failures enumerated, `assert_tenant_claim_present()` helper raises `P0005 TENANT_CLAIM_MISSING` on writes, `BEFORE INSERT` trigger on `auth.sessions` enforces `public.users` presence, hook deploys gated by `test/integration/access-token-hook.test.ts` (§11.6).
- **HSI-#4 Error-shape conflict.** **Two shapes acknowledged explicitly** (§8 "Error format", §11.2): PostgREST native envelope with a stable `P0*` SQLSTATE code space for direct-RPC callers; RFC 7807 Problem Details for Edge Function responses. v0.4.0's uniform-RFC-7807 claim dropped as infeasible. Recommended client posture: state-mutating calls go through Edge Functions for consistent error shape.
- **HSI-#5 Per-account lockout.** **Reinstated as v1** (§4.7) via a `before-login` plpgsql hook reading recent `auth.audit_log_entries` failures, with `tenants.login_max_attempts` / `login_lockout_minutes` as per-tenant config. Admin unlock via `POST /functions/v1/unlock-user/:user_id`; `public.user_unlock_markers` table resets the failure window for the hook. Defends against credential-stuffing that per-IP rate limits do not meaningfully mitigate.
- **HSI-#6 Service-role key rotation.** New **§11.7** with storage pattern (one project-level secret), cadence (annual + post-incident + post-personnel-change), and two runbooks (grace-period + emergency).

Related additions:

- **§10a Compliance posture** — pre-implementation matrix for SOX / HIPAA / ISO 27001 / NIST 800-53 / MFA / data-residency. Answers affect scope of password history (still parked pending input), audit retention, MFA in v1.
- **§11.6 Security-critical test gates** — CI gates for access-token hook, `withAdminContext` lint, revocation denylist coverage, tenant-claim presence.
- **Schema additions** (§6.1): `tenants.login_max_attempts` / `login_lockout_minutes`, `public.users.sessions_revoked_at`, `public.user_unlock_markers`.

Not addressed in v0.4.1 (tracked for future revisions):

- Finding #7 auth.users → public.users trigger fragility — mitigation path documented in §4.8 but the hook-vs-trigger decision for status transitions still open.
- Finding #8 idempotency-key body-vs-header ergonomics — partially resolved: state-mutating calls that go through Edge Functions can accept header; kept body-param fallback for direct-RPC calls.
- Findings #9–#15 — carry over for v0.4.2 or resolved in implementation (pgTAP naming, tier notes already in §11.1, import rate-limit strategy still open for Phase A).

### v0.4.0 — 2026-04-21 (Supabase pivot)

Material re-platform from the v0.3 custom-stack design (Fastify + Prisma + argon2 + opaque sessions + BullMQ/Redis) to a **Supabase-first architecture**. Behavioral requirements unchanged — multi-tenancy, RBAC, configurable approval workflow, audit, badge-override reconciliation, big-bang cutover — the platform underneath changes.

**Motivation.** Customer-side preference for a managed, integrated stack. Supabase Auth subsumes §4 almost entirely; PostgREST subsumes bulk CRUD (§8); plpgsql RPCs + Edge Functions cover the transactional and side-effect work. The net code-to-write shrinks materially with no compromise to the spec's behavioral surface.

**Accepted deviations from v0.3:**

- **§4.1** Password hashing: argon2id → **bcrypt** (Supabase Auth default; no algorithm choice exposed).
- **§4.2** Sessions: opaque DB-backed → **JWT access + refresh**. Revocation via `auth.admin.signOut`; spec-level semantics preserved.
- **§4.2** / **§6.1** `session_absolute_hours` / `session_idle_minutes` move from per-tenant to **Supabase-project global**; removed from the `tenants` table.
- **§4.1** / **§10** Password history (last N=5) **dropped from v1** — Supabase has no built-in mechanism; low-value defense.
- **§4.7** / **§10** Per-account login lockout **dropped from v1** — Supabase provides global per-IP rate limiting; per-account lockout requires a custom `pre-login` hook if the customer insists.

**Sections rewritten:** §1 preamble, §3 (multi-tenancy mechanism — `auth.jwt()` claim replaces `current_setting('app.tenant_id')` GUC), §4 (entire auth lifecycle mapped onto Supabase Auth), §6.1 (tables: `public.users` linked 1:1 to `auth.users`; `invites` / `password_history` / `sessions` / `auth_events` dropped; `audit_events` added for domain-level audit), §7 (unchanged behavior; added implementation note pointing to RPCs + Edge Functions), §8 (entire API surface recast as PostgREST + RPCs + Edge Functions, with the domain-specific shape preserved), §9 Phase A (import via `auth.admin.createUser`; `release-queued-invites` Edge Function at cutover), §10 (deferred items for password history + per-account lockout), §11.1 (stack table entirely rewritten), §11.2, §11.4, §11.5.

**Salvaged artifacts:**

- v0.3 init migration SQL — becomes the starting point for `supabase/migrations/` after dropping the auth-lifecycle tables (§6.1) and rewriting RLS policies to use `auth.jwt()`.
- All domain-model sections (§5 roles, §6.2-6.6, §7 behavioral text, §9 Phase B spreadsheet list, go-live gate) — unchanged.

**Discarded:**

- v0.3 scaffolded TypeScript/Fastify service — not a v0.4 artifact. Removed from the repo alongside this revision.

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
