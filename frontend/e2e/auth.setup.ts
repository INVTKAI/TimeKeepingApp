import { test as setup, expect } from "@playwright/test";

// Signs in once and caches the session so signed-in tests can reuse it
// via `storageState` in playwright.config.ts.
//
// Creds come from env, defaulting to the seeded admin from
// memory/project_frontend_plan.md. Override with:
//   PW_ADMIN_EMAIL=...  PW_ADMIN_PASSWORD=...
//
// If PW_ADMIN_PASSWORD isn't set we skip — without creds there's nothing to
// do and we don't want to red the suite when auth secrets aren't configured.

// Path is relative to the project root (where Playwright runs from).
// Matches the storageState path in playwright.config.ts.
const authFile = "e2e/.auth/admin.json";

setup("authenticate as admin", async ({ page }) => {
  setup.skip(
    !process.env.PW_ADMIN_PASSWORD,
    "PW_ADMIN_PASSWORD not set; skipping signed-in test setup",
  );

  const adminEmail =
    process.env.PW_ADMIN_EMAIL || "t.elliott.english@gmail.com";
  const adminPassword = process.env.PW_ADMIN_PASSWORD as string;

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Password").fill(adminPassword);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Race the success path against an error banner so a bad-creds CI failure
  // shows the actual message instead of a 10s URL timeout.
  await Promise.race([
    page.waitForURL(/\/$/, { timeout: 10_000 }),
    page
      .getByRole("alert")
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(async () => {
        const msg = (await page.getByRole("alert").textContent()) ?? "(no text)";
        throw new Error(
          `Sign-in rejected for ${adminEmail}: ${msg.trim()} ` +
            "(check PW_ADMIN_EMAIL / PW_ADMIN_PASSWORD secrets)",
        );
      }),
  ]);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.context().storageState({ path: authFile });
});
