# Invenio Timekeeping — Backend Data Architecture

An L-shape view of the backend data model. The **vertical arm** on the left is
static configuration (tenancy → reference data → approval setup). The
**horizontal arm** extending right is operational state (timesheet lifecycle
→ approval runs → overrides → notifications). A thin cross-cutting layer
handles audit, idempotency, and cron-driven housekeeping.

Rendered preview: https://l.mermaid.ai/K1TcFZ

```mermaid
flowchart LR
  %% Vertical arm (left): identity + reference data + approval config
  %% Horizontal arm (bottom, right-ward): timesheet ↦ approval runs ↦ notifications
  %% Cross-cutting: audit + idempotency + cron

  classDef core fill:#E0F2FE,stroke:#0369A1,color:#0B1220,stroke-width:1.5px;
  classDef ref fill:#D1FAE5,stroke:#059669,color:#0B1220;
  classDef config fill:#EDE9FE,stroke:#7C3AED,color:#0B1220;
  classDef ops fill:#FEF3C7,stroke:#D97706,color:#0B1220;
  classDef notif fill:#FEE2E2,stroke:#DC2626,color:#0B1220;
  classDef xcut fill:#F1F5F9,stroke:#64748B,color:#0B1220,stroke-dasharray: 3 3;

  %% -------- Vertical arm --------
  subgraph VERT["Configuration (static)"]
    direction TB
    subgraph CORE["1. Tenancy + Identity"]
      direction TB
      tenants["tenants"]:::core
      users["users"]:::core
      tenants --> users
    end

    subgraph REF["2. Reference Data"]
      direction TB
      subs["subcontractors"]:::ref
      employees["employees"]:::ref
      emp_hist["employee_sub_history"]:::ref
      projects["projects"]:::ref
      areas["areas"]:::ref
      proj_subs["project_subcontractors"]:::ref
      codes["task_codes · cwps · fcos"]:::ref

      subs --> employees
      employees --> emp_hist
      projects --> areas
      projects --> proj_subs
      subs --> proj_subs
    end

    subgraph CFG["3. Approval Configuration"]
      direction TB
      flows["approval_flows"]:::config
      nodes["approval_nodes"]:::config
      approvers["approval_node_approvers"]:::config
      pfa["project_flow_assignments"]:::config
      sra["silo_role_assignments"]:::config
      pra["project_role_assignments"]:::config
      submit_asgn["submitter_assignments"]:::config

      flows --> nodes
      nodes --> approvers
      projects -.-> pfa
      flows -.-> pfa
    end

    CORE --> REF
    REF --> CFG
  end

  %% -------- Horizontal arm --------
  subgraph HORIZ["Operational Flow (live state)"]
    direction LR
    subgraph TS["4. Timesheets"]
      direction TB
      timesheets["timesheets"]:::ops
      lines["timesheet_lines"]:::ops
      timesheets --> lines
    end

    subgraph RUNS["5. Approval Runs"]
      direction TB
      runs["approval_runs"]:::ops
      actions["approval_actions"]:::ops
      reassigns["approval_reassignments"]:::ops
      runs --> actions
      runs --> reassigns
    end

    subgraph BADGES["6. Overrides"]
      direction TB
      badges["badge_overrides"]:::ops
    end

    subgraph NOTIF["7. Notifications"]
      direction TB
      outbox["notification_outbox"]:::notif
      webhooks["webhook_dispatches"]:::notif
      failures["notification_failures"]:::notif
      outbox --> webhooks
      outbox --> failures
    end

    timesheets --> runs
    runs --> badges
    runs --> outbox
  end

  %% Arm joint: config feeds operational flow
  CFG ==> TS
  CFG ==> RUNS

  %% -------- Cross-cutting --------
  subgraph XCUT["Cross-cutting"]
    direction LR
    audit["audit_events"]:::xcut
    idem["idempotency_keys"]:::xcut
    cron["pg_cron schedules"]:::xcut
  end

  users -.writes.-> audit
  runs -.writes.-> audit
  timesheets -.writes.-> audit
  runs -.dedups.-> idem
  cron -.drains.-> outbox
  cron -.scans.-> runs
```

## How to read it

**Vertical arm (configuration, top→bottom):**

1. **Tenancy + Identity** — everything is tenant-scoped. Every other table
   carries `tenant_id`; RLS keys off `auth.jwt() -> 'tenant_id'`.
2. **Reference data** — the static nouns (people, places, codes). Reference
   tables are `tenant_id`-scoped and admin-only for writes; all authenticated
   users can SELECT their tenant's rows.
3. **Approval configuration** — templates (flows → nodes → approvers) plus
   effective-dated assignments (flow-per-project, role-per-silo/project,
   submitter-per-silo). Changes here ride new runs, not in-flight ones.

**Horizontal arm (operational, left→right):**

4. **Timesheets** — `timesheets` is the header row with state-machine status;
   `timesheet_lines` are the day-by-day hours.
5. **Approval runs** — one run per submitted timesheet. `approval_actions` is
   the audit trail; `approval_reassignments` layers admin targeted
   reassignments on top of the flow's configured approver pool.
6. **Overrides** — `badge_overrides` captures retroactive
   badge-vs-submitted-hours reconciliation (spec §7.7). Cascades back to the
   parent run when resolved as badge-canonical.
7. **Notifications** — `notification_outbox` is the durable queue; the
   drain-notifications Edge Function claims rows and dispatches via Resend +
   webhooks. `webhook_dispatches` dedups per (tenant, run, event).

**Cross-cutting:**

- `audit_events` collects domain actions that don't have their own audit
  table (user lifecycle, flow edits, etc.).
- `idempotency_keys` caches RPC results for 24h so duplicate submits
  replay the first response.
- `pg_cron` drives drain-notifications (every minute),
  reconcile-stuck-sending (every 5 min), and emit-stall-notifications
  (hourly).

## Who writes what

| Layer | Who writes |
|-------|------------|
| Tenancy + identity | provisioning scripts + admin Edge Functions (invite, revoke, restore, change-role) |
| Reference data | admins via PostgREST + RLS (`admin_insert`/`admin_update`/`admin_delete` policies) |
| Approval configuration | admins via PostgREST; Phase B importer supports bulk load |
| Timesheets | submitter via PostgREST (status=draft/open) + SECURITY DEFINER RPCs for state transitions |
| Approval runs | SECURITY DEFINER RPCs only (approve, reject, reassign, override, recall) |
| Notifications | system only — trigger `notify_on_approval_action` on each `approval_actions` insert |
| Audit | every mutating RPC writes one row; Edge Functions write via `writeAudit()` helper |
