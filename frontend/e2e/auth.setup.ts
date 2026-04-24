import { test as setup, expect } from "@playwright/test";
import path from "node:path";

// Signs in once and caches the session so signed-in tests can reuse it
// via `storageState` in playwright.config.ts.
//
// Creds come from env, defaulting to the seeded admin from
// memory/project_frontend_plan.md. Override with:
//   PW_ADMIN_EMAIL=...  PW_ADMIN_PASSWORD=...
const adminEmail = process.env.PW_ADMIN_EMAIL ?? "t.elliott.english@gmail.com";
const adminPassword = process.env.PW_ADMIN_PASSWORD ?? "InvenioTest-2026!";

const authFile = path.join(__dirname, ".auth/admin.json");

setup("authenticate as admin", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Password").fill(adminPassword);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Dashboard is the post-login landing page.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.context().storageState({ path: authFile });
});
