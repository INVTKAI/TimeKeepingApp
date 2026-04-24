import { test, expect } from "@playwright/test";

// Smoke test that the admin CRUD pages mount and fetch reference data without
// error. These are load-only checks — no mutations. Signed in as admin via
// the shared storageState.
//
// Pages covered here mirror test-plan.md §7 (TC-AD1..TC-AD5, TC-AD8).

const pages = [
  { path: "/admin/users", heading: /users|tenant users/i },
  { path: "/admin/employees", heading: /employees/i },
  { path: "/admin/projects", heading: /projects/i },
  { path: "/admin/codes", heading: /codes/i },
  { path: "/admin/timesheets", heading: /timesheets/i },
  { path: "/admin/flows", heading: /flows/i },
  { path: "/exports", heading: /labor|exports/i },
];

for (const p of pages) {
  test(`${p.path} loads without error banner`, async ({ page }) => {
    // Capture console errors so we fail the test on app-level crashes.
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(p.path);
    await expect(page.getByRole("heading", { name: p.heading }).first()).toBeVisible();

    // No "Failed to load" style banners visible.
    const failureBanner = page.getByText(/failed to load|not authorized/i);
    await expect(failureBanner).toHaveCount(0);

    // Page-crash errors (not network warnings) shouldn't appear.
    const hardErrors = consoleErrors.filter(
      (e) => !/favicon|devtools|chunk/i.test(e),
    );
    expect(hardErrors, hardErrors.join("\n")).toEqual([]);
  });
}
