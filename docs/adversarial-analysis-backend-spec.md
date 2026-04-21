# Adversarial Analysis: Backend Specification v0.1

**Target:** [backend-spec.md](backend-spec.md)
**Review date:** 2026-04-21
**Reviewer role:** Sophisticated skeptic — a senior backend engineer / solution architect who has shipped multi-tenant approval-workflow systems before and knows where these designs bleed.

---

## The Strongest Case Against

This document is presented as a backend spec for an existing application, but it is in fact a greenfield re-platforming hiding inside a migration narrative. Three of its load-bearing concepts — subcontractors, project-subcontractor silos, and a configurable multi-node approval flow — do not exist in the current frontend at all. The role vocabulary has been renamed without a mapping. The approval model is the entire point of the rebuild, yet it is specified in terms of abstractions (silos, role-on-silo, any-of nodes, reserved notification labels) that the customer has never seen and cannot validate against their actual operating model. The spec is internally coherent as a design exercise, but it makes the wager — without acknowledging it — that the customer's real workflow happens to match the model. If that wager is wrong, every section from §5 onward needs to be redone, and calling this work "migration" in §9 will have committed the project to an implementation timeline that doesn't include the discovery work the design still requires.

## Where the Argument Is Strong

The separation of flow templates from silo assignments (§7.1, §7.2) is the right abstraction — reuse is properly decoupled from routing, and the effective-dated `silo_flow_assignments` table is a sensible way to handle flow changes over time. The explicit refusal to support delegation (§10) and the choice to terminate rather than bounce on rejection (§7.4) are disciplined scope calls with clear rationale. The password-lifecycle design (§4) is thorough, covers the usual footguns (history, version-based session invalidation, separate invite consumption), and the audit-trail separation of `approval_actions` (append-only log) from `approval_reassignments` (targeted reporting) is clean. The non-goals list (§2) and the open-questions list (§10) both do real work — the author has thought about what they are *not* building.

## Logical Vulnerabilities

### 1. §9 is misnamed: this is re-platforming, not migration (Severity: **High**)

**What the text says:** §9 is titled "Migration from the current frontend" and begins "The current frontend uses localStorage keyed off tenant-less data." The implication is that the backend formalizes what the frontend already has.

**Why it's vulnerable:** It does not. Three of the spec's central concepts are absent from the current codebase:

