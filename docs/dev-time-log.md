# Dev time log

Tracks estimated vs actual hours per phase/task. Purpose: calibrate future estimates — historically 20-40% under.

Format per row: `phase | task | estimate | actual | start | end | notes`.

Always in local clock time (user's timezone). Round to nearest 5 min.

---

## 2026-04-23 — Admin UI rebuild (full legacy parity, left sidebar)

### Phase 0 — planning + handoff docs (not budgeted)

| Task | Est | Actual | Start | End | Notes |
|------|-----|--------|-------|-----|-------|
| Read legacy `app.js` nav + page structure | — | 10m | 10:30 | 10:40 | Enough to map legacy → new routes |
| Write `v1-admin-ui-plan.md` | — | 20m | 10:40 | 11:00 | Phase/route/data spec for future self |
| Write this dev-time-log + git commit | — | 10m | 11:00 | 11:10 | |

### Phase 1 — foundation (estimate 3 hrs)

| Task | Est | Actual | Start | End | Notes |
|------|-----|--------|-------|-----|-------|
| `AppShell` + sidebar component + role filtering | 45m | — | — | — | |
| Refactor existing routes to render inside shell | 30m | — | — | — | |
| Split `/timesheets` → `/my-timesheets` + `/field-timesheets` | 30m | — | — | — | |
| `/admin/employees` (read-only) | 20m | — | — | — | |
| `/admin/projects` (read-only + areas subtable) | 30m | — | — | — | |
| `/admin/codes` (read-only, 3 tabs) | 25m | — | — | — | |
| `/admin/timesheets` (read-only + basic filters) | 30m | — | — | — | |
| `/weekly-check` placeholder | 10m | — | — | — | |
| Typecheck + build + deploy + commit | 20m | — | — | — | |
| **Phase 1 total** | **3h 40m** | — | — | — | Revised from 3h after planning |

### Phase 2 — CRUD + Badges + Imports (estimate 4 hrs)

| Task | Est | Actual | Start | End | Notes |
|------|-----|--------|-------|-----|-------|
| Employees CRUD modals (add/edit/deactivate + sub-history) | 45m | — | — | — | |
| Projects CRUD + Areas nested | 45m | — | — | — | |
| Codes CRUD (all 3 + areas) | 45m | — | — | — | |
| `/admin/badges` (list + create + resolve + parent cascade) | 1h | — | — | — | |
| `/admin/imports` (file-upload UI driving EFs) | 1h | — | — | — | |
| Manage-timesheets filters | 30m | — | — | — | |
| Typecheck + build + deploy + commit | 20m | — | — | — | |
| **Phase 2 total** | **4h 45m** | — | — | — | |

### Phase 3 — polish (estimate 2 hrs)

| Task | Est | Actual | Start | End | Notes |
|------|-----|--------|-------|-----|-------|
| Mobile sidebar drawer | 30m | — | — | — | |
| Loading skeletons (list pages) | 20m | — | — | — | |
| Empty states / illustrations | 30m | — | — | — | |
| Keyboard shortcuts | 20m | — | — | — | |
| Dark mode toggle | 20m | — | — | — | |
| **Phase 3 total** | **2h** | — | — | — | |

---

## Velocity calibration

Post-phase, update a "calibration note" below with the observed multiplier (actual / estimated) and what made it skew. Carry this forward into next phase's estimates.

**Session-level observation so far** (from this session's earlier phases pre-planning):
- CLI deploy + config push + extensions setup: estimated "~10 min total" → actual ~2 hrs with 4-5 error-loops (Vault permission denied, placeholder swap, pg_cron OOM, CORS, GoTrue restart timing). **Multiplier ~12×.**
- Email flow diagnosis + Outlook quarantine dance: estimated 0 min → actual ~45 min. **Un-budgeted; add 20-30% for unknown-unknowns.**

Useful rules carried forward:
1. **Multiply estimates by 1.4-1.6 when touching prod infra** (Supabase gotchas).
2. **Add 15 min per new surface** for "user reported an issue, diagnose, fix, redeploy" loops.
3. **Pre-check GoTrue / extension versions** before planning anything config-push related.
