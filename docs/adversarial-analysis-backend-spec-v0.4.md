# Adversarial Analysis: Backend Specification v0.4

**Target:** [backend-spec.md](backend-spec.md) v0.4.0 (Supabase pivot)
**Review date:** 2026-04-21
**Prior review:** [adversarial-analysis-backend-spec.md](adversarial-analysis-backend-spec.md) (v0.1–v0.3)
**Reviewer role:** Senior backend engineer / security-conscious solution architect who has shipped multi-tenant Supabase applications and knows where the seams are.

---

## The Strongest Case Against

The pivot is pitched as "same behavior, managed platform, less code." The document does succeed at compressing §4's bespoke auth lifecycle, §8's hand-rolled CRUD, and §11.1's custom stack into configuration + small surface areas of glue. But two structural properties of the v0.3 design — *uniform enforcement* and *immediate revocability* — are quietly traded for platform ergonomics, and the spec treats these as free wins. Service-role bypass now lives in ~10 separate Edge Functions, each gated by an imperative `if (app_role !== 'admin')` rather than a declarative policy; a single missing check is a full-tenant privilege escalation. JWT access tokens expire on a 1-hour clock regardless of whether a session has been revoked — a concession the v0.3 design explicitly rejected, now recast as "spec-level semantics preserved" without acknowledging the 1-hour staleness window. The RFC 7807 error-shape commitment in §8/§11.2 can't actually be satisfied by PostgREST auto-generated endpoints without wrapping every custom RPC in an Edge Function — work the spec treats as a "thin mapping layer" that doesn't exist. And the platform's own fragile spots — custom access-token hook failures, pg_cron tier dependency, auth.users trigger coupling — are not enumerated. The v0.4 spec is shorter than v0.3, but it is shorter partly because it has handed concerns to Supabase without documenting what Supabase hands back.

## Where the Argument Is Strong

The pivot's core diagnosis is correct: Supabase Auth subsumes §4 cleanly, PostgREST subsumes CRUD at §8, and plpgsql RPCs are the right home for the approval state machine's transactional core (§7.3/§7.4). The explicit enumeration of accepted deviations (§4.1 bcrypt, §4.2 JWT, §4.1/§4.7/§10 deferred features) is disciplined — hand-waving a spec downgrade as "same semantics" is the usual failure mode and this document avoids it. The `notification_outbox` + pg_cron pattern (§7.6 implementation note) is the right way to keep the RPC transactions fast while delivering side effects reliably. Salvaging the v0.3 init migration SQL and naming it explicitly (Revision Log "Salvaged artifacts") prevents the common pivot failure of losing schema work to a rewrite.

## What the Pivot Resolves from v0.3

Findings closed by the v0.4 architecture:

- **v0.3 HSI-#3 (any-of node concurrency)**: cleaner. plpgsql RPCs wrap version-check + action-insert + run UPDATE in one implicit transaction. Idempotency-key retained (though degraded in ergonomics — see MSI-#8 below).
- **v0.3 MSI-#7 (password_version check overhead)**: obsolete. JWT validation is local signature check; no DB join per request.
- **v0.3 MSI-#13 (username reuse after revoke)**: schema-level fix unchanged by pivot (partial-unique index still applies to `public.users`).

Findings unchanged by the pivot (still live; §9 still misframes greenfield as migration; subs/silos/approvers still need customer discovery; default-flow-vs-ops-blocking still a deliberate strictness choice):

- v0.3 HSI-#1, HSI-#2, HSI-#4, HSI-#6 — the customer-discovery questions are orthogonal to the stack choice.

## Logical Vulnerabilities

### 1. Service-role bypass posture is systemically weaker than v0.3 (Severity: **High**)

**What the text says:** §3 "Service-role bypass is reserved for controlled admin-path Edge Functions." §8 "Each [admin Edge] function authenticates the caller via JWT, verifies `app_role='admin'`, then uses Supabase's service-role SDK to perform admin operations."

