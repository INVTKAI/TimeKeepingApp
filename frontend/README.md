# Invenio Timekeeping Frontend

React + Vite + TypeScript app built against the Supabase backend at [`../backend/`](../backend/). Supersedes the legacy [`../app.js`](../app.js) / [`../index.html`](../index.html) localStorage prototype (kept for reference only).

## Status

| Slice | State |
| --- | --- |
| Scaffold (Vite + Tailwind + React Router + React Query + InvenioStyle tokens) | ✅ |
| Auth flows (sign-in, invite-accept, password reset) | ✅ basic shell; polish TBD |
| Pending-approvals dashboard (read-only list) | ✅ wired via `my_pending_approvals` RPC |
| Approve / reject / reassign actions | ⏳ |
| Timesheet edit (staff + field) | ⏳ |
| Admin surfaces (users, flows, imports) | ⏳ |

## Start here

1. **Backend running.** `cd ../backend && supabase start` then `supabase db reset` applies all migrations. See [`../backend/README.md`](../backend/README.md).
2. **Copy env.** `cp .env.local.example .env.local` — both values are printed by `supabase status` in `../backend/`. Anon key is the long JWT starting `eyJ…`.
3. **Install.** `npm install`
4. **Dev server.** `npm run dev` then open http://localhost:5173. Dev server hits the local Supabase API at `http://127.0.0.1:54331`.

## Design tokens

Values mirror [TomEnglish/InvenioStyle](https://github.com/TomEnglish/InvenioStyle):

- Canonical TS copy: [`src/design/tokens.ts`](src/design/tokens.ts)
- Tailwind mirror: [`tailwind.config.ts`](tailwind.config.ts)

Tailwind can't import the runtime module at build time — if you add or rename a token in `tokens.ts`, make the matching edit in `tailwind.config.ts`.

Utility component classes are defined with `@apply` in [`src/index.css`](src/index.css): `invenio-btn-primary`, `invenio-btn-secondary`, `invenio-btn-danger`, `invenio-input`, `invenio-card`, `invenio-label`, `invenio-error`.

## Backend contract

The client talks to three backend surfaces (spec §8):

- **PostgREST tables** via `supabase.from(...)` — RLS gates tenant isolation.
- **RPCs** via `supabase.rpc(...)` — state-machine transitions (`submit_timesheet`, `approve_run`, `reject_run`, `recall_run`, `claim_field_timesheet`, `release_field_timesheet`, `reassign_run`, `override_run`, `resolve_badge_override`, `create_badge_override`, `finalize_self_activation`, `my_pending_approvals`, `project_readiness`). Errors use native PostgREST shape with `P0*` SQLSTATE codes — see [`src/lib/problem.ts`](src/lib/problem.ts).
- **Edge Functions** via `invokeEdgeFunction()` in [`src/lib/problem.ts`](src/lib/problem.ts) — admin ops: `invite-user`, `reset-password`, `revoke-user`, `restore-user`, `change-role`, `unlock-user`, `import-localstorage`, `import-spreadsheet`, `release-queued-invites`. Errors return RFC 7807 `application/problem+json`.

## Layout

```
frontend/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.{json,app.json,node.json}
├── tailwind.config.ts
├── postcss.config.js
├── .env.local.example
└── src/
    ├── main.tsx
    ├── App.tsx              # routing + providers (React Query, Auth)
    ├── index.css            # Tailwind + @apply utility classes
    ├── vite-env.d.ts
    ├── design/tokens.ts
    ├── lib/
    │   ├── supabase.ts      # client init from VITE_SUPABASE_* env
    │   └── problem.ts       # RFC 7807 helper + invokeEdgeFunction()
    ├── context/AuthContext.tsx
    └── routes/
        ├── RequireAuth.tsx
        ├── SignIn.tsx
        ├── AcceptInvite.tsx
        ├── ResetPassword.tsx
        └── Dashboard.tsx
```

## Known gaps tracked for v1 close-out

- Approve / reject / reassign flows on the dashboard.
- Timesheet editor (staff week-view + field day-view).
- Admin UI for flow templates, user management, import upload.
- Optimistic updates for approval actions (TanStack Query mutate + rollback on P0002 RUN_STATE_CHANGED).
- Dark-mode toggle wiring (`[data-theme="dark"]` class — tokens ready, not wired).
