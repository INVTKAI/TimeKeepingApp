# v1 Admin UI Rebuild Plan — full legacy-surface + left sidebar

Living plan. Status updates land here; new Claude sessions can pick up mid-stream by reading this + memory.

**Started:** 2026-04-23 10:30  
**Owner:** Claude  
**Context:** user wants legacy `app.js` feature parity applied in the InvenioStyle, with a left-sidebar nav (product owner preference). All backend tables/RPCs/EFs already exist — this is frontend-only.

## Legacy → new route mapping

Pulled from `app.js` lines 140-178 (source of truth for the legacy nav).

| Legacy view          | Role visibility           | New route                    | Status  | Notes |
| -------------------- | ------------------------- | ---------------------------- | ------- | ----- |
| Dashboard            | everyone                  | `/`                          | ✅ done | Pending-approvals list + approve/reject/reassign actions. |
| My Timesheet         | staff + admin             | `/my-timesheets`             | ✅ done | Split from `/timesheets`; personal staff weeks only. |
| Field Timesheets     | timekeeper + admin        | `/field-timesheets`          | ✅ done | Claimed + open-to-claim crew day-sheets. |
| Weekly Check         | timekeeper + admin        | `/weekly-check`              | ✅ placeholder | Placeholder page shipped — defers badge_records reconciliation to v1.1. |
| Manage Timesheets    | admin                     | `/admin/timesheets`          | ✅ done | Tenant-wide list with kind/status/project/sub/date filters. |
| Employees            | admin                     | `/admin/employees`           | ✅ done | List + add/edit/deactivate + sub-history on sub change. |
| Projects             | admin                     | `/admin/projects` + `/admin/projects/:id` | ✅ done | List + detail page with areas subtable CRUD. |
| Codes & Areas        | admin                     | `/admin/codes`               | ✅ done | 4 tabs: Task Codes / CWPs / FCOs / Subcontractors; all CRUD. |
| Badge System         | admin                     | `/admin/badges`              | ✅ done | List + create override + resolve with ST/OT split + cascade hint. Renamed to "Badge Overrides". |
| Labor Report         | admin                     | `/exports`                   | ✅ done | Date range + CSV/XLSX download. |
| —                    | admin                     | `/admin/users`               | ✅ done | Moved from `/users`; back-compat redirect in place. |
| —                    | admin                     | `/admin/flows`               | ✅ done | Flow templates + node editor. |
| —                    | admin                     | `/admin/imports`             | ✅ done | Phase A blob import + Phase B spreadsheet import (JSON/CSV). |

## Sidebar spec

```
┌─ Invenio Timekeeping ─┐
│ <username> · <role>   │
├───────────────────────┤
│ Dashboard             │  all
│                       │
│ — Staff —             │  (header if submitter has employee_id)
│ My Timesheet          │  submitter+emp, admin
│                       │
│ — Field —             │  (header if user has submitter_assignments OR admin)
│ Field Timesheets      │  submitter+asgmts, admin
│ Weekly Check          │  submitter+asgmts, admin  (placeholder in v1)
│                       │
│ — Admin —             │  (admin only)
│ Manage Timesheets     │
│ Employees             │
│ Projects              │
│ Codes & Areas         │
│ Badge Overrides       │
│ Approval Flows        │  (existing /admin/flows)
│ Users                 │  (existing /admin/users)
│ Imports               │  Phase 2
│                       │
│ — Reports —           │  (admin only)
│ Labor Report          │  (existing /exports)
│                       │
│ (bottom)              │
│ Sign out              │
└───────────────────────┘
```

Implementation: `AppShell` component with `<aside>` + `<main>` layout; each route renders inside `<main>`. Mobile: aside collapses to off-canvas drawer behind a hamburger button (Phase 3).

## Data surface per new page

### `/admin/employees`

