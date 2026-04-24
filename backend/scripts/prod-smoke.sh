#!/usr/bin/env bash
# Pre-client-cutover smoke: non-destructive verification that the prod stack
# is healthy enough to hand a client the URL. Runs as the final gate in the
# Layer-3 "prod-env verification" step of docs/pre-deploy-uat-spec.md.
#
# Checks performed (all non-destructive, all idempotent, safe to re-run):
#   1. Migration parity vs local files (supabase migration list --linked)
#   2. PostgREST is alive (GET /rest/v1/ returns 200 OpenAPI schema)
#   3. config.toml Supabase Auth redirect URLs include expected prod URL
#   4. Go-live gate (§9.10, 8 gates) — delegates to go-live-gate.sh
#   5. pg_cron schedules are registered + have succeeded in the last 24h
#   6. drain-notifications EF: wrong secret → 403, right secret → 200
#
# Usage:
#   backend/scripts/prod-smoke.sh --tenant <uuid>
#
#   Additional flags:
#     --target local|prod         default: prod
#     --expected-site-url <url>   default: https://invenio-timekeeping.netlify.app
#     --skip <id>                 skip a named check (repeatable: 1|2|3|4|5|6)
#
# Env (required for --target prod):
#   SUPABASE_URL                  https://<ref>.supabase.co
#   SUPABASE_ANON_KEY             publishable anon JWT
#   NOTIFICATION_DRAIN_SECRET     matches EF env + cron job
#
# For --target local, env is sourced from `supabase status -o env`.
#
# Exit codes: 0 all passed · 1 one or more failed · 2 usage error.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend_dir="$(cd "${here}/.." && pwd)"
repo_root="$(cd "${backend_dir}/.." && pwd)"

tenant_id=""
target="prod"
expected_site_url="https://invenio-timekeeping.netlify.app"
declare -a skip_checks=()

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant)               tenant_id="${2:-}"; shift 2 ;;
    --target)               target="${2:-}"; shift 2 ;;
    --expected-site-url)    expected_site_url="${2:-}"; shift 2 ;;
    --skip)                 skip_checks+=("${2:-}"); shift 2 ;;
    -h|--help)              usage ;;
    *)                      echo "prod-smoke: unknown flag $1" >&2; usage ;;
  esac
done

if [[ -z "${tenant_id}" ]]; then
  echo "prod-smoke: --tenant <uuid> is required" >&2
  usage
fi
if [[ "${target}" != "local" && "${target}" != "prod" ]]; then
  echo "prod-smoke: --target must be local|prod — got '${target}'" >&2
  exit 2
fi

# ----------------------------------------------------------------------------
# Environment setup

if [[ "${target}" == "local" ]]; then
  if ! command -v supabase >/dev/null; then
    echo "prod-smoke: supabase CLI not on PATH" >&2; exit 2
  fi
  eval "$(supabase status -o env 2>/dev/null)" || {
    echo "prod-smoke: could not read 'supabase status -o env' — is the stack running?" >&2
    exit 2
  }
  SUPABASE_URL="${API_URL:-}"
  SUPABASE_ANON_KEY="${ANON_KEY:-}"
  # Local drain secret: source backend/.env if available.
  if [[ -f "${backend_dir}/.env" ]]; then
    set -a; source "${backend_dir}/.env"; set +a
  fi
fi

: "${SUPABASE_URL:?SUPABASE_URL not set}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY not set}"

# ----------------------------------------------------------------------------
# Check runner

pass=0; fail=0; skipped=0
declare -a results=()

should_skip() {
  local id="$1"
  for s in "${skip_checks[@]:-}"; do
    [[ "${s}" == "${id}" ]] && return 0
  done
  return 1
}

record() {
  local status="$1"; local id="$2"; local name="$3"; local detail="${4:-}"
  case "${status}" in
    PASS)    pass=$((pass+1)) ;;
    FAIL)    fail=$((fail+1)) ;;
    SKIP)    skipped=$((skipped+1)) ;;
  esac
  if [[ -n "${detail}" ]]; then
    results+=("[${status}] ${id}. ${name} — ${detail}")
  else
    results+=("[${status}] ${id}. ${name}")
  fi
  printf '%s\n' "${results[-1]}"
}

run_check() {
  local id="$1"; local name="$2"; shift 2
  if should_skip "${id}"; then
    record SKIP "${id}" "${name}" "(--skip)"
    return 0
  fi
  if "$@"; then
    record PASS "${id}" "${name}"
  else
    record FAIL "${id}" "${name}" "see output above"
  fi
}

# ----------------------------------------------------------------------------
# Check implementations

check_1_migration_parity() {
  if [[ "${target}" != "prod" ]]; then
    record SKIP 1 "Migration parity" "(only meaningful against --target prod)"
    return 0
  fi
  echo "-- supabase migration list --linked --"
  local out
  out="$(cd "${backend_dir}" && supabase migration list --linked 2>&1)" || {
    printf '%s\n' "${out}"
    return 1
  }
  printf '%s\n' "${out}"
  # Rows with a Local timestamp but empty Remote (or vice versa) indicate drift.
  # The CLI output columns are: Local | Remote | Time (UTC). A drifting row
  # shows one side blank. Heuristic: count lines starting with '|' where one of
  # the first two pipe-fields is entirely whitespace.
  local drift
  drift="$(printf '%s\n' "${out}" \
    | awk -F'|' '/^ *\|/ {
        lhs=$2; rhs=$3;
        gsub(/ /, "", lhs); gsub(/ /, "", rhs);
        if (lhs != rhs) print
      }')"
  if [[ -n "${drift}" ]]; then
    echo "prod-smoke: migration drift detected:" >&2
    printf '%s\n' "${drift}" >&2
    return 1
  fi
  echo "prod-smoke: migrations in parity."
}

