import { test, expect } from "@playwright/test";

// Regression guard for the PKCE-on-email-links bug fixed 2026-04-24.
// ---------------------------------------------------------------------------
// Before the fix: flowType:"pkce" stored a code_verifier in localStorage when
// resetPasswordForEmail was called, and exchangeCodeForSession on the accept
// page required that verifier to be present. Consequences:
//   * Admin-generated invites NEVER worked — the recipient didn't initiate
//     the flow, so no verifier existed → "Auth session missing" on password set.
//   * Cross-browser resets didn't work — the email was clicked on a different
//     device than the one that requested the reset → "PKCE code verifier not
//     found in storage."
//
// After the fix (flowType:"implicit"): Supabase puts access_token in the URL
// fragment; detectSessionInUrl installs it on page load; no cross-browser
// requirement.
//
// These tests run WITHOUT the shared admin auth fixture — fresh context, no
// localStorage (storage cleared by the `unauth` project in
// playwright.config.ts). That's exactly the state a new-invite recipient is in.

test.describe("accept-invite (fresh browser)", () => {
  test("bare /accept-invite with no token renders error, not crash", async ({ page }) => {
    // Capture console errors to catch a PKCE-storage-access exception on mount.
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/accept-invite");

    // Should settle into the error card within the 2.5s timeout the
    // component sets, NOT render the password form and NOT crash the page.
    // Heading copy varies by detected action type ("Reset link problem" for
    // recovery, otherwise "Email link problem"); we accept either.
    await expect(
      page.getByRole("heading", { name: /(email|reset|invite) link problem/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Password form should NOT be rendered.
    await expect(page.getByLabel("New password")).toHaveCount(0);

    // No React render-crash or unhandled promise errors.
    const hardErrors = consoleErrors.filter(
      (e) => !/favicon|devtools|chunk|404|failed to fetch/i.test(e),
    );
    expect(hardErrors, hardErrors.join("\n")).toEqual([]);
  });

  test("/accept-invite with error fragment surfaces the Supabase error message", async ({
    page,
  }) => {
    // Simulate Supabase redirecting to /accept-invite#error=access_denied&error_description=...
    // for an expired invite (legacy /verify-endpoint flow).
    await page.goto(
      "/accept-invite#error=access_denied&error_description=Email+link+is+invalid+or+has+expired",
    );

    await expect(
      page.getByRole("heading", { name: /(email|invite) link problem/i }),
    ).toBeVisible();
    await expect(page.getByText(/email link is invalid or has expired/i)).toBeVisible();

    // URL fragment should be stripped so the error doesn't survive reload / copy-paste.
    await expect(page).not.toHaveURL(/#error=/);
  });

  test("/accept-invite?token_hash=...&type=recovery with bad hash surfaces verifyOtp error", async ({
    page,
  }) => {
    // The post-2026-05-05 Outlook-resistant flow: emails link to
    // /accept-invite?token_hash=X&type=recovery; AcceptInvite calls
    // supabase.auth.verifyOtp({token_hash, type}). A bogus hash should
    // produce a clear error (and "Reset link problem" copy for recovery).
    await page.goto(
      "/accept-invite?token_hash=not-a-real-hash-just-for-the-error-path&type=recovery",
    );

    await expect(
      page.getByRole("heading", { name: /reset link problem/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Token hash should be stripped from URL on error.
    await expect(page).not.toHaveURL(/token_hash=/);
  });
});
