#!/usr/bin/env bash
# Top-level runner for all security + correctness gates (spec §11.5, §11.6).
# Intended for CI; also usable locally via `backend/scripts/run-checks.sh`.
#
# What this runs:
#   1. pgTAP suite via `supabase test db`. Covers:
#      - RLS isolation on every tenant-scoped table
#      - access-token hook claim shapes (6 user profiles) — §11.6 P0 gate
#      - assert_tenant_claim_present / assert_session_live
#      - auth.sessions pairing trigger
#      - password_verification_attempt_hook + unlock marker reset
#      - Static check: every state-mutating RPC calls both assert helpers
#        — §11.6 P0 gate (currently empty set; fires when Batch 4 lands)
#   2. Service-role-key usage lint — §11.6 P0 gate
#
# Prereqs: Docker + `supabase start` must have been run at least once; the
# local stack must be reachable.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend="$(cd "${here}/.." && pwd)"

fail=0

echo "=== 1/2  pgTAP suite ==="
(cd "${backend}" && supabase test db) || fail=1

echo
echo "=== 2/2  service-role-key usage lint ==="
"${here}/lint-service-role-usage.sh" || fail=1

echo
if (( fail != 0 )); then
  echo "CHECKS FAILED"
  exit 1
fi
echo "All checks PASSED"