**Why it's vulnerable:** "Controlled" is undefined; the check is imperative code inside each function. v0.4 has ~10 admin Edge Functions (invite, reset, revoke, restore, change-role, import-localstorage, import-spreadsheet, release-queued-invites, export-labor, provision-tenant). Every one of them is a `check_role_in_TS → service_role_query` sequence. A forgotten check in a single Edge Function = any authenticated submitter gets service-role (bypass-RLS) privileges on that code path for every tenant in the project. Compare to v0.3, where RBAC was a single Fastify middleware applied at route registration — one correct check gated every admin write. The v0.4 architecture converts a uniform declarative control into N imperative controls at N review surfaces.

**What would strengthen it:** Specify a mandatory wrapper function `withAdminContext(handler)` that every admin Edge Function MUST extend; the wrapper verifies JWT → extracts `tenant_id` + `app_role` → rejects non-admin callers → only then passes the service-role client to the inner handler. Name the pattern and make "Edge Function does not extend `withAdminContext`" a lint/CI gate. A second-best option: after the service-role write completes, re-execute a `SET LOCAL app.caller_tenant_id` + a probe query to assert the write didn't cross tenants. Either is fine; the current "controlled" is not a specification.

### 2. JWT access token 1h TTL silently degrades revocation (Severity: **High**)

**What the text says:** §4.2: "Access token TTL: 1h (Supabase default). Refresh token TTL: configurable per project. … Admin revoke user — `auth.admin.updateUserById(user_id, { banned_until: 'infinity' })` + `auth.admin.signOut(user_id, 'global')`." Revision Log: "Revocation via `auth.admin.signOut`; spec-level semantics preserved."

**Why it's vulnerable:** `signOut` revokes refresh tokens; it does **not** invalidate already-minted access tokens. A revoked user's access token remains valid for up to 59 minutes after revocation. v0.3's opaque-DB-backed session design revoked on the next request — immediate. The v0.4 claim "spec-level semantics preserved" is not preserved at any granularity under 1h. For a construction payroll system, a compromised foreman's token is a 1-hour fraud window: they can resubmit edited rows, approve silos where they're an approver, and trigger payroll-affecting state transitions. The spec does not acknowledge this window at all.

**What would strengthen it:** Pick one: (a) Reduce Supabase's access-token TTL (configurable as low as 60s at the project level — pays a refresh-call tax, earns immediate revocation); (b) add a `revoked_users` denylist table, check it in the authorization step of every state-mutating RPC (cheap on a keyed lookup); (c) document the 1h residual window explicitly as an accepted deviation from v0.3, with a mitigation plan for sensitive operations. The silent-gloss current stance is the worst option.

### 3. Custom access-token hook is an undocumented single point of failure (Severity: **High**)

**What the text says:** §3 and §4.2 both anchor tenancy on the custom access-token hook that reads `public.users.tenant_id` and injects it as a JWT claim. No failure-mode discussion.

**Why it's vulnerable:** Three failure modes, none addressed:

- **Hook errors at token mint** → Supabase fails the sign-in / refresh. Depending on configuration this is either total-tenant-lockout or silent sign-in failure. Either is bad; neither is named.
- **Hook returns partial claims** (e.g., `tenant_id` present but `app_role` missing due to a mid-migration state) → RLS policies that check `app_role` return empty — **indistinguishable from a legitimate RLS filter hit**. Debugging this is nearly impossible without hook-level instrumentation, which the spec doesn't require.
- **auth.users row exists but public.users doesn't** (migration race, or a sign-up-via-recovery-link edge case) → hook returns a JWT with null `tenant_id`, RLS evaluates `tenant_id = NULL` as false for every row, user sees an empty system, indistinguishable from "new tenant, nothing provisioned." Quiet failure.

v0.3's tenancy mechanism (`current_setting('app.tenant_id')` GUC) failed loudly: query error if GUC unset. v0.4 fails silently.

