# Invenio Timekeeping — Client-Demo Test Plan

**Version:** 0.4.1 · **Last updated:** 2026-04-23
**URL:** https://invenio-timekeeping.netlify.app

A practical walkthrough for validating the app end-to-end before a client demo.
Designed to be worked through linearly, but sections are independent — skip
ones that don't apply to your testing round.

---

## 1. Before you start

### 1.1 Getting an account

You need an invite from an admin.

- **Admin:** Elliott (`t.elliott.english@gmail.com`) invites you from
  `/admin/users`. You'll receive an email from `noreply@revfire.us`.
- **Outlook / Office 365 recipients:** emails are quarantined by default.
  Check https://security.microsoft.com → Quarantine, release the message,
  and add `revfire.us` to your Tenant Allow List.
- **Gmail / Google Workspace recipients:** delivery is clean; sometimes
  lands in Promotions tab.
- **Expected experience:** click email link → set a password (≥ 12
  characters, letters + digits) → land on dashboard.

### 1.2 Browser + platform matrix

| Platform | Expected | Report bug if |
|----------|----------|---------------|
| Chrome (macOS/Windows) | Primary target | Any visual or functional issue |
| Safari (macOS) | Primary target | Any visual or functional issue |
| Firefox | Supported | Major functional regressions |
| Mobile Safari (iPhone) | Hamburger menu + usable | Content overflows, drawer won't open |
| Mobile Chrome (Android) | Hamburger menu + usable | Same as above |

### 1.3 How to report bugs

For each issue found, capture:

1. **Page URL** (copy the full URL from the address bar)
2. **What you did** (click path)
3. **What you expected**
4. **What actually happened** (include any error banner text)
5. **Browser + OS** (e.g. "Chrome 141 on macOS 26.3")
6. **Screenshot** if visual

Use whichever channel your team uses (Slack, email, issue tracker, shared doc).
Batch them — a single report with 5 findings is more actionable than 5 pings.

### 1.4 What's already seeded

The test tenant has been pre-loaded with demo data:

- 3 subcontractors: Invenio (INV), Acme Mechanical (ACME), Buckeye Electric (BUCK)
- 3 projects: P-1001 (Refinery Unit 40), P-1024 (LNG Module Assembly), P-1108 (Pipeline Station 7)
- 12 employees across the three subs
- 8 task codes, 4 CWPs, 3 FCOs
- 2 approval flows (1-node "Standard approval", 2-node "PM then Accounting")
- 6 timesheets in mixed states (draft, approved, rejected, open, claimed)

Your testing can and should add more — the seed is just to give you something
to click on first.

---

## 2. Smoke tests (5 minutes)

Quick sanity pass. If any of these fail, stop and report before continuing.

| # | Step | Expected |
|---|------|----------|
| S1 | Navigate to the URL | `/sign-in` loads, Invenio lockup visible |
| S2 | Sign in | Dashboard loads; your username + role visible in sidebar |
| S3 | Click every sidebar item | Each page loads without an error banner |
| S4 | Click Moon/Sun icon in sidebar bottom | Colors flip; reload — preference persists |
| S5 | Resize window narrow (< 768px) | Sidebar collapses; hamburger appears at top |
| S6 | Tap hamburger on mobile | Drawer slides in; tap overlay closes |
| S7 | Sign out | Returns to `/sign-in` |

---

## 3. Authentication + user lifecycle

> Requires: admin account to invite from.

### TC-A1: Invite a new user

- [ ] As admin, go to `/admin/users`
- [ ] Click **Invite user**
- [ ] Fill in username + a **real email you control** + role `submitter`
- [ ] Click **Send invite**
- [ ] **Expected:** banner "Invited <username>", row appears with status `pending`
- [ ] Email arrives within ~1 min

### TC-A2: Accept the invite

- [ ] In a **different browser / incognito window**, click the email link
- [ ] Set a password (≥ 12 chars, letters + digits)
- [ ] **Expected:** land on the dashboard, sidebar shows submitter role
- [ ] Back in admin — row status flips to `active`

### TC-A3: Forgot password

