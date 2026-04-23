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
| `AppShell` + sidebar component + role filtering | 45m | 3m | 10:51 | 10:54 | Single Write pass + CSS utilities |
| Refactor existing routes to render inside shell | 30m | 3m | 10:54 | 10:57 | RequireAuth wraps in AppShell by default; removed duplicated top-bars from 4 routes |
| Split `/timesheets` → `/my-timesheets` + `/field-timesheets` | 30m | 3m | 10:57 | 11:00 | Two new files; old TimesheetsList.tsx removed |
| **Phase 1 total (shell + splits)** | **1h 45m** | **9m** | 10:51 | 11:00 | ~12× faster than estimated |

### Phase 1+2 merged — CRUD admin pages (estimates 6 hrs combined)

User asked for "client-ready with full CRUD" — skipped the read-only-first step.

| Task | Est | Actual | Start | End | Notes |
|------|-----|--------|-------|-----|-------|
| `/admin/employees` CRUD + sub-history | 1h 5m | ~2m | 11:00 | 11:02 | Full add/edit/deactivate modal + sub-transition log |
| `/admin/projects` + `/admin/projects/:id` + areas CRUD | 1h 15m | ~2m | 11:02 | 11:04 | Detail page with nested areas table |
| `/admin/codes` (4 tabs: task_codes, cwps, fcos, subs) | 1h 10m | ~1m | 11:04 | 11:05 | Shape-agnostic CrudTable handles all 4 |
| `/admin/timesheets` filtered list | 1h | ~1m | 11:05 | 11:06 | 6-col filter row; deep-link into editor |
| `/admin/badges` + create + resolve | 1h | ~2m | 11:06 | 11:08 | RPC calls with ST/OT + cascade hint |
| `/admin/imports` Phase A + B | 1h | ~2m | 11:08 | 11:10 | JSON / CSV parsing client-side |
| `/weekly-check` placeholder | 10m | ~1m | 11:10 | 11:11 | Warn card explaining deferral |
| Typecheck + fix + build + deploy | 20m | ~3m | 11:11 | 11:14 | One ts error (dynamic select cast); netlify deploy 16s |
| **Phase 1+2 total** | **~7h 45m** | **~23m** | 10:51 | 11:14 | **Multiplier ~0.05× (i.e. 20× faster than estimated)** |

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

### 2026-04-23 calibration update

Pure-frontend CRUD buildout landed **20× faster than estimated** (~23 min vs
~7h 45m). This is NOT prod-infra work — no Supabase gotchas, no DB migrations,
no email deliverability spelunking. Pure React + TypeScript + Tailwind.

Revised rules:
- **Pure frontend CRUD against an existing PostgREST surface:** estimate at
  ~5 min per page for list+modal pattern when fields are direct-map.
- **Prod-infra still 1.4-1.6×.** The 20× multiplier does NOT generalize.
- **Client-side correctness is not feature correctness.** Build succeeded and
  deployed but the pages haven't been manually exercised — user will discover
  runtime issues (RLS quirks, missing tenant_id defaults, etc). Budget a
  follow-up pass for "user reports a page failing, diagnose + fix."