**What would strengthen it:** Add §4.8 or a subsection to §3: "Tenancy hook failure modes and mitigations." Specify: (a) every tenant-scoped RPC MUST raise `TENANT_CLAIM_MISSING` (403) when `auth.jwt() ->> 'tenant_id'` is null — not just return empty; (b) the hook is deployed behind a Supabase-feature-flag ramp with a kill-switch to a no-op hook that rejects logins rather than minting claimless tokens; (c) an `auth.users`-to-`public.users` existence trigger that raises if a user authenticates without a matching `public.users` row.

### 4. RFC 7807 commitment is incompatible with PostgREST native errors (Severity: **High**)

**What the text says:** §8: "**Custom RPCs and Edge Functions** return **RFC 7807 Problem Details**. plpgsql RPCs raise custom error codes via `RAISE`; **a thin PostgREST error-mapping layer** (or the Edge Function wrapping the call) reshapes the raised error into the Problem Details body." §11.2: "PostgREST auto-generated endpoints return PostgREST's native error format. **Clients branch on `content-type` to distinguish.**"

**Why it's vulnerable:** There is no "PostgREST error-mapping layer" — PostgREST returns its own envelope (`{code, details, hint, message}`) and offers no hook to rewrite the body. Transforming a plpgsql `RAISE EXCEPTION` into RFC 7807 requires wrapping *every* RPC call in an Edge Function that catches the PostgREST response and reshapes it — which the spec briefly suggests as the alternative ("or the Edge Function wrapping the call"). Taken seriously, this means the RPC endpoint count doubles: for each `POST /rest/v1/rpc/approve_run` there's a `POST /functions/v1/approve_run` wrapper; the naked RPC becomes internal-only. The §11.1 stack table lists "plpgsql RPCs exposed as PostgREST endpoints" as a first-class surface, but the error-shape requirement pushes everyone through Edge Functions after all. The "clients branch on content-type" fallback in §11.2 ships the inconsistency downstream to every client.

**What would strengthen it:** Pick one: (a) **Drop RFC 7807 for PostgREST-native endpoints** (tables + RPCs); apply it only to Edge-Function-fronted operations. Document both error shapes; clients handle both. (b) **Wrap every RPC in a thin Edge Function** and admit the doubled function count in §8 and the complexity in §11. Do not leave the spec in its current state — it implies uniformity that the platform does not provide.

### 5. Per-account login lockout is not "low-value" in the modern threat model (Severity: **High**)

**What the text says:** §10: "**Per-account login lockout** (lock after N failures in M minutes, admin-unlockable). Supabase Auth has global per-IP rate limiting but not per-account lockout. … Park unless the customer insists." §4.7: "**Rate limiting** — Supabase Auth applies a global per-IP rate limit on `signInWithPassword` (configurable)."

**Why it's vulnerable:** Credential stuffing — the 2020s-and-on dominant account-takeover attack — sources requests from tens of thousands of distributed IPs specifically to defeat per-IP rate limits. Global per-IP limits catch unsophisticated single-source brute force; they do not meaningfully defend against credential-stuffing against known-leaked-password corpora. The v0.3 design chose per-account lockout deliberately, knowing this. The v0.4 relegation to "park unless customer insists" names the change as a trivial scope trim when it is in fact a real reduction in the account-takeover defense posture. For a system where a compromised foreman account moves payroll dollars, this is not a "park it" decision.

**What would strengthen it:** Either (a) reinstate per-account lockout as a v1 requirement via a custom `pre-login` hook (Supabase supports this) consulting `auth.audit_log_entries` for recent failures per email — real work, maybe 0.5d; or (b) name the accepted threat explicitly: "accepted risk: no per-account lockout; a credential-stuffing attack using leaked credentials will succeed against any account whose password has been leaked externally. Mitigations: password policy entropy, mandatory rotation every N days, optional 2FA in v2." The current framing understates the trade.

### 6. Service-role key rotation is not specified operationally (Severity: **Medium**)

**What the text says:** §11.1: "Secrets — Supabase Edge Function secrets (`supabase secrets set`) for Function env." §3: "Service-role keys live only in Edge Function secrets — never exposed to clients."

