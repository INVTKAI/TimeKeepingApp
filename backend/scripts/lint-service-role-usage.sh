#!/usr/bin/env bash
# Spec §11.6 P0 CI gate.
# -----------------------------------------------------------------------------
# Service-role-key usage is the tenancy-isolation boundary. The rule: it may
# only appear inside explicitly-authorized files that do their own auth/guard
# before touching the key.
#
# Current allow-list:
#   _shared/with-admin-context.ts     — user-facing admin EFs (JWT + admin-role
#                                       + tenant-claim verification)
#   drain-notifications/index.ts      — system-triggered drainer (shared-secret
#                                       Bearer guard against
#                                       NOTIFICATION_DRAIN_SECRET; not a user
#                                       call path — pg_cron / ops only)
#
# Adding a new allow-listed file is a conscious choice: that file MUST
# implement its own auth check BEFORE it constructs a service-role client.
# New admin-user-facing EFs should use withAdminContext and NOT appear here.
#
# Forbidden patterns anywhere else under supabase/functions/:
#   1. Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
#   2. SUPABASE_SERVICE_ROLE_KEY literal references
#   3. createClient(<anything>, <...>service[_]?[Rr]ole[_]?[Kk]ey<...>, ...)
#
# Run: backend/scripts/lint-service-role-usage.sh

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fn_dir="$(cd "${here}/../supabase/functions" && pwd)"

# Files allowed to use the service-role key directly.
ALLOWED=(
  "${fn_dir}/_shared/with-admin-context.ts"
  "${fn_dir}/drain-notifications/index.ts"
)

for f in "${ALLOWED[@]}"; do
  if [[ ! -f "${f}" ]]; then
    echo "lint: expected allow-listed file ${f} but it's missing" >&2
    exit 2
  fi
done

# Build a grep-filter pattern matching any allow-listed file path.
filter_pattern='('
sep=''
for f in "${ALLOWED[@]}"; do
  filter_pattern+="${sep}$(printf '%s' "${f}" | sed 's|[.[\*^$()+?{|]|\\&|g')"
  sep='|'
done
filter_pattern+='):'

violations=0

scan() {
  local pattern="$1"
  local label="$2"
  local hits
  hits="$(grep -rnE "${pattern}" "${fn_dir}" --include="*.ts" || true)"
  if [[ -z "${hits}" ]]; then
    return 0
  fi
  # Filter out any hits on allow-listed files.
  hits="$(printf '%s\n' "${hits}" | grep -vE "${filter_pattern}" || true)"
  if [[ -n "${hits}" ]]; then
    echo "lint: ${label}" >&2
    printf '  %s\n' "${hits}" >&2
    violations=$((violations+1))
  fi
}

scan 'Deno\.env\.get\(['"'"'"]SUPABASE_SERVICE_ROLE_KEY['"'"'"]\)' \
  'forbidden: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") outside the allow-list'

scan 'SUPABASE_SERVICE_ROLE_KEY' \
  'forbidden: SUPABASE_SERVICE_ROLE_KEY reference outside the allow-list'

scan 'createClient\([^)]*service[_]?[Rr]ole[_]?[Kk]ey' \
  'forbidden: createClient(..., service-role-key) outside the allow-list'

if (( violations > 0 )); then
  echo "lint: FAILED — ${violations} violation pattern(s)." >&2
  exit 1
fi

echo "lint: service-role-key usage OK — restricted to allow-list ($((${#ALLOWED[@]})) files)"