- Table: name, external_id, craft, type (staff/field), current sub (short_code), active, created
- Search by name
- Add: first_name, last_name, type, craft, active, subcontractor_id (required NOT NULL — pick from sub list)
- Edit: same fields + ability to trigger a sub change → inserts `employee_subcontractor_history` row (closes open span, adds new)
- Deactivate: flip `active = false` (no deletion to preserve FK references)

RPCs/tables: `employees` (PostgREST, admin INSERT/UPDATE/DELETE RLS), `employee_subcontractor_history` (append-only)

### `/admin/projects`

- Table: number, name, active, created, count of (areas | active subs)
- Click into a project → per-project detail page with Areas subtable
- Add / edit / deactivate

Tables: `projects`, `areas`, `project_subcontractors`

### `/admin/codes`

Tabs:
- Task Codes — code, name — CRUD
- CWPs — code, description — CRUD
- FCOs — code, description — CRUD

Tables: `task_codes`, `cwps`, `fcos`

### `/admin/badges`

- List: open badge overrides + recently resolved
- Filter by project, sub, date range
- Each row: employee, date, declared hours, canonical hours (if set), status, reason
- Actions: Resolve (as `resolved_submitted_canonical` or `resolved_badge_canonical`) — triggers parent-run cascade per spec §7.7
- Create: admin can create a retroactive override (spec §7.7)

RPCs: `create_badge_override`, `resolve_badge_override`. Table: `badge_overrides`.

### `/admin/timesheets`

- Tenant-wide list of all timesheets
- Filters: kind (staff | field), status (any of the 7 enum values), project, sub, period_start date range
- Columns: kind, status chip, submitter, project, sub, period, created_at
- Click → opens existing Staff / Field editor in read-mostly mode (admin can force-save)
- "Create new field shell" link → existing `/timesheets/field/new` (rewire from current nav)

Query: `supabase.from('timesheets').select(...)` — admin RLS policy allows tenant-wide.

### `/my-timesheets`

- Current `/timesheets` list page, scoped to "my staff weeks" + "my field timesheets (claimed)" sections only
- "New staff week" modal stays
- Drop the "Open field timesheets — available to claim" section (move to /field-timesheets)

### `/field-timesheets`

- Two sections:
  - Claimed by me (status=draft, submitter_user_id=me)
  - Open in my silos (status=open, matches submitter_assignments)
- "+ Field shells" admin button (current `/timesheets/field/new`)

### `/weekly-check` — **placeholder for v1**

Page renders:
- Header: "Weekly Reconciliation Check"
- Week-picker selector (purely decorative)
- Info panel explaining: "Badge-records reconciliation is deferred until customer data-shape is confirmed. See spec §10 known-gaps. Badge overrides can be managed at /admin/badges."

Rationale: the legacy Weekly Check compared `DB.getBadgeRecords()` vs entered timesheet hours. We don't have a `badge_records` table (§10 parked). Building a functional Weekly Check requires that schema decision first.

## Phase breakdown

### Phase 1 — foundation + visible parity (estimate: 3 hrs; actuals in dev-time-log.md)

1. `AppShell.tsx` + sidebar component with role-based filtering
2. Refactor routing — every protected route renders inside shell
3. Move existing `/timesheets` → `/my-timesheets` + `/field-timesheets` (split)
4. Move existing `/admin/flows` label, `/admin/users` nav items into sidebar
5. Build read-only list pages for:
   - `/admin/employees`
   - `/admin/projects` (with inline areas)
   - `/admin/codes` (tabbed)
   - `/admin/timesheets`
6. Build `/weekly-check` placeholder
7. Keep existing `/admin/flows`, `/admin/users`, `/exports` — just wire into sidebar

Exit criteria: user can see every legacy section, role-appropriate, data rendered from prod PostgREST. No CRUD forms yet.

### Phase 2 — CRUD + Badges + Imports (estimate: 4 hrs)

1. Add/edit/deactivate modals for all 4 admin list pages
2. `/admin/badges` — list + Resolve + Create flows
3. `/admin/imports` — file upload UI for `import-localstorage` + `import-spreadsheet`
4. Manage-timesheets filters (status, project, sub, date)
5. Optional: admin force-save on any timesheet

