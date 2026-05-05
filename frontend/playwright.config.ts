import { defineConfig, devices } from "@playwright/test";

// Pre-deploy UAT smoke — see docs/pre-deploy-uat-spec.md Layer 2.4.
//
// Three modes:
//   1. CI                  — auto-starts `npm run preview` on :4173 against
//                            the freshly built dist/, runs against that
//   2. PLAYWRIGHT_BASE_URL — explicit override (staging, prod, local dev)
//   3. default (local)     — prod Netlify URL; user manages their own server
//
// Credentials default to the seeded admin (see memory project_frontend_plan).

const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ??
  (process.env.CI
    ? "http://localhost:4173"
    : "https://invenio-timekeeping.netlify.app");

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,  // Shared auth storage state; serial avoids flakiness.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  // In CI, auto-start the preview server (built-in Playwright lifecycle —
  // boots before tests, kills after). Locally, the user manages their own
  // dev/preview server and we don't touch it.
  webServer: process.env.CI
    ? {
        command: "npm run preview",
        url: "http://localhost:4173",
        timeout: 60_000,
        reuseExistingServer: false,
        stdout: "pipe",
      }
    : undefined,

  projects: [
    // Unauthenticated tests (sign-in form, invite-flow error states) — no
    // dependency on creds, runs even when admin secrets aren't configured.
    {
      name: "unauth",
      testMatch: /(sign-in|invite-flow)\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: { cookies: [], origins: [] },
      },
    },
    // Auth-required projects only included when PW_ADMIN_PASSWORD is set.
    // Without it, setup would fail and red the whole suite — and there's no
    // recovery from a missing creds value, so we exclude these projects
    // entirely rather than skipping individual tests.
    ...(process.env.PW_ADMIN_PASSWORD
      ? [
          {
            name: "setup",
            testMatch: /.*\.setup\.ts/,
            use: { ...devices["Desktop Chrome"] },
          },
          {
            name: "chromium-auth",
            testMatch: /(dashboard|admin-surfaces)\.spec\.ts/,
            use: {
              ...devices["Desktop Chrome"],
              storageState: "e2e/.auth/admin.json",
            },
            dependencies: ["setup"],
          },
        ]
      : []),
  ],
});