- **Subcontractors.** Zero references to `subcontractor`, `subContract`, or any variant in `app.js` (2615 LOC) or `data.js`. Employees in the current seed have `{id, firstName, lastName, type, craft, active}` — no subcontractor field. The spec declares in §6.2 that "every employee must have a current `subcontractor_id`" and calls this *migrated*. It is not migrated; it is a new mandatory relationship on every employee, and every creation UI needs to change to support it.
- **Silos.** The `(project, subcontractor)` pair is load-bearing for the entire approval model (§7.2), but the current app has no notion of pairing. Projects stand alone.
- **Approver role.** The current frontend has roles `admin`, `staff`, and `timekeeper` ([app.js:130-132](../app.js#L130-L132)). The spec uses `admin`, `approver`, `submitter`. No mapping is given. There are zero existing `approver` users — every approval flow will launch with an empty eligible-approver pool unless admins hand-wire it post-migration.

A skeptical reviewer reading §9 comes away thinking the backend is a lift-and-shift. A VP signing off on the timeline based on that read will be surprised.

**What would strengthen it:** Rename §9 to "Re-platforming and data import." Separate it into two subsections: *(a) data import* (employees, projects, task codes, CWPs, FCOs — fields that exist today) and *(b) domain extensions requiring customer discovery* (subcontractor assignment for every employee, silo definition for every project, flow-template authoring, role-on-silo assignment, role-to-user remapping). Explicitly flag that (b) is a *project phase*, not an import script.

### 2. The subcontractor model is an assertion the customer has not been asked to validate (Severity: **High**)

**What the text says:** §6.2: "Internal Invenio employees belong to the 'Invenio' subcontractor row — there is no special-case for internal." §6.4: "A **silo** is a `(project_id, subcontractor_id)` pair."

**Why it's vulnerable:** The entire approval-routing architecture depends on this being the right grain. But several common construction-industry patterns don't fit:

- **Joint-venture labor.** Two subs on a project pool workers; an employee's "current sub" for the hour is ambiguous.
- **Loaned/seconded labor.** Employee from sub A works under sub B's foreman on a given day.
- **Craft-based approval.** Some operators route approvals by craft (welder foreman signs off on all welder hours regardless of employing sub), not by sub.
- **1099 / owner-operators.** Neither a sub nor an internal employee.

The spec has one safety valve (`employee_subcontractor_history`) but does not specify which sub governs routing when an employee transitions mid-timesheet-period. A staff user who moves from Invenio to a sub on Wednesday submits a Mon-Sun timesheet — which silo does it route through?

**What would strengthen it:** Before freezing v1, hold a structured discovery session with the customer specifically to validate: (a) that `(project, subcontractor)` is the correct silo grain for their approval routing; (b) how they want to handle multi-sub weeks; (c) whether craft or badge-system authority ever overrides sub-based routing. Add a subsection to §6 stating explicitly "a timesheet's silo is snapshotted from `employees.subcontractor_id` at submission time and does not change if the employee's assignment later changes" — or whatever rule emerges.

### 3. "Any-of" node advance is not safe against concurrent approvals (Severity: **High**)

**What the text says:** §7.4: "The eligible-approver list for a node is the union; the node advances on the **first** action (`any-of`, per §1 requirement)."

**Why it's vulnerable:** Two approvers click Approve within the same millisecond. Both requests pass authorization (the node is still open for both). Without explicit concurrency control, both can:

- Write an `approval_actions` row for the current node
- Advance `current_node_id` to the next ordinal (double-increment if the code is naïve, or race-advance past the end)
- Trigger two "node advanced" notifications to the next node's approvers

The spec describes the algorithm sequentially ("1. Validate. 2. Compute. 3. Resolve. 4. Create.") but gives no concurrency contract. There is no version column on `approval_runs`, no `current_node_ordinal` check in the described update, no mention of `SELECT FOR UPDATE` or an advisory lock.

**What would strengthen it:** Add a "Concurrency" subsection to §7. Specify one of: (a) optimistic — `approval_runs` gets a `version` column, approve/reject is a conditional update, loser gets 409 `ALREADY_ACTIONED`; (b) pessimistic — advance is wrapped in `SELECT … FOR UPDATE` on the run row. Also specify the idempotency key for approve/reject so a retrying client doesn't double-act.

### 4. §7.2 "no implicit default flow" is stated as discipline but is an operational failure mode (Severity: **High**)

**What the text says:** §7.2: "If no assignment exists, submission is blocked with an error telling the admin to configure one. **There is no implicit default flow.**"

**Why it's vulnerable:** Every new `(project, subcontractor)` pair requires an admin to configure a silo_flow_assignment before *any* submission on it. The concrete scenarios:

- New sub mobilizes on Monday. Foreman tries to submit Monday's crew hours Monday evening. Blocked. Admin is asleep. Crew's hours sit.
- Existing sub picked up on a new project. First submission fails. Same pattern.
- The backend in production can reach a state where *every* crew in a newly-onboarded silo is blocked until a human intervenes.

Frontend systems that block field workflows tend to get worked around — paper timesheets, Slack-to-admin-at-midnight, eventually data integrity erodes. The "no implicit default" rule trades ops realism for modeling purity.

**What would strengthen it:** Either (a) allow `draft`-state submission when no flow is assigned, with a daily "unassigned silos" digest to tenant admins, or (b) require tenants to mark a `default_flow_id` at provisioning time so onboarding is never blocked. The current stance — "admin must configure; users wait" — should be named as such so the customer can accept or reject it.

### 5. Role migration from `{admin, staff, timekeeper}` to `{admin, approver, submitter}` is not specified (Severity: **High**)

**What the text says:** §9.5 handles password migration. It does not address role remapping. The only role mention in §9 is indirect, under §9.2: "uploads existing draft/submitted timesheets as `draft`."

**Why it's vulnerable:** Concretely, the current user seed ([data.js:82-87](../data.js#L82-L87)) has users with `role ∈ {admin, staff, timekeeper}`. After migration:

- `staff` users need to become `submitter` with `employee_id` set (self-only scope).
- `timekeeper` users need to become `submitter` with `submitter_assignments` rows. But there is no existing source of truth for *which silos* a timekeeper is assigned to — that data does not exist in the current app.
- There are zero existing users who will become `approver`. Unless admins pre-seed approvers and populate `silo_role_assignments` and `approval_node_approvers` before the migration goes live, every approval flow starts with an empty eligible set.

The spec does not acknowledge any of this. §9 reads as though these concerns are handled elsewhere. They are not.

**What would strengthen it:** Add §9.6 "Role remapping": specify the automatic mapping (`staff → submitter+employee`, `admin → admin`), the manual mapping (`timekeeper → submitter` requires per-user silo-assignment input from the customer, collected in a spreadsheet before cutover), and the prerequisite ("no approval flows may be activated until `approver` users exist and nodes are populated"). Make this a gate on the cutover, not a task list.

### 6. Foreman-as-approver assumes every foreman is a system user (Severity: **High**)

**What the text says:** §7.1 reserves `foreman` as a role label in `silo_role_assignments`, which is keyed on `user_id`. §7.4 rejection routing: "The silo's **foreman** (user with `role_label='foreman'` on this `(project, sub)`)."

**Why it's vulnerable:** In the current app, `foreman` on a field timesheet is an employee ID ([data.js:177-187](../data.js#L177-L187): `foreman: 'E010'`). Tom Wright, employee E010, may not have a login — many construction foremen don't, and in this app's current seed his login `tkwright` happens to exist but only because he's being used to demonstrate the timekeeper role. In real deployments, foremen often read email through their superintendent.

When a rejection fires and the silo has no user with `role_label='foreman'`, the three-way notification fanout silently loses a recipient. The spec doesn't specify fallback.

**What would strengthen it:** Pick one: (a) require every field-foreman employee to have a user account (schema constraint: if `employees.craft ILIKE '%foreman%'` then a user must exist — uncomfortable), or (b) allow foreman notifications to fall back to the superintendent or a configured "escalation contact" per silo, or (c) send foreman notifications via email-to-employee even when no user exists (requires `employees.email`). Don't leave it implicit.

### 7. `password_version` check on every request is under-specified (Severity: **Medium**)

**What the text says:** §4.2: "On password change, admin reset, or user revocation: **all existing sessions invalidated** (tracked by `password_version` column on `users`; token claim must match)."

**Why it's vulnerable:** For opaque tokens stored in the `sessions` table, validation on every API request now requires joining `sessions → users` to compare `password_version` — or loading the user on every request. At scale (polling approvers, field workers with frequent submissions), this is a hot path. The spec doesn't specify whether `password_version` lives on the session row (denormalized at issuance, compared against live `users.password_version`) or whether every request reloads the user. It also doesn't address caching: if `users` is cached for 60 seconds, a revoked user has 60 seconds of live sessions.

**What would strengthen it:** Specify the mechanism. A common pattern: cache `password_version` per session for 60s, accept the revocation delay, document it. Or: on password change, drop a row into a `session_revocations` table and have a fast path check against it. Either is fine — the spec needs to pick one.

### 8. Staff-timesheet auto-split (§6.6) creates a partial-approval UX problem it doesn't address (Severity: **Medium**)

**What the text says:** §6.6 Staff-timesheet note: "the backend will split a weekly submission into **one `timesheets` row per `(employee, week, project)`** — each routes through its own silo. The frontend can still present one weekly grid; the submit handler is responsible for the split."

**Why it's vulnerable:** The submitter sees one weekly timesheet. The backend sees N runs, potentially through N different flows. Three silos can reach three different terminal states. What does the submitter see in the UI? What does "my week is rejected" mean when two of three projects are approved? Can the submitter edit just the rejected one, or do all three re-enter draft? If the user edits just the rejected project, what happens to the two runs that are approved — are they recreated?

The mental model ("the frontend can still present one weekly grid") papers over the hard part. The frontend's unified grid and the backend's split reality will diverge at every partial state.

**What would strengthen it:** Add a "Partial state handling for staff timesheets" subsection. Specify: whether edit-after-rejection locks out the approved silos, whether the UI shows per-project status badges, and whether resubmit only re-runs the rejected silo. Alternatively, reconsider the split: maybe the unit of approval is the weekly timesheet as a whole, and silo routing uses the project with the most hours (ugly, but simpler).

### 9. `badge_overrides` is defined but orphaned (Severity: **Medium**)

**What the text says:** §6.6 defines `badge_overrides(id, tenant_id, employee_id, date, hours_st, hours_ot, reason, overridden_by_user_id, ts)`.

**Why it's vulnerable:** It is never referenced again. The spec does not specify:
- Who creates them (admin? timekeeper? any submitter?).
- When they apply (do they affect approved runs? block submissions that disagree?).
- Whether creating an override on an approved timesheet triggers anything (re-approval? audit-only?).
- How they relate to the current frontend's `badgeRecords` ([data.js:152-167](../data.js#L152-L167)).

This table reads like it was lifted from a prior design note and left in place.

**What would strengthen it:** Either define its full lifecycle (who, when, effect on runs) or remove it from v1 and move it to §10.

### 10. The current app's `open` field-timesheet status is missing from the state machine (Severity: **Medium**)

**What the text says:** §7.4 state machine: `draft → submitted → in_review → approved | rejected | recalled`.

**Why it's vulnerable:** The current app uses `status: 'open'` for field timesheets pre-created by an admin awaiting crew entry ([app.js:220](../app.js#L220), [data.js:181](../data.js#L181)). This is a real workflow state — admin seeds a blank timesheet for a specific project/area/task/day, foreman fills in crew hours, *then* submits. The spec's `draft` implicitly means "created and being edited by the submitter." There's no state for "created by admin, not yet claimed by a submitter."

If the spec intends to collapse `open` into `draft`, the admin-pre-creation flow needs to be re-specified (who can edit? what's the field-timesheet creation API?). If `open` is meant to survive, the state machine is incomplete.

**What would strengthen it:** Decide explicitly: either preserve `open` in the state machine with transition rules, or document that `draft` covers the admin-pre-created case and specify the authorization rule (any submitter in the silo can edit an admin-created `draft`).

### 11. `tenants` schema is incomplete relative to features referenced elsewhere (Severity: **Medium**)

**What the text says:** §3 tenants table: `(id, name, slug, status, created_at)`.

**Why it's vulnerable:** Later sections reference per-tenant config that doesn't live anywhere in that schema:
- §4.2: "Sliding expiration: 12h absolute, 30min idle. Configurable per tenant."
- §7.6: "`tenant.stall_hours` (default 48)."
- §7.6: "Webhook: POST to `tenant.webhook_url` with `X-TK-Signature` HMAC header."
- §7.6: "per-tenant from-address" for email.

**What would strengthen it:** Add a `tenant_settings` table or extend `tenants` with: `session_absolute_hours`, `session_idle_minutes`, `stall_hours`, `webhook_url`, `webhook_signing_secret`, `email_from_address`. Spec'd out so rollout doesn't hit "oh, we need a migration for this."

### 12. Unique constraints with NULL columns will silently permit duplicates (Severity: **Medium**)

**What the text says:** §7.1: `approval_node_approvers … UNIQUE(node_id, approver_type, user_id, role_label)`.

**Why it's vulnerable:** When `approver_type='user'`, `role_label IS NULL`. When `approver_type='role_on_silo'`, `user_id IS NULL`. In Postgres default `UNIQUE` semantics (`NULLS DISTINCT`), two rows with the same `(node_id, 'role_on_silo', NULL, 'pm')` are both accepted. Same pattern on `silo_role_assignments`. You get duplicates.

**What would strengthen it:** Specify `UNIQUE NULLS NOT DISTINCT` (PG 15+) or use a partial index per branch: `UNIQUE(node_id, user_id) WHERE approver_type='user'` and `UNIQUE(node_id, role_label) WHERE approver_type='role_on_silo'`. Apply the same pattern wherever NULLs appear in unique keys.

### 13. Revoking a user breaks username reuse (Severity: **Medium**)

**What the text says:** §4.6: "User is **soft-deleted**: historical approval actions, timesheet submissions, and audit rows still attribute to this user."
§6.1: `UNIQUE(tenant_id, username), UNIQUE(tenant_id, email)`.

**Why it's vulnerable:** An admin revokes user `jsmith` (John Smith leaves). A new John Smith joins six months later, same username. Blocked by the unique constraint. Common enough in operations that it will hit production.

**What would strengthen it:** Make the uniqueness partial: `UNIQUE(tenant_id, username) WHERE status != 'revoked'`. Same for email. Explicitly specify revoked users' username/email can be reused (or append a suffix on revoke — messier but preserves history-linkability).

### 14. Silo flow reassignment during an open run is ambiguous (Severity: **Medium**)

**What the text says:** §8 endpoints include `POST /approval-flows/:id/deactivate — existing open runs keep old flow`. But `silo_flow_assignments` is separately effective-dated.

**Why it's vulnerable:** Two different concepts of "flow change":
- Flow v1 is deactivated → open runs keep it. Clear.
- Silo's `silo_flow_assignment` is updated to point at a different flow → the spec does not say what happens to open runs.

**What would strengthen it:** State explicitly: "open runs retain the flow they were created under. Silo flow reassignment only affects submissions after `effective_from`."

### 15. "Notify eligible approvers" polling load is not addressed (Severity: **Low**)

**What the text says:** §7.6: "No in-app inbox; approvers poll `GET /api/approvals/mine?status=pending`."

**Why it's vulnerable:** At scale — say 200 approvers, each polling every 30 seconds — that's 24,000 requests/minute for a feature that will show a change rarely. Each request is a join across `approval_runs`, `approval_nodes`, `approval_node_approvers`, `silo_role_assignments`. Not catastrophic, but worth specifying cache strategy or long-poll.

**What would strengthen it:** Add a note on expected polling cadence and optional Last-Modified / ETag support, or plan for a simple pubsub (e.g., Postgres LISTEN/NOTIFY) fanout in v1.1.

### 16. 30-minute idle timeout hostile to field use (Severity: **Low**)

**What the text says:** §4.2: "Sliding expiration: 12h absolute, 30min idle."

**Why it's vulnerable:** Field foreman on a site with spotty connectivity, taking a break for lunch, comes back and is re-auth'd mid-shift. Reasonable for office staff; rough for field.

**What would strengthen it:** Make idle timeout role-dependent (or tenant-configurable with a note to default higher for field-heavy tenants). Or, better, drop idle timeout entirely for `submitter` role and rely on the 12h absolute window.

### 17. `test_export.xlsx` cost/rate fields flagged for v2 but not schematized (Severity: **Low**)

**What the text says:** §10: "Cost/rate/billing enrichment. Per `test_export.xlsx` — needs `rates` and `burden_multipliers` tables keyed by `(craft, project, date)` or similar."

**Why it's vulnerable:** Not a v1 problem, but the v1 schema might lock in decisions that make v2 painful. Rates keyed by craft-and-project is one model; rates keyed by employee or by sub are others. The timesheet schema currently has `craft` on `employees` but no rate linkage. Worth a quick compatibility check now.

**What would strengthen it:** Skim `test_export.xlsx` against the v1 schema and add a one-paragraph "v2 readiness" note confirming no blocking decisions. Optional low-priority move.

## Evidence Gaps

1. **"5 nodes maximum" is asserted without rationale.** Is 5 based on user research, industry convention, or arbitrary? A customer coming from a 7-stage approval will rebel. At minimum, state the rationale ("based on review of existing customer flows" or "chosen to constrain UI complexity — extendable later").

2. **"Stall hours default 48" is unjustified.** 48 hours for construction payroll is a weekend — hours stall through every Saturday by design. Is the SLA clock business-hours or wall-clock? Not specified.

3. **No evidence that email + webhook is sufficient for this customer.** Construction foremen routinely don't check email during the day. SMS, Teams/Slack, or phone-based notification may be closer to what gets used. The spec asserts the channels without grounding.

4. **"Up to 5 ordered nodes per flow, any-of approvers per node" is presented as a requirement (§1).** Where does this come from? Customer discovery? A scoping conversation? Cited requirement would make it defensible; an uncited one is a designer's guess.

5. **Migration plan provides no timeline-of-effort estimate.** §9 has five steps but no sense of whether they're a week of work or a quarter. A skeptic reads this as "the hard part is hand-waved."

## Assumptions Worth Surfacing

1. **Assumption: every employee belongs to exactly one subcontractor at any given moment.** This excludes JVs, loaned labor, and labor-pool models. If the customer operates any of these, the silo model breaks and §7 needs reworking.

2. **Assumption: `(project, subcontractor)` is the right approval-routing granularity.** Some organizations route by craft (e.g., all welding hours go to the welding supervisor regardless of sub) or by area/zone. If customer routing is craft-based, silos don't map; if it's hybrid (some silos route by sub, some by craft), the `silo_role_assignments` table needs re-keying.

3. **Assumption: foremen are always system users.** The schema keys `silo_role_assignments.user_id` as the foreman identifier for notification purposes. If field foremen in practice don't log in, notifications silently drop.

4. **Assumption: the `approver` role will be seeded meaningfully at migration time.** The current user base has zero approvers. Unless migration produces a list of approvers and wires them into `silo_role_assignments` and `approval_node_approvers`, all flows are dead on arrival.

5. **Assumption: tenants configure silo flow assignments proactively, before first submission.** The "no default flow" rule only works if this is true. In practice, new project + new sub = inevitable ops delay at first submission.

6. **Assumption: the frontend team will absorb a large status-vocabulary change.** §9.4 says "the frontend switches from `DB.*` localStorage calls to a thin API client" — which implies the same team, same project, same timeline. But the status vocabulary expansion from `{draft, submitted, open}` to `{draft, submitted, in_review, approved, rejected, recalled, abandoned}` plus per-run run-status plus partial state handling for split staff timesheets is itself a frontend redesign, not a thin-client swap.

7. **Assumption: email delivery is reliable enough to be the primary notification channel.** For a workflow where the approver receiving the notification determines whether hours are paid on time, email-only is aggressive.

8. **Assumption: admin-override's heavy audit is sufficient compensation for its power.** `admin_override` lets an admin approve any node on any run. In a multi-admin tenant with weak internal controls, this is an unbounded bypass. Fine if acknowledged — dangerous if not.

## Suggested Strengthening Moves

1. **Rename §9 and split it.** "Re-platforming and data import" — with a clear subsection for customer-discovery-required concepts (subs, silos, approvers, flow templates) vs. straight import (employees, projects, reference data, staff timesheets).

2. **Hold a discovery session specifically on the silo model** before freezing §6.4 / §7.2. Validate against the customer's actual operating patterns; ask about JVs, loaned labor, and craft-based routing.

3. **Add a "Concurrency" subsection to §7.** Specify optimistic or pessimistic approach for `any-of` node advance. Specify idempotency keys for approve/reject. This is a small addition that prevents a real bug class.

4. **Add §9.6 "Role remapping"** as a gated migration step: produce a spreadsheet template for the customer ("list your existing timekeepers and which project/sub silos each should cover"), require it filled before cutover, and require at least one `approver` user per active silo before flows can activate.

5. **Decide the "no default flow" question explicitly.** If you keep the strict rule, add an admin digest of unassigned silos and document the expected ops response time. If you soften it, specify the draft-without-flow path.

6. **Specify foreman notification fallback.** Either require foreman-as-user (schema-enforced where possible) or define the email-to-employee fallback path. Don't let silent-drop be the default.

7. **Finish the tenants schema.** Add `webhook_url`, `webhook_signing_secret`, `stall_hours`, `session_absolute_hours`, `session_idle_minutes`, `email_from_address`. One table change now saves ten migrations later.

8. **Fix the unique constraints.** Audit every `UNIQUE` with NULL-able columns: `approval_node_approvers`, `silo_role_assignments`. Use `NULLS NOT DISTINCT` or partial indexes. While at it, make `users.username/email` uniqueness partial on `status != 'revoked'`.

9. **Add a "Partial state handling for staff timesheets" subsection** to §6.6 or §7. Specify what the submitter sees and can do when the N split runs reach different terminal states.

10. **Define `badge_overrides` fully or delete it from v1.** Currently it is an orphaned table.

11. **Preserve or explicitly collapse the `open` field-timesheet status.** Pick one; document the transition rules.

12. **Skim `test_export.xlsx` and add a one-paragraph v2-rates compatibility note** to §10. Cheap insurance against locking in a v1 schema that's hostile to v2.

## Conclusion

The spec is internally coherent and the approval-workflow design is thoughtful, but it mislabels itself as a migration and undersells the amount of customer discovery, user-facing change, and unknowns it actually contains. The highest-severity issues cluster in two places: (1) the assumption that subcontractors, silos, and the new role vocabulary are retrofits rather than new design commitments the customer has not yet validated, and (2) the under-specified concurrency and edge-case behavior of the approval state machine. Neither cluster is fatal. The spec is a strong v0.1 *design brief* — it is not yet a spec a small team could implement without a second round of customer conversations and a handful of targeted edits. The right next step is a discovery pass on the sub/silo model before any of §6 or §7 is implemented, and a set of surgical edits (items 3, 7, 8, 11 in the strengthening moves) to tighten the pieces that are already load-bearing.
