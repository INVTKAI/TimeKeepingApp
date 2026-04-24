import { defineConfig, devices } from "@playwright/test";

// Pre-deploy UAT smoke — see docs/pre-deploy-uat-spec.md Layer 2.4.
//
// Tests run against whatever URL you hand them via PLAYWRIGHT_BASE_URL.
// Defaults to the prod Netlify build since that's the common "did the last
// deploy break sign-in?" check. For local development, set:
//   PLAYWRIGHT_BASE_URL=http://localhost:5173
// (assumes `npm run dev` is running in another terminal; no webServer
// block here because we don't want to auto-kill a dev server you rely on.)
//
// Credentials default to the known seeded admin (see memory
// project_frontend_plan.md). Override via env for other tenants.

const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ??
  "https://invenio-timekeeping.netlify.app";

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

  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/admin.json",
      },
      dependencies: ["setup"],
    },
  ],
});