- [ ] Sign out
- [ ] On `/sign-in`, click **Forgot your password?**
- [ ] Enter your email → Send reset link
- [ ] Click reset email → set a new password
- [ ] Sign in with the new password

### TC-A4: Revoke / restore / unlock

- [ ] As admin, click **Revoke** on a test user
- [ ] **Expected:** status → `revoked`; that user's sessions are invalidated
- [ ] Click **Restore** → status → `active`
- [ ] **Unlock** clears any lockout counter after failed password attempts

---

## 4. Staff timesheets (single user)

> Requires: your user to be linked to an employee (admin does this via SQL; the
> seeded admin is already linked to E001).

### TC-S1: Start a new week

- [ ] Go to `/my-timesheets`
- [ ] Click **New staff week…**
- [ ] Pick a week, a project, and a sub → Create
- [ ] **Expected:** land in the staff editor (Mon–Sun grid)

### TC-S2: Enter + save hours

- [ ] In the first row: pick area / task code / CWP from dropdowns
- [ ] Enter `8` ST on Mon, `8` ST on Tue, `8` ST + `2` OT on Wed
- [ ] Add a comment on the Wed cell
- [ ] Click **Save draft**
- [ ] **Expected:** "Draft saved" banner; reload page — data persists

### TC-S3: Submit