**Why it's vulnerable:** v0.3 had one place the service-role-equivalent (DB admin credential) lived; rotation was a single secret update. v0.4 has service-role keys in every admin Edge Function's env (10+ Functions). Rotation requires updating each Function's secret and redeploying. No runbook. No mention of what happens mid-rotation (some Functions on old key, some on new). For a credential that IS the tenant-isolation boundary, key rotation is not incidental.

**What would strengthen it:** Add §11.6 or a subsection to §11.1: "Service-role key rotation procedure." Specify: (a) the canonical way to set once and reference from all Functions (Supabase project-level secrets vs per-Function secrets); (b) the rotation runbook (stop writes, rotate, verify, resume — or overlap both keys during transition if Supabase supports dual active keys); (c) the trigger cadence (annually, post-incident, post-personnel-change).

### 7. auth.users → public.users first-login trigger is fragile (Severity: **Medium**)

**What the text says:** §6.1: "On first login (invite acceptance or recovery), a database trigger on `auth.users` updates `public.users.status` from `pending` to `active`. Implemented as `AFTER UPDATE OF last_sign_in_at ON auth.users` with a `SECURITY DEFINER` trigger function."

**Why it's vulnerable:** `auth.users` is a Supabase-owned schema; the trigger coupling to `last_sign_in_at` depends on Supabase's internal update pattern remaining stable. Supabase has revised auth schemas multiple times in the past 24 months (e.g., `banned_until` semantics, the introduction of `auth.identities`). A future update that writes `last_sign_in_at` in a batch, via a different path, or in a multi-step transaction could silently break the status-transition pipeline; pending users would never reach `active`; downstream RLS policies that filter on `status='active'` would start rejecting legitimate users. Nothing in the test plan exercises this specific Supabase-internal coupling.

**What would strengthen it:** Either (a) move the status transition into the custom access-token hook (the hook runs on every token issue / refresh, gives us visibility, is the supported extension point); or (b) keep the trigger but add a test in the test plan that verifies the transition under Supabase version upgrades; or (c) replace with an explicit "mark active" step in the Edge Function that wraps accept-invite, not inferred from Supabase internals. The current choice sits on an undocumented Supabase contract.

### 8. Idempotency-key as body parameter is a real ergonomic degradation (Severity: **Medium**)

**What the text says:** §8 Approvals: "`idempotency_key` is a body parameter (rather than a header) because PostgREST RPCs don't give the function direct access to custom request headers."

**Why it's vulnerable:** HTTP retry middleware (axios-retry, fetch-retry, browser fetch with Retry-After) handles `Idempotency-Key` **header** automatically — the header is preserved on retries without client-side code. A body parameter requires every client to persist the key across retries manually. That mismatch bites during the exact failure mode idempotency is designed for: transient network errors mid-retry. It also makes the convention less discoverable — the parameter is mixed into the RPC body schema rather than the standardized header slot. The spec frames this as a platform constraint ("PostgREST RPCs don't give the function direct access to custom request headers"), but if we've chosen to wrap RPCs in Edge Functions per finding 4, the wrappers CAN read the header and forward it.

**What would strengthen it:** Resolve in concert with finding 4. If RPCs are wrapped in Edge Functions (option 4a), the wrapper reads `Idempotency-Key` header and passes it to the RPC as the body param. Clients see a standard header; the platform constraint is hidden. If RPCs are called directly (option 4b), the body-param convention stands, but the spec should add a client-side helper recommendation.

### 9. Email globally unique in auth.users blocks cross-tenant consultant pattern (Severity: **Medium**)

