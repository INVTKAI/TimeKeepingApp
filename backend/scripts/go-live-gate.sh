#!/usr/bin/env bash
# Runs the §9.10 go-live gate checks against a tenant (local or prod).
#
# Usage:
#   scripts/go-live-gate.sh <tenant-uuid> [local|prod]
#
# Local (default): routes through the local Docker container.
# Prod: requires `supabase link` to have been run; uses `supabase db query`.
#
# Exit code: 0 if all gates pass (total_violations = 0), 1 otherwise.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sql_file="${here}/go-live-gate.sql"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <tenant-uuid> [local|prod]" >&2
  exit 2
fi
tenant_id="$1"
target="${2:-local}"

if [[ ! -f "${sql_file}" ]]; then
  echo "go-live-gate: ${sql_file} not found" >&2
  exit 2
fi

if [[ "${target}" == "local" ]]; then
  out="$(docker exec -i supabase_db_invenio-timekeeping \
    psql -U postgres -d postgres -v tenant_id="'${tenant_id}'" -f - < "${sql_file}")"
elif [[ "${target}" == "prod" ]]; then
  # supabase db query doesn't accept a -v binding; inline the substitution.
  substituted="$(sed "s|:tenant_id|'${tenant_id}'|g" "${sql_file}")"
  out="$(printf '%s\n' "${substituted}" | supabase db query --linked)"
else
  echo "go-live-gate: target must be 'local' or 'prod' — got '${target}'" >&2
  exit 2
fi

printf '%s\n' "${out}"
if printf '%s\n' "${out}" | grep -q '^ *BLOCKED '; then
  echo "go-live-gate: BLOCKED — one or more gates failed. Fix and re-run." >&2
  exit 1
fi
echo "go-live-gate: all gates pass for tenant ${tenant_id}." >&2
