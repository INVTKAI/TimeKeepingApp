#!/usr/bin/env bash
# Edge Function integration tests.
# -----------------------------------------------------------------------------
# Sources env vars from `supabase status -o env` so the Deno harness can:
#   * reach the local API at the +10 port
#   * use the service-role key for fixture seed/cleanup
#   * sign test JWTs with the local JWT secret
#
# Boots `supabase functions serve --env-file .env` in the background if it's
# not already running, runs `deno test`, then tears down the functions
# process it started (it leaves a pre-existing one alone).
#
# Prereqs:
#   * docker running + `supabase start` completed
#   * `deno` on PATH
#
# Run: backend/scripts/run-ef-tests.sh

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend_dir="$(cd "${here}/.." && pwd)"
test_dir="${backend_dir}/tests-integration"

if ! command -v deno >/dev/null; then
  echo "run-ef-tests: deno not on PATH (brew install deno)" >&2
  exit 2
fi
if ! command -v supabase >/dev/null; then
  echo "run-ef-tests: supabase CLI not on PATH" >&2
  exit 2
fi

cd "${backend_dir}"

# Capture env vars from the running local stack.
eval "$(supabase status -o env 2>/dev/null)"
if [[ -z "${API_URL:-}" || -z "${SERVICE_ROLE_KEY:-}" || -z "${ANON_KEY:-}" ]]; then
  echo "run-ef-tests: could not read env from 'supabase status -o env'. Is the stack running (supabase start)?" >&2
  exit 2
fi

# Source backend/.env FIRST so we can pick up NOTIFICATION_DRAIN_SECRET and
# any other non-Supabase secrets. Then re-export local Supabase values to
# ensure the prod-cloud URL/keys that live in .env don't leak into the test
# runner (integration tests MUST hit the local stack).
if [[ -f "${backend_dir}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "${backend_dir}/.env"
  set +a
fi

export SUPABASE_URL="${API_URL}"
export SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}"
export SUPABASE_ANON_KEY="${ANON_KEY}"
export SUPABASE_JWT_SECRET="${JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters-long}"

# Is the functions runtime already serving?
owns_functions_serve=0
if ! curl -sS -o /dev/null -w "%{http_code}" "${API_URL}/functions/v1/invite-user" -X POST -H "apikey: ${ANON_KEY}" | grep -q "^[0-9]"; then
  # curl errored (connection refused) — need to start it ourselves.
  : # fall through to boot below
fi

# Probe for a served function: a 401 from `invite-user` means runtime is up.
probe_status=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "${API_URL}/functions/v1/invite-user" \
  -H "apikey: ${ANON_KEY}" 2>/dev/null || echo 000)

if [[ "${probe_status}" == "401" || "${probe_status}" == "400" ]]; then
  echo "run-ef-tests: functions runtime already serving — reusing."
else
  echo "run-ef-tests: booting supabase functions serve…"
  log_file="$(mktemp)"
  supabase functions serve --env-file .env >"${log_file}" 2>&1 &
  functions_pid=$!
  owns_functions_serve=1
  trap 'if [[ ${owns_functions_serve} -eq 1 && -n "${functions_pid:-}" ]]; then kill "${functions_pid}" 2>/dev/null || true; wait "${functions_pid}" 2>/dev/null || true; fi' EXIT
  # Wait for readiness: poll the probe URL until it returns 401.
  for _ in $(seq 1 30); do
    sleep 1
    s=$(curl -sS -o /dev/null -w "%{http_code}" \
      -X POST "${API_URL}/functions/v1/invite-user" \
      -H "apikey: ${ANON_KEY}" 2>/dev/null || echo 000)
    if [[ "${s}" == "401" || "${s}" == "400" ]]; then
      echo "run-ef-tests: functions runtime ready."
      break
    fi
  done
  if [[ "${s:-}" != "401" && "${s:-}" != "400" ]]; then
    echo "run-ef-tests: functions runtime did not come up in 30s. Last status: ${s:-?}." >&2
    echo "--- functions serve log ---" >&2
    cat "${log_file}" >&2
    exit 1
  fi
fi

echo "run-ef-tests: running deno test in ${test_dir}"
cd "${test_dir}"
deno test --allow-net --allow-env --no-check
