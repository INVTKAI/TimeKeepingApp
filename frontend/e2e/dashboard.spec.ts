import { test, expect } from "@playwright/test";

// Uses the admin storageState from auth.setup.ts.

test.describe("dashboard (signed-in)", () => {
  test("renders pending approvals section + stat tiles", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "My pending approvals" }),
    ).toBeVisible();
    // Stat tiles — at least the pending-approvals one must render.
    await expect(page.getByText("Pending approvals")).toBeVisible();
  });

  test("unknown URL renders NotFound with back-to-dashboard link", async ({ page }) => {
    await page.goto("/does-not-exist");
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Back to dashboard" }),
    ).toBeVisible();
  });

  test("sidebar navigates to /my-timesheets", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /my timesheets/i }).first().click();
    await expect(page).toHaveURL(/\/my-timesheets$/);
  });
});