check_2_postgrest_alive() {
  local code
  code="$(curl -sS -o /dev/null -w "%{http_code}" \
    "${SUPABASE_URL}/rest/v1/" \
    -H "apikey: ${SUPABASE_ANON_KEY}" 2>/dev/null || echo 000)"
  if [[ "${code}" == "200" ]]; then
    echo "prod-smoke: PostgREST live (HTTP 200)."
    return 0
  fi
  echo "prod-smoke: PostgREST not responding (HTTP ${code})." >&2
  return 1
}

check_3_redirect_urls() {
  local cfg="${backend_dir}/supabase/config.toml"
  if [[ ! -f "${cfg}" ]]; then
    echo "prod-smoke: config.toml not at ${cfg}" >&2; return 1
  fi
  if ! grep -qF "${expected_site_url}" "${cfg}"; then
    echo "prod-smoke: expected site URL '${expected_site_url}' NOT in config.toml" >&2
    return 1
  fi
  echo "prod-smoke: site_url/redirect URLs include ${expected_site_url}."
}

check_4_go_live_gate() {
  "${here}/go-live-gate.sh" "${tenant_id}" "${target}"
}

check_5_cron_schedules() {
  # Query cron.job_run_details for recent successful runs of each job.
  # Passes if every job has at least one 'succeeded' run in the last 24h.
  local sql
  sql="$(cat <<'SQL'
WITH expected AS (
  SELECT unnest(ARRAY[
    'drain-notifications',
    'reconcile-stuck-sending',
    'emit-stall-notifications'
  ]) AS jobname
),
recent AS (
  SELECT j.jobname,
         max(r.end_time) FILTER (WHERE r.status = 'succeeded') AS last_success,
         count(*) FILTER (WHERE r.status = 'failed'
                          AND r.end_time > now() - interval '24 hours') AS failures_24h
    FROM cron.job j
    LEFT JOIN cron.job_run_details r ON r.jobid = j.jobid
   GROUP BY j.jobname
)
SELECT e.jobname,
       coalesce(r.last_success::text, 'NEVER') AS last_success,
       coalesce(r.failures_24h, 0)             AS failures_24h,
       CASE
         WHEN r.last_success IS NULL THEN 'BLOCKED: never succeeded'
         WHEN r.last_success < now() - interval '24 hours'
              THEN 'BLOCKED: no success in 24h'
         ELSE 'OK'
       END AS status
  FROM expected e
  LEFT JOIN recent r ON r.jobname = e.jobname
 ORDER BY e.jobname;
SQL
)"
  local out
  if [[ "${target}" == "local" ]]; then
    out="$(docker exec -i supabase_db_invenio-timekeeping \
      psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<<"${sql}")" || return 1
  else
    out="$(printf '%s\n' "${sql}" | supabase db query --linked)" || return 1
  fi
  printf '%s\n' "${out}"
  if printf '%s\n' "${out}" | grep -q 'BLOCKED'; then
    return 1
  fi
  echo "prod-smoke: all pg_cron schedules healthy (success in last 24h)."
}

check_6_drain_smoke() {
  if [[ -z "${NOTIFICATION_DRAIN_SECRET:-}" ]]; then
    echo "prod-smoke: NOTIFICATION_DRAIN_SECRET not set — cannot exercise drain" >&2
    return 1
  fi
  # Wrong secret → 403.
  local bad
  bad="$(curl -sS -o /dev/null -w "%{http_code}" \
    -X POST "${SUPABASE_URL}/functions/v1/drain-notifications" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer invalid-secret-for-smoke" \
    -H "Content-Type: application/json" \
    --data '{}' 2>/dev/null || echo 000)"
  if [[ "${bad}" != "403" ]]; then
    echo "prod-smoke: drain wrong-secret expected 403, got ${bad}" >&2
    return 1
  fi
  # Right secret → 200.
  local good
  good="$(curl -sS -o /dev/null -w "%{http_code}" \
    -X POST "${SUPABASE_URL}/functions/v1/drain-notifications" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${NOTIFICATION_DRAIN_SECRET}" \
    -H "Content-Type: application/json" \
    --data '{}' 2>/dev/null || echo 000)"
  if [[ "${good}" != "200" ]]; then
    echo "prod-smoke: drain correct-secret expected 200, got ${good}" >&2
    return 1
  fi
  echo "prod-smoke: drain-notifications auth boundaries OK (403 / 200)."
}

# ----------------------------------------------------------------------------
# Main

echo "prod-smoke: target=${target} tenant=${tenant_id} url=${SUPABASE_URL}"
echo

run_check 1 "Migration parity"            check_1_migration_parity
run_check 2 "PostgREST alive"             check_2_postgrest_alive
run_check 3 "Auth redirect URLs"          check_3_redirect_urls
run_check 4 "Go-live gate (§9.10)"        check_4_go_live_gate
run_check 5 "pg_cron schedule health"     check_5_cron_schedules
run_check 6 "drain-notifications smoke"   check_6_drain_smoke

echo
echo "===== prod-smoke summary ====="
printf '%s\n' "${results[@]}"
echo
echo "pass=${pass} fail=${fail} skipped=${skipped}"

if (( fail > 0 )); then
  echo "prod-smoke: FAILED — do not hand client the URL until resolved." >&2
  exit 1
fi
echo "prod-smoke: all checks passed — ready for client cutover."