**What the text says:** §2 non-goals: "Cross-tenant user membership." §6.1: `public.users.UNIQUE(tenant_id, email)` — our own uniqueness is still per-tenant. Implicit: `auth.users.email` is globally unique (Supabase's schema).

**Why it's vulnerable:** The v0.3 design explicitly scoped email uniqueness per tenant, allowing the common "consultant who works for multiple customer organizations, each with their own tenant" pattern. Supabase's `auth.users.email` is globally unique, so one consultant email = one `auth.users` row = one tenant at a time. The v0.4 spec doesn't acknowledge this change. For a construction prime that onboards a consultant who also works for another Invenio customer (not uncommon — specialist QA, safety consultants, owner-reps), the consultant cannot have a login in both tenants.

**What would strengthen it:** Either (a) document the limitation explicitly in §2: "v1 requires one email per `auth.users` row; consultants working across multiple tenants must use tenant-qualified addresses (jane+acme@consultant.com) or separate logins per tenant"; or (b) plan a v2 multi-tenant identity layer (Supabase's organizational identity is in preview at time of writing). Silent behavioral change from v0.3 is the failure mode.

### 10. Password history + per-account lockout drop is a compliance delta (Severity: **Medium**)

**What the text says:** §10: password history and per-account lockout both parked as "unless customer insists."

**Why it's vulnerable:** Customers subject to SOX, HIPAA, ISO 27001, NIST 800-53, or audit frameworks that import NIST (construction companies bidding on federal / utility contracts often import NIST 800-53 low/moderate) may have password-history enforcement and account lockout as **audit-mandated** controls. A "customer asks before we build" stance works for greenfield customers without a compliance program; it does not work for enterprise customers whose compliance officer reviews the RFP response before sign-off. The spec does not enumerate the customer's compliance posture, which should have been a pre-pivot question.

**What would strengthen it:** Add §10a "Compliance posture" with a yes/no matrix for the customer: SOX? HIPAA? ISO 27001? NIST 800-53? → if any yes, password history + lockout + audit log retention become v1 requirements, not v2 parks. Resolve before implementation begins; the cost of adding these later is higher than adding now.

### 11. Bulk import rate-limited by Supabase Auth API (Severity: **Medium**)

**What the text says:** §9 Phase A: "User records imported via `auth.admin.createUser({ email, email_confirm: false })`."

**Why it's vulnerable:** Supabase's Admin API has per-project hourly rate limits (GoTrue rate limit: 30-150 req/min depending on endpoint / tier). A 200-user migration is 200 sequential createUser calls; a 1000-user migration exceeds the hour budget on lower tiers. The spec's idempotency claim ("idempotent per tenant") doesn't help if the import script trips the rate limiter partway through and the partial state is opaque to the operator. No batching, no backoff, no resume-from-offset specified.

**What would strengthen it:** Add to Phase A: "The import-localstorage Edge Function processes user creation in chunks of 25 with 1s backoff; exposes a progress endpoint; persists per-user import state (`pending | created | errored`) so reruns skip succeeded rows. Admin is advised to coordinate with Supabase support for large imports (>500 users) to request rate-limit elevation."

### 12. plpgsql testing framework not named (Severity: **Medium**)

**What the text says:** §11.5: "Integration tests hit the Supabase local stack. plpgsql RPC tests assert the transactional contract… Vitest… Edge Function tests run under Deno."

**Why it's vulnerable:** The RPC tests described are integration tests (Vitest → HTTP → PostgREST → plpgsql). Fine-grained plpgsql testing — asserting that specific branches of the state machine execute, that error cases RAISE the correct SQLSTATE, that version-check concurrency holds — is materially easier inside Postgres with a framework like **pgTAP**. The spec doesn't name it or its alternative. The test plan will consequently undertest the RPC logic (only via HTTP, missing fine-grained unit coverage), or the team will improvise and produce inconsistent coverage.

**What would strengthen it:** Add to §11.5: "plpgsql unit tests use pgTAP; Edge Function unit tests use Deno's built-in test runner; integration tests use Vitest against the local Supabase stack. Coverage targets split by layer: plpgsql (branch coverage of state machine), Edge Functions (HTTP contract), integration (end-to-end flows)."

### 13. pg_cron availability is a Supabase tier constraint, not specified (Severity: **Medium**)

**What the text says:** §7.6 / §11.1 depend on pg_cron for notification outbox drain, stall detection, idempotency-key cleanup, invite release. No mention of tier requirements.

**Why it's vulnerable:** pg_cron is a Postgres extension that Supabase enables at Pro tier and above. Free tier lacks it. If the customer's initial deployment targets Free (common for evaluation / pilot), *all* of §7.6 notification behavior, stall detection, and idempotency cleanup silently fails — nothing ever runs. Customer thinks the system doesn't notify; engineer debugs for half a day before realizing pg_cron isn't enabled.

**What would strengthen it:** State Supabase tier in §11.1: "Minimum tier: Pro (required for pg_cron and higher rate limits). Self-hosted Supabase is also supported (pg_cron available by default)." Add a readiness check in the provisioning runbook: "verify pg_cron enabled before first tenant onboards."

### 14. notification_outbox and idempotency_keys tables referenced but not defined (Severity: **Low**)

**What the text says:** §11.4 index strategy lists indexes on `notification_outbox(status, scheduled_for) WHERE status='pending'` and `idempotency_keys(actor_user_id, key) PK`. §7.6 references the outbox. §8 references `idempotency_keys` behavior.

**Why it's vulnerable:** Neither table is defined in §6 (core domain model) or as a dedicated subsection. The index entries gesture at shape (status column, scheduled_for, actor_user_id, key, created_at) but the full schema, retry policy, column semantics, and pruning cadence are unspecified. Implementation will improvise.

**What would strengthen it:** Add §6.7 "Infrastructure tables" defining `notification_outbox(id, tenant_id, event_type, recipients_jsonb, status, attempts, scheduled_for, sent_at, last_error, created_at)` and `idempotency_keys(actor_user_id, key, response_body jsonb, created_at)`, including the retry policy (3 attempts with exponential backoff: 1m, 5m, 25m) and pruning cadence (pg_cron hourly, TTL 24h for idempotency, 30d for outbox).

### 15. Email templates are Supabase-project-global, not per-tenant (Severity: **Low**)

**What the text says:** §3: `tenants.email_from_address`. §7.6: "per-tenant from-address; subject format `[TK] {event}: {project} / {sub} — {period}`."

**Why it's vulnerable:** For **domain notifications** (approval events, sent via Resend from Edge Functions), per-tenant from-address is trivially supported. For **auth-flow emails** (invite, password-reset, email-change), Supabase Auth uses the project's one configured from-address and one set of templates. Multi-tenant branding on auth emails requires per-tenant custom SMTP — Supabase supports custom SMTP at project level (not per-tenant), or enterprise-tier per-tenant SMTP (additional cost). The spec implies per-tenant branding applies uniformly; it does not.

**What would strengthen it:** Split §7.6 notification types: "Auth-flow emails use the Supabase project's configured from-address and templates (not per-tenant in v1 except at enterprise tier). Domain notifications use per-tenant `email_from_address` via Resend." One paragraph; prevents a customer surprise at go-live.

## Evidence Gaps

1. **bcrypt cost factor is not specified.** Supabase default is 10; OWASP recommends 12 for 2023+. Silent reliance on defaults.
2. **Supabase tier is not specified.** Free vs Pro vs Enterprise dictates pg_cron, rate limits, per-tenant SMTP, and other features the spec leans on.
3. **Custom access-token hook failure behavior is not specified.** Supabase documents hook errors result in signin failure, but the spec doesn't name this or mitigate.
4. **Edge Function cold-start latency is not measured.** Supabase Edge Functions have cold starts; domain notifications on new silos or first-of-day submissions pay the cost. Not benchmarked.
5. **Service-role key rotation cadence is not stated.** Annually? Post-incident only? Post-personnel-change? Implicit is "never," which is wrong.
6. **Supabase feature-stability is not hedged.** Custom access token hooks were GA in 2024 but Supabase has revised auth hooks several times; spec doesn't plan for hook API migrations.

## Assumptions Worth Surfacing

1. **Assumption: the Supabase custom access token hook contract is stable over the v1 horizon.** Revisions in Supabase's hook API would require spec + code changes.
2. **Assumption: pg_cron + `pg_net` are sufficient for the notification outbox throughput at target tenant scale.** Not benchmarked. A tenant with 200 approvals/day generating 5 notifications each = 1000 outbox rows/day, manageable; a tenant with 10,000 approvals/day may saturate pg_net's HTTP connection pool.
3. **Assumption: PostgREST's error body is a tolerable downgrade for table-endpoint clients.** If the (future) frontend team expects RFC 7807 uniformly, they won't get it — §11.2 "clients branch on content-type" is ongoing tax.
4. **Assumption: the customer's compliance posture does not require password history, per-account lockout, or audit-log retention beyond Supabase defaults.** Not verified.
5. **Assumption: Supabase's global auth.users.email uniqueness is acceptable given `non-goal` cross-tenant membership.** Fine in single-customer-per-person operation; friction for consultants with multi-tenant engagement.
6. **Assumption: service-role keys will be rotated manually, infrequently, and without formal process.** Nothing in the spec says otherwise.
7. **Assumption: the 1-hour access-token TTL is acceptable revocation latency.** Not reconciled with v0.3's deliberate immediate-revocation choice.

## Suggested Strengthening Moves

1. **Define a mandatory `withAdminContext` wrapper for every admin Edge Function.** Specify it in §8 and §11.1. Make "Edge Function does not extend withAdminContext" a CI gate. Converts the service-role concern from systemic to isolated. **Highest ROI.**

2. **Resolve the RFC 7807 question.** Either (a) admit the RPC-Edge-Function-wrapper doubling and restate §8 accordingly, or (b) drop the RFC 7807 claim for PostgREST native endpoints and scope it to Edge Functions only. Pick one; the current spec straddles.

3. **Shorten access-token TTL OR add a revocation denylist check on sensitive RPCs.** Name the chosen path in §4.2. Document the residual revocation window explicitly.

4. **Enumerate the tenancy-hook failure modes and mitigations** (§4.2 or a new §4.8). Add the `TENANT_CLAIM_MISSING` error convention and the kill-switch hook.

5. **Ask the customer about compliance posture** (§10a). Resolve password-history, per-account-lockout, and audit-retention before implementation starts.

6. **Pin the Supabase tier** in §11.1. State the pg_cron dependency and its tier requirement.

7. **Define `notification_outbox` and `idempotency_keys` as first-class schema** (new §6.7). Include retry policy and pruning cadence.

8. **Name pgTAP as the plpgsql testing framework** in §11.5.

9. **Resolve the `last_sign_in_at` trigger vs access-token-hook status-transition question.** Pick one. Document trade-offs.

10. **Document auth-email-template limitation** (§7.6): per-tenant branding is domain-email only in v1; auth emails are project-global.

11. **Add an import-rate-limit strategy to §9 Phase A** (batching, backoff, resume-from-offset).

12. **State service-role key rotation policy** (§11.1 or new §11.7). Cadence + runbook.

## Conclusion

The v0.4 pivot is a defensible architectural choice — Supabase genuinely does subsume the v0.3 custom stack's auth + CRUD surface. But the spec as written treats the pivot as a net simplification when it is actually a trade: we gain managed infrastructure and shed plumbing code; we lose uniform declarative security controls, immediate revocation, consistent error shape, and the v0.3 design's willingness to enumerate what it was *not* providing (§10 in v0.3 was disciplined; §10 in v0.4 defers real compliance-adjacent controls with "park unless customer insists" language that disguises the trade).

The highest-severity findings cluster in two places: **platform-seam failures** (access-token hook silent fails, PostgREST error-shape mismatch, 1h revocation window) that the v0.3 design did not have; and **security-posture deltas** that are presented as feature parks when they are design changes (per-account lockout, password history, service-role-via-N-Edge-Functions). None of these is fatal. The v0.4 spec is a credible direction; the right next step is a surgical revision that closes findings #1–#6 before any code is written, and an honest conversation with the customer about findings #5 and #10 (credential stuffing defense and compliance posture) before those stay "parked."

The v0.3 adversarial review's finding was that the original spec was a strong design brief but not yet an implementable spec. The v0.4 spec inherits that characterization, now complicated by a set of platform-shaped trades the document does not fully own. A v0.4.1 that addresses findings #1–#6 would be materially ready to build.
