#!/usr/bin/env bash
# Spec §11.6 P0 CI gate.
# -----------------------------------------------------------------------------
# Service-role-key usage is the tenancy-isolation boundary. The rule: it may
# only appear inside _shared/with-admin-context.ts. Any other Edge Function
# that references the key directly bypasses the admin-context contract (role
# + tenant verification) and represents a full-project RLS-escape surface.
#
# This script scans backend/supabase/functions/ for three forbidden patterns
# outside the wrapper and exits non-zero on any hit:
#   1. Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
#   2. SUPABASE_SERVICE_ROLE_KEY in any form
#   3. createClient(<anything>, <anything>serviceRole<anything>, ...) — heuristic
#
# Run: backend/scripts/lint-service-role-usage.sh
# (If invoked from elsewhere, it resolves paths relative to the script dir.)

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fn_dir="$(cd "${here}/../supabase/functions" && pwd)"
allowed_file="${fn_dir}/_shared/with-admin-context.ts"

if [[ ! -f "${allowed_file}" ]]; then
  echo "lint: expected wrapper at ${allowed_file} but it's missing" >&2
  exit 2
fi

violations=0

scan() {
  local pattern="$1"
  local label="$2"
  local hits
  hits="$(grep -rnE "${pattern}" "${fn_dir}" --include="*.ts" || true)"
  if [[ -z "${hits}" ]]; then
    return 0
  fi
  # Filter out the wrapper file.
  hits="$(printf '%s\n' "${hits}" | grep -v "/_shared/with-admin-context\.ts:" || true)"
  if [[ -n "${hits}" ]]; then
    echo "lint: ${label}" >&2
    printf '  %s\n' "${hits}" >&2
    violations=$((violations+1))
  fi
}

# Pattern 1: the env-var access idiom.
scan 'Deno\.env\.get\(['"'"'"]SUPABASE_SERVICE_ROLE_KEY['"'"'"]\)' \
  'forbidden: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") outside with-admin-context.ts'

# Pattern 2: bare literal in source (in case someone imports from a shared
# constants file or uses process-env differently).
scan 'SUPABASE_SERVICE_ROLE_KEY' \
  'forbidden: SUPABASE_SERVICE_ROLE_KEY reference outside with-admin-context.ts'

# Pattern 3: createClient with a variable name implying service-role, outside
# the wrapper. Catches common shapes like createClient(url, serviceRoleKey).
scan 'createClient\([^)]*service[_]?[Rr]ole[_]?[Kk]ey' \
  'forbidden: createClient(..., service-role-key) outside with-admin-context.ts'

if (( violations > 0 )); then
  echo "lint: FAILED — ${violations} violation pattern(s)." >&2
  exit 1
fi

echo "lint: service-role-key usage OK — restricted to _shared/with-admin-context.ts"