- [ ] With unsaved changes, click **Submit** → should warn or save first
- [ ] After save, click **Submit**
- [ ] **Expected:** status → `submitted`; grid is read-only; **Recall** button visible
- [ ] Go to `/` — dashboard shows the submission in pending approvals (if you're an approver)

### TC-S4: Recall

- [ ] On a submitted timesheet, click **Recall**
- [ ] **Expected:** status → `draft`; grid becomes editable again

### TC-S5: Handle concurrent-update error

- [ ] Submit a timesheet
- [ ] Open it in a second tab
- [ ] Approve it in one tab → try to recall from the other
- [ ] **Expected:** info banner "run moved while you were reviewing — refreshing"

---

## 5. Field timesheets (single user)

### TC-F1: Admin creates field shells

- [ ] As admin, `/admin/timesheets` → **+ Field shells**
- [ ] Pick project + sub, start date = today, end date = today + 2
- [ ] Click Create
- [ ] **Expected:** 3 open shells listed; go to `/field-timesheets` — visible in Open section

### TC-F2: Claim a field shell

- [ ] As a user with a submitter_assignment on that project/sub, go to `/field-timesheets`
- [ ] Click **Claim** on an open row
- [ ] **Expected:** lands in the field editor; status flips to `draft`; shows under "Claimed by me"

### TC-F3: Enter crew hours

- [ ] In the context header, pick area / task / CWP
- [ ] Crew rows filter to employees on the claimed sub — add hours for 2-3 employees
- [ ] Save draft
- [ ] **Expected:** row persists on reload

### TC-F4: Release

- [ ] Click **Release**
- [ ] **Expected:** returns to list; the shell is back in Open

### TC-F5: Submit + approve round-trip

- [ ] Claim a shell → enter hours → Submit
- [ ] As the approver, go to `/` dashboard → see the pending row → **Approve**
- [ ] **Expected:** timesheet status → `approved`; appears in `/exports` reports

---

## 6. Approvals (requires 2+ users)

> Set up: create a two-node approval flow, attach it to a project, submit a
> timesheet on that project with one user, approve it with another.

### TC-AP1: Build a flow template

- [ ] As admin, `/admin/flows` → **+ New flow** → name "Test two-step"
- [ ] Add Node 1 "PM" with user approver (user A)
- [ ] Add Node 2 "Accounting" with user approver (user B)
- [ ] **Expected:** saves; flow shows 2 nodes

### TC-AP2: Attach flow to project

- [ ] This currently requires SQL (Phase B import / dashboard). Verify by
      picking a project seeded with a flow: P-1024 → "PM then Accounting"

### TC-AP3: First-node approval

- [ ] User A submits a timesheet on the attached project
- [ ] User A sees it as submitted; dashboard shows 0 pending for them
- [ ] User B (node-1 approver) sees it in dashboard pending list
- [ ] **Approve** as user B
- [ ] **Expected:** run advances to node 2

### TC-AP4: Reject

- [ ] Resubmit → user B rejects with comment "missing task code"
- [ ] **Expected:** timesheet → `rejected`; original submitter can see the comment

### TC-AP5: Reassign (admin only)

- [ ] Admin sees a pending row → **Reassign…** → pick a different user + reason
- [ ] **Expected:** reassigned user now sees the row; original user doesn't

### TC-AP6: Admin override

- [ ] `/admin/timesheets` → open a submitted one → admin-override buttons
      (path: currently not exposed in UI — deferred to v1.1)

---

## 7. Admin CRUD pages

### TC-AD1: Employees

- [ ] `/admin/employees` — 12 seeded rows
- [ ] Search "Riv" → narrows to Alex Rivera
- [ ] **Include inactive** toggle — default off, flip to show inactives
- [ ] **+ Add employee** → fill fields → Save → appears in list
- [ ] Edit a row → change craft → Save → updates
- [ ] Change subcontractor on an edit → **Expected:** warning appears; on save, sub-history entry is created (check via `/admin/employees` → edit → expand Sub-history)
- [ ] **Deactivate** → row disappears (with Include-inactive off); **Reactivate** reverses it

### TC-AD2: Projects + areas

- [ ] `/admin/projects` — 3 seeded rows with area counts
- [ ] **+ Add project** → create → appears
- [ ] Click into project → detail page
- [ ] Edit name/number (blur to save) → persists
- [ ] **+ Add area** → appears in subtable; edit; delete
- [ ] **Deactivate** project → chip flips; **Reactivate** reverses

### TC-AD3: Codes & Areas

- [ ] `/admin/codes` — 4 tabs
- [ ] Task Codes: Add, edit, delete
- [ ] CWPs: same
- [ ] FCOs: same
- [ ] Subcontractors: has `active` checkbox in edit modal

### TC-AD4: Badge overrides

> Requires: Weekly Check or manual creation first.

- [ ] `/admin/badges` — list with status filter
- [ ] **+ New override** → pick employee + date + project + sub + ST/OT fields → Create
- [ ] Click **Resolve** on an open override → pick canonical side + reason → Resolve
- [ ] **Expected:** chip flips to "submitted canonical" or "badge canonical"

### TC-AD5: Manage Timesheets

- [ ] `/admin/timesheets` — tenant-wide list
- [ ] Filter combinations: kind=staff, status=approved, project, sub, date range
- [ ] Click Open → lands in the correct editor

### TC-AD6: Imports

> Phase A imports will **overwrite** seed data. Test in a fresh tenant.

- [ ] `/admin/imports` loads
- [ ] File picker accepts .json / .csv
- [ ] Phase B: pick "Subcontractors" type → paste JSON → Run → result panel shows create/update/skip counts

### TC-AD7: Tenant settings

- [ ] `/admin/settings` — admin-only; read-only view
- [ ] Verify tenant name, slug, timezone, email_from_address are populated
- [ ] Webhook URL shows "not configured" if unset

### TC-AD8: Labor Report

- [ ] `/exports` — pick last 30 days
- [ ] **Download CSV** → file lands with headers
- [ ] **Download XLSX** → opens in Excel with two sheets (Lines + Summary by Project)

---

## 8. Weekly Check reconciliation

### TC-WC1: Paste + reconcile

- [ ] `/weekly-check` — pick this week
- [ ] Paste a CSV with a couple of mismatching rows:
  ```
  external_id,date,st,ot
  E005,<yesterday>,8,0
  E006,<yesterday>,10,2
  ```
- [ ] Click **Parse**
- [ ] **Expected:** stat tiles show counts; mismatched row has "Create override" button

### TC-WC2: One-click override creation

- [ ] Click **Create override** on a mismatched row
- [ ] **Expected:** info banner "Override created"
- [ ] Go to `/admin/badges` — row appears in open overrides with matching hours

### TC-WC3: Upload CSV

- [ ] Same as TC-WC1 but via the file picker
- [ ] **Expected:** textarea shows the file's contents; parsing runs the same way

---

## 9. Theme + responsive

### TC-T1: Dark mode

- [ ] Click Moon icon → all pages should flip palette
- [ ] Check: cards, inputs, buttons, table headers, chips — no "light island" stuck in dark
- [ ] Reload → stays dark
- [ ] Sign out + in → stays dark

### TC-T2: OS preference

- [ ] Sign out. In browser devtools, toggle `prefers-color-scheme: dark`
- [ ] Reload sign-in page
- [ ] **Expected:** sign-in card respects OS preference

### TC-T3: Mobile drawer

- [ ] On phone OR browser narrowed < 768px
- [ ] Hamburger button top-left
- [ ] Tap → drawer slides in from left with overlay
- [ ] Tap overlay → drawer closes
- [ ] Tap a nav link → navigates + drawer auto-closes

---

## 10. Error handling

### TC-E1: Unknown URL

- [ ] Type `/nonexistent` in the address bar
- [ ] **Expected:** NotFound page with "Back to dashboard" + "My timesheets" links

### TC-E2: Permission denied

- [ ] As a **submitter**, type `/admin/employees` in the address bar
- [ ] **Expected:** "Not authorized" message explaining the required role

### TC-E3: Stale session

- [ ] Leave a page open for a long time (> 1 hour of inactivity)
- [ ] Try to mutate something
- [ ] **Expected:** redirected to sign-in (because Supabase session refresh eventually fails); sign in again → returned to where you were

### TC-E4: Concurrent approval

- [ ] Two admins have the same pending approval open
- [ ] Admin A approves → Admin B tries to approve or reject
- [ ] **Expected:** info banner "run moved while you were reviewing"; list refreshes

---

## 11. Known limitations (v1)

These are **not bugs** — they're deferred to v1.1+. Don't report them:

- **Weekly Check** — reconciliation uses a pasted CSV, not live badge data.
  The `badge_records` table is parked pending customer data-shape decision.
- **Admin override** on approval runs — backend RPC (`override_run`) exists
  but no UI button. Use Reassign + re-approve for now.
- **Drag-reorder** on approval flow nodes — up/down arrows only in v1.
- **Project-flow attachment UI** — must be done via SQL or the Phase B
  import right now. The flow list shows what's attached but doesn't let
  you change it.
- **Email to Outlook recipients** — quarantined by Microsoft reputation.
  Workaround: recipient adds `revfire.us` to their tenant allow-list at
  security.microsoft.com.
- **Mobile timesheet editors** — grids work on mobile but are cramped.
  Best on tablet or desktop.
- **Loading skeletons** — most pages show plain "Loading…" text instead
  of the animated skeleton cards.

---

## 12. Test session reporting template

Copy-paste this at the end of a testing session:

```
## Session: <your name> · <date>

Env: <Chrome 141 / Safari 18 / etc.> on <macOS / Windows / iOS / Android>

Tests completed:
- [x] Section 2 smoke
- [x] Section 3 auth
- [x] Section 4 staff timesheets
- [ ] Section 5 field timesheets (blocked: TC-F2, see below)
- [ ] Section 6 approvals (needs second tester)
- [x] Section 7 admin CRUD
- [x] Section 8 weekly check
- [x] Section 9 theme + responsive
- [x] Section 10 error handling

Bugs found:
1. <TC ref> <one-line description>
   <browser/os> · <steps>
   Expected: …
   Actual: …

Overall: <ready to demo / blocking / needs more testing>
```

---

## 13. Appendix: demo-day cheat sheet

When showing the app to a client, a tight 10-minute flow:

1. **Sign in** (show the lockup + the stat tiles loading)
2. **Dashboard** — "Here's what needs your attention today"
3. **New staff week** → show the grid → Submit (demonstrate the save path)
4. **Switch to admin view** — show pending row appear → Approve
5. **Admin → Manage Timesheets** — show filters across status/project/sub
6. **Admin → Employees** — show how rosters are managed
7. **Admin → Approval Flows** — show the flow editor (sell the flexibility)
8. **Weekly Check** — paste CSV, show one-click override creation
9. **Labor Report** — export CSV, open in Excel
10. **Sidebar** — click dark mode toggle as a flourish; resize window to show mobile drawer

Skip if short on time: Imports, Tenant Settings, Badge Overrides resolution
flow. Come back to them if the client asks.
