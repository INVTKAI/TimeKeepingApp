# Pre-deploy UAT spec

**Version:** 0.1 · **Last updated:** 2026-04-24

Scope: verification work that happens **between "dev-complete on main" and "client gets the URL."**
Covers what's automatable, what needs human eyes, and the gaps against today's state.

Companion to:

- [backend-test-plan.md](backend-test-plan.md) — P0/P1/P2 behavioral checklist (what the system must do)
- [test-plan.md](test-plan.md) — client-demo manual walkthrough (TC-* test cases, 452 lines)
- [v1-launch-checklist.md](v1-launch-checklist.md) — customer cutover go/no-go list
- [ops/service-role-rotation-runbook.md](ops/service-role-rotation-runbook.md)
- [ops/backup-restore-runbook.md](ops/backup-restore-runbook.md)

This doc is the layer above those — the testing pyramid from commit → client hand-off.

---

## Layering overview

```
┌────────────────────────────────────────────────────────────────┐
│ Layer 5 — Internal manual UAT (test-plan.md walkthrough)       │
├────────────────────────────────────────────────────────────────┤
│ Layer 4 — Client-data readiness (per-client, not per-deploy)   │
├────────────────────────────────────────────────────────────────┤
│ Layer 3 — Prod-env verification (post-deploy, pre-client)      │
├────────────────────────────────────────────────────────────────┤
│ Layer 2 — Pre-deploy smoke (staging / local)                   │
├────────────────────────────────────────────────────────────────┤
│ Layer 1 — Automated gates (every PR / every main commit)       │
└────────────────────────────────────────────────────────────────┘
```

Each layer assumes the ones below it are green.

Status key: ✅ landed · 🟡 in flight · ⏳ not started · 🚫 can't automate

---

## Layer 1 — Automated gates (per commit)

Must be green before a PR merges. These already exist individually; they need CI wiring.

| # | Gate | Tool | Status |
|---|------|------|--------|
| 1.1 | DB invariants | pgTAP — 241 assertions across 13 files in [`backend/supabase/tests/`](../backend/supabase/tests) | ✅ runs via `scripts/run-checks.sh` |
| 1.2 | Service-role key discipline | [`scripts/lint-service-role-usage.sh`](../backend/scripts/lint-service-role-usage.sh) — §11.6 P0 gate | ✅ |
| 1.3 | Frontend build | `tsc -b && vite build` in `frontend/` | ✅ |
| 1.4 | EF TypeScript check | `deno check` per function | ✅ (one documented benign TS2307 on edge-runtime.d.ts) |
| 1.5 | Edge Function contracts | 44 Deno integration tests across 10 EFs in [`backend/tests-integration/`](../backend/tests-integration) | ✅ runs via `scripts/run-ef-tests.sh`; requires Docker + functions-serve |
| 1.6 | **CI orchestration** | GH Actions wiring #1.1–1.5 into PR / push workflows | ⏳ **Gap — no CI today** |

**Action for 1.6:** write `.github/workflows/checks.yml`:

- PR trigger: pgTAP + lint + tsc + vite build (~2 min)
- Push-to-`main` trigger: EF integration tests (~10 min, needs Docker)
- Enforce branch protection requiring the PR workflow

---

## Layer 2 — Pre-deploy smoke (staging / local)

Run against `supabase start` + a staging tenant before pushing migrations to prod.

| # | Check | Automatable? | Status |
|---|-------|--------------|--------|
| 2.1 | Fresh DB reset applies all migrations cleanly | Yes (`supabase db reset && supabase test db`) | ✅ works locally; not scripted as a pre-deploy gate |
| 2.2 | End-to-end: seed tenant → invite → submit → approve → drain → email delivered | Yes | ✅ [`end-to-end.test.ts`](../backend/tests-integration/end-to-end.test.ts) |
| 2.3 | Multi-session concurrency (P0002 race — two approvers, exactly one wins) | Yes | ✅ [`concurrency.test.ts`](../backend/tests-integration/concurrency.test.ts) |
| 2.4 | **Frontend happy-path E2E (Playwright)** | Yes | ⏳ **Gap — launch-checklist #12** |
| 2.5 | Visual regression on core screens | Yes (Playwright snapshot) | ⏳ not started |

**Action for 2.4 — Playwright minimum viable scope:**

1. `sign-in → dashboard renders → pending approvals list loads`
2. `create staff timesheet week → enter hours → save → submit → status=submitted`
3. `invite user flow: admin invites → email link → accept-invite PKCE exchange → finalize_self_activation → land on dashboard`
4. `admin approves pending run → status advances → labor export contains the line (CSV)`
5. `reject with comment → submitter sees rejection + comment on recalled timesheet`
6. (cheap add) permission denied: `submitter hits /admin/employees → "not authorized"` — closes TC-E2
7. (cheap add) unknown URL: `/nonexistent → NotFound page` — closes TC-E1

Runs against a dedicated test tenant on local or staging Supabase. ~30 min initial setup per the launch checklist.

---

## Layer 3 — Prod-env verification (post-deploy, pre-client)

After pushing migrations + EFs to the prod Supabase project, before sending the client the URL. Ideally one script; most of the pieces exist in isolation.