Exit criteria: customer-facing functional parity with legacy demo (minus Weekly Check's reconciliation + badge_records dependency).

### Phase 3 — polish (estimate: 2 hrs)

1. Mobile responsive sidebar (off-canvas drawer, hamburger)
2. Loading skeletons across all list pages
3. Empty-state illustrations where appropriate
4. Keyboard shortcuts (/ for search, g d for dashboard, etc.)
5. Dark mode toggle (tokens ready, just needs a switch)

## Tokens + components — stay in InvenioStyle

- Colors: `canvas`, `surface`, `raised`, `border`, `brand`, `success/warn/danger` — all defined in `tailwind.config.ts` + `src/design/tokens.ts`
- Utility classes already built: `invenio-btn-primary|secondary|danger`, `invenio-input`, `invenio-card`, `invenio-label`, `invenio-error`
- New: `invenio-sidebar-item`, `invenio-sidebar-section` — add to `src/index.css`
- Icons: `lucide-react` (3 KB tree-shaken) — add to dependencies in Phase 1

## Estimates vs reality

**Note to future self:** past estimates in this project have been 20-40% under. Track actuals in `docs/dev-time-log.md`; adjust future session plans based on observed velocity.

## Status as of 2026-04-23 11:15

**Phase 1 + 2 merged and shipped** in ~25 minutes of wall-clock time (vs 7h 45m
estimate) — this is the pure-frontend CRUD scaffolding against an already-live
PostgREST surface. See `docs/dev-time-log.md` for the multiplier callout.

Deployed to `https://invenio-timekeeping.netlify.app`. Build green; no manual
testing performed in-session — expect a follow-up "X page broke because Y" loop.

**What's in the bag:**
- `AppShell` with left sidebar, role-gated sections, lucide icons
- `RequireAuth` now wraps children in AppShell by default (`bare` prop opts out)
- Every admin CRUD page uses PostgREST directly (RLS handles auth) — admin
  Edge Functions are still the path for user lifecycle + imports + exports
- Badge overrides call `create_badge_override` / `resolve_badge_override` RPCs
- Imports accept JSON or CSV client-side, POST to the existing EFs

**What's NOT in this pass (future work):**
- Phase 3 polish: mobile drawer, loading skeletons, empty-state art, keyboard
  shortcuts, dark-mode toggle
- Drag-reorder on approval flow nodes (currently up/down buttons)
- Weekly Check real reconciliation (blocked on `badge_records` schema)
- Playwright smoke tests (#12 on v1 checklist)

## Pre-compaction state — 2026-04-23 10:30

- Prod infra: fully wired (migrations, hooks, cron, SMTP, templates, CORS)
- Frontend deployed: invenio-timekeeping.netlify.app
- Admin user bootstrapped + signed in (`t.elliott.english@gmail.com`, password `InvenioTest-2026!`)
- Invite flow tested ✅
- Email deliverability: Gmail works; Outlook quarantines silently (add `revfire.us` to allow-list on recipient side)
- Backend: 241 pgTAP + 45 EF integration tests passing
- Drain cron: firing every minute, `status='succeeded'`
- Test tenant id: `0993e1df-a501-42be-a365-c6b9d5133900` (named "Invenio Test")

## Decisions made that must survive compaction

1. **Left sidebar, not top nav** — product owner preference
2. **Weekly Check deferred** — depends on `badge_records` schema customer decision
3. **Badge System renamed to Badge Overrides** — matches what backend actually exposes
4. **Separate `/my-timesheets` from `/field-timesheets`** — matches legacy grouping (Staff vs Field sections)
5. **Keep `/admin/flows` and `/admin/users`** — new v0.4 surfaces, not in legacy, but still needed
6. **Import dashboards become `/admin/imports`** — Phase 2 (#14 on launch checklist)
7. **Dev time log at `docs/dev-time-log.md`** — tracks actual vs estimate
