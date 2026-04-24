import { test, expect } from "@playwright/test";

// Unauthenticated checks — skip the shared storage state so we start fresh.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("sign-in page", () => {
  test("renders form fields and submit button", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Forgot your password?" })).toBeVisible();
  });

  test("rejects wrong credentials with an error banner", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("nobody@example.invalid");
    await page.getByLabel("Password").fill("not-a-real-password-12345");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Supabase returns a generic "invalid credentials" per spec §4 (no
    // user-existence leak). Just assert an alert role appeared.
    await expect(page.getByRole("alert")).toBeVisible();
    // Still on /sign-in.
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("redirects authenticated user guard pages to /sign-in", async ({ page }) => {
    await page.goto("/my-timesheets");
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