| # | Check | Automatable? | Status |
|---|-------|--------------|--------|
| 3.1 | Migrations match local via `supabase migration list --linked` | Yes | ✅ used at Batch 6 cutover, not scripted |
| 3.2 | Go-live gate SQL passes for target tenant (8 gates, §9.10) | Yes | ✅ [`backend/scripts/go-live-gate.{sql,sh}`](../backend/scripts) |
| 3.3 | `custom_access_token_hook` is enabled | Yes — any RPC call should return non-P0005 | ✅ verified at setup; add to smoke |
| 3.4 | pg_cron schedules firing | Yes — query `cron.job_run_details` for recent successes | ⏳ not scripted |
| 3.5 | EF secrets set (`NOTIFICATION_DRAIN_SECRET`, `RESEND_API_KEY`) | Yes — drain EF with correct secret → 200; wrong → 403 | ✅ smoke-tested per launch checklist #2e, not scripted |
| 3.6 | SMTP delivers invite to a real Gmail inbox | Semi — send is automatable; inbox polling needs IMAP creds or Mailpit | 🟡 partial |
| 3.7 | Supabase Auth redirect URLs include prod + dev | Yes — assert from `config.toml` / Management API | ⏳ not scripted |
| 3.8 | Cross-tenant RLS isolation at HTTP layer (not just pgTAP) | Yes — two anon JWTs, two tenants, assert zero leakage | ⏳ not scripted |
| 3.9 | Service-role key rotation runbook rehearsed | 🚫 destructive — human-driven | ✅ runbook exists, never executed |
| 3.10 | Backup/restore runbook rehearsed against scratch project | 🚫 destructive + costs money — human-driven | ✅ runbook exists, never executed |

**Action:** write `scripts/prod-smoke.sh` that chains 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8 with a `--tenant=<uuid>` arg. Run it as the final gate before sending the client the URL.

**Outlook caveat for 3.6:** documented expected behavior — `revfire.us` emails quarantine at Microsoft; recipients must allow-list at security.microsoft.com. Don't treat quarantine as a deploy failure.

---

## Layer 4 — Client-data readiness

Per-client, not per-deploy. Can't be automated without the client's data in hand; the EFs already return structured error lists so triage is fast.

| # | Check | Status |
|---|-------|--------|
| 4.1 | Phase A dry-run against real `tk_*` dump — dangling refs = 0 | ⏳ per-client (launch-checklist #5) |
| 4.2 | Phase B dry-runs for all 7 spreadsheets — dangling refs = 0 | ⏳ per-client (launch-checklist #6a–6g) |
| 4.3 | Approval flow templates authored for every active project | ⏳ per-client (launch-checklist #7) |
| 4.4 | Go-live gate re-run **against the client's tenant_id** right before invite release | ⏳ per-client (launch-checklist #8) |
| 4.5 | `release-queued-invites --dry_run` preview matches expected cutover list | ⏳ per-client |

All of these rely on the import EFs' dangling-refs response. If the response isn't empty, triage with the client before invite release.

---

## Layer 5 — Internal manual UAT

[test-plan.md](test-plan.md) sections 2–10, walked by one of your team against a seeded test tenant before any external eyes touch it. No automation candidate — this is the last chance to catch UX issues Playwright can't see.

**Minimum pass before client demo:**

- §2 smoke (5 min)
- §3 auth + user lifecycle (TC-A1 through TC-A4)
- §4 staff timesheets (TC-S1 through TC-S5)
- §6 approvals (TC-AP1, TC-AP3, TC-AP4)
- §7 admin CRUD spot-check on Employees + Projects + Flows
- §9 theme + responsive (TC-T1, TC-T3)
- §10 error handling (TC-E2, TC-E4)

**Skip in the pre-deploy pass:**

- TC-E3 (stale session, >1 hr)
- TC-AP6 (admin override UI — deferred to v1.1)
- TC-AD6 imports (destructive — use a throwaway tenant)

---

## Gap summary — what to close before the next client cutover

Ordered by risk/effort ratio:

1. **CI workflow** wiring `run-checks.sh` into PRs (~30 min, high leverage — stops regressions from here on)
2. **`prod-smoke.sh`** chaining the Layer 3 non-destructive checks (~1 hr — single command for the pre-client gate)
3. **Playwright happy-path suite** (~2 hr — closes launch-checklist #12, replaces the most fragile parts of manual UAT)
4. **Monitoring queries** wired to an alert target (launch-checklist #15) — not a test, but without it the post-deploy window is blind
5. **Rehearse** the destructive runbooks (service-role rotation, backup/restore) at least once against prod — runbooks are untested paper until executed

---

## Ownership matrix — what Claude can do vs. what needs a human

| Work item | Claude autonomously | With human help | Human-only |
|---|---|---|---|
| CI workflow (Layer 1.6) | ✅ | | |
| Playwright suite (Layer 2.4) | ✅ (runs against local stack) | Pointing at staging with credentials | |
| Prod-smoke script (Layer 3.1–3.8) | ✅ (non-destructive) | | |
| Monitoring queries (launch #15) | ✅ (writes SQL) | Alert-target choice + webhook wiring | |
| Email inbox verification (3.6) | | IMAP creds for a testing inbox | |
| Supabase Dashboard toggles | | | Must be a human with Dashboard access |
| Service-role rotation rehearsal (3.9) | | Narrate from runbook | Press the button |
| Backup/restore rehearsal (3.10) | | Narrate from runbook | Press the button |
| Manual UAT walk (Layer 5) | | | Visual judgment, device matrix |
| Client-data dry-runs (Layer 4) | | | Requires client's data |
| Product decisions (e.g. admin-override UI for v1.1) | | | |
