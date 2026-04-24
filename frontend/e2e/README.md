# Frontend e2e (Playwright)

Pre-deploy UAT smoke per [`docs/pre-deploy-uat-spec.md`](../../docs/pre-deploy-uat-spec.md) Layer 2.4.

## Install

```sh
cd frontend
npm install
npx playwright install --with-deps chromium
```

## Run

```sh
# Against prod Netlify (default)
npm run test:e2e

# Against local dev server (start it first: `npm run dev` in another terminal)
PLAYWRIGHT_BASE_URL=http://localhost:5173 npm run test:e2e

# Against a staging URL with different creds
PLAYWRIGHT_BASE_URL=https://staging.example.com \
  PW_ADMIN_EMAIL=admin@staging.example.com \
  PW_ADMIN_PASSWORD='...' \
  npm run test:e2e

# Interactive UI mode (great for debugging)
npm run test:e2e:ui
```

## What's covered

- **`auth.setup.ts`** — signs in once, caches session to `e2e/.auth/admin.json`
- **`sign-in.spec.ts`** — unauth: form renders, wrong creds show alert, guarded routes redirect
- **`dashboard.spec.ts`** — auth: dashboard renders, NotFound works, sidebar nav works
- **`admin-surfaces.spec.ts`** — auth: all 7 admin pages load without error banners or console errors

## What's NOT covered (yet)

Full mutation round-trips (submit → approve → export) need a second user + a clean tenant per run. The EF integration suite (`backend/tests-integration/`) already exercises these at the HTTP layer — keeping Playwright focused on UI-specific regressions.

Not covered from `docs/test-plan.md`:

- TC-A1/A2 invite round-trip — needs inbox access; see spec Layer 3.6
- TC-S2/S3/S4 timesheet mutations — possible to add once we decide between
  "smoke against seed data" (minimal) vs "seed a dedicated test tenant per
  run" (thorough but slow)
- TC-AP1..AP5 approvals — needs two-user choreography
- TC-T1/T3 theme + mobile drawer — candidate for snapshot tests

## Auth state

`e2e/.auth/admin.json` is created by the setup step and gitignored. If tests fail with "not signed in," delete it and re-run — the setup project will refresh it.
