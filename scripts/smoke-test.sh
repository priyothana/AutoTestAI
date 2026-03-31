#!/usr/bin/env bash
# =============================================================================
#  AutoTest AI — Smoke Test
#  Verifies every module route is reachable on http://localhost:4000
#
#  Usage:
#    chmod +x scripts/smoke-test.sh
#    ./scripts/smoke-test.sh
#
#  Exit codes:
#    0  — all routes passed
#    1  — one or more routes failed
# =============================================================================
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
BASE_URL="http://localhost:4000"
API_URL="${BASE_URL}/api/v1"
PORT=4000
SERVER_STARTUP_WAIT=8   # seconds to wait for server to be ready
CURL_TIMEOUT=10         # per-request timeout
SERVER_PID=""

# ── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

PASS=0
FAIL=0
TOTAL=0

# ── Helpers ──────────────────────────────────────────────────────────────────
log_header() { echo -e "\n${BOLD}${CYAN}══${RESET}${BOLD} $1 ${RESET}${CYAN}══${RESET}"; }
log_info()   { echo -e "  ${CYAN}ℹ${RESET}  $1"; }
log_ok()     { echo -e "  ${GREEN}✔${RESET}  $1"; }
log_fail()   { echo -e "  ${RED}✘${RESET}  $1"; }
log_warn()   { echo -e "  ${YELLOW}⚠${RESET}  $1"; }

# Check a route.  Args: METHOD URL "label" EXPECTED_CODES... [-- CURL_EXTRA_ARGS...]
check_route() {
  local method="$1"
  local url="$2"
  local label="$3"
  shift 3

  # Collect expected codes (everything before an optional "--" sentinel)
  local expected_codes=()
  local extra_curl_args=()
  local after_sentinel=false
  for arg in "$@"; do
    if [[ "$arg" == "--" ]]; then
      after_sentinel=true
      continue
    fi
    if $after_sentinel; then
      extra_curl_args+=("$arg")
    else
      expected_codes+=("$arg")
    fi
  done

  TOTAL=$((TOTAL + 1))

  local actual_code
  actual_code=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time "$CURL_TIMEOUT" \
    -X "$method" \
    "${extra_curl_args[@]+"${extra_curl_args[@]}"}" \
    "$url" 2>/dev/null) || true

  # Check if actual_code matches any expected
  local matched=false
  for code in "${expected_codes[@]}"; do
    if [[ "$actual_code" == "$code" ]]; then
      matched=true
      break
    fi
  done

  local expected_str
  expected_str=$(IFS='|'; echo "${expected_codes[*]}")

  if $matched; then
    PASS=$((PASS + 1))
    log_ok "${BOLD}PASS${RESET} [${actual_code}]  ${method} ${label}"
  else
    FAIL=$((FAIL + 1))
    log_fail "${BOLD}FAIL${RESET} [${actual_code}] (expected ${expected_str})  ${method} ${label}"
  fi
}

# ── Cleanup on exit ──────────────────────────────────────────────────────────
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log_info "Stopping server (PID ${SERVER_PID})…"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── Detect if server is already running ─────────────────────────────────────
MANAGED_SERVER=false
if curl -s --max-time 2 "${BASE_URL}/health" >/dev/null 2>&1; then
  log_info "Server already running on :${PORT} — skipping startup."
else
  # Load env and start server
  MANAGED_SERVER=true
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

  if [[ ! -f "${REPO_ROOT}/.env" ]]; then
    log_warn ".env not found — server may fail to start due to missing env vars."
  else
    set -a
    # shellcheck source=/dev/null
    source "${REPO_ROOT}/.env"
    set +a
  fi

  # Override DATABASE_URL and Redis URLs to use localhost (not Docker networking)
  export DATABASE_URL="${NODE_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/autotestdb}"
  export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
  export PORT="${PORT}"
  export JWT_SECRET="${SECRET_KEY:-smoke-test-jwt-secret}"
  export NODE_ENV="development"

  API_DIR="${REPO_ROOT}/services/api"
  if [[ ! -d "$API_DIR" ]]; then
    echo -e "${RED}ERROR:${RESET} services/api directory not found at ${API_DIR}" >&2
    exit 1
  fi

  SERVER_LOG="${REPO_ROOT}/scripts/smoke-server.log"
  log_info "Starting server from ${API_DIR} …"
  log_info "Server log: ${SERVER_LOG}"

  (cd "$API_DIR" && node --loader ts-node/esm --no-warnings src/index.ts) \
    > "$SERVER_LOG" 2>&1 &
  SERVER_PID=$!

  # Wait for server to be ready
  log_info "Waiting up to ${SERVER_STARTUP_WAIT}s for server to be ready…"
  ready=false
  for i in $(seq 1 "$SERVER_STARTUP_WAIT"); do
    sleep 1
    if curl -s --max-time 2 "${BASE_URL}/health" >/dev/null 2>&1; then
      ready=true
      break
    fi
    # Check if server process died
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      log_fail "Server process died. Check ${SERVER_LOG}"
      cat "$SERVER_LOG" | tail -30
      exit 1
    fi
  done

  if ! $ready; then
    log_fail "Server did not become ready after ${SERVER_STARTUP_WAIT}s"
    log_info "Last server output:"
    tail -30 "$SERVER_LOG" 2>/dev/null || true
    exit 1
  fi
  log_ok "Server is up (PID ${SERVER_PID})"
fi

# ── Smoke Tests ──────────────────────────────────────────────────────────────

log_header "HEALTH CHECKS"
check_route GET "${BASE_URL}/"                    "/"        200
check_route GET "${BASE_URL}/health"              "/health"  200

# ─────────────────────────────────────────────────────────────────────────────
log_header "MODULE 1 — Projects"
# POST /api/v1/projects/  → 201 created or 422 validation
check_route POST "${API_URL}/projects/" \
  "POST /api/v1/projects/" \
  201 401 422 \
  -- -H "Content-Type: application/json" \
  -d '{"name":"Smoke Test Project","description":"smoke","type":"web_app"}'

# GET /api/v1/projects/:id  → 200 or 404 (UUID that does not exist)
check_route GET "${API_URL}/projects/00000000-0000-0000-0000-000000000000" \
  "GET /api/v1/projects/:id" \
  200 404

# GET /api/v1/projects/  → 200 (no auth required upstream)
check_route GET "${API_URL}/projects/" \
  "GET /api/v1/projects/" \
  200 401

# ─────────────────────────────────────────────────────────────────────────────
log_header "MODULE 2 — Test Generation  (generate)"
# POST /api/v1/tests/generate-test-steps → 200 or 401 or 422 or 502 (LLM down)
# NOTE: LLM calls can take 30+ seconds — use longer timeout
check_route POST "${API_URL}/tests/generate-test-steps" \
  "POST /api/v1/tests/generate-test-steps" \
  200 401 422 502 \
  -- --max-time 45 -H "Content-Type: application/json" \
  -d '{"prompt":"Login and verify dashboard","provider":"openai"}'

# Alias: POST /api/v1/ai/generate-test-steps
check_route POST "${API_URL}/ai/generate-test-steps" \
  "POST /api/v1/ai/generate-test-steps (alias)" \
  200 401 422 502 \
  -- -H "Content-Type: application/json" \
  -d '{"prompt":"Login and verify dashboard","provider":"openai"}'

# GET /api/v1/ai/models → 200 always (no external deps)
check_route GET "${API_URL}/ai/models" \
  "GET /api/v1/ai/models" \
  200

# ─────────────────────────────────────────────────────────────────────────────
log_header "MODULE 3 — Execution"
# POST /api/v1/execute  → 202 or 401 or 422 (missing required fields)
check_route POST "${API_URL}/execute" \
  "POST /api/v1/execute" \
  202 401 404 422 \
  -- -H "Content-Type: application/json" \
  -d '{"test_case_id":"00000000-0000-0000-0000-000000000000","project_id":"00000000-0000-0000-0000-000000000000"}'

# GET /api/v1/executions/:id → 200 or 404
check_route GET "${API_URL}/executions/00000000-0000-0000-0000-000000000000" \
  "GET /api/v1/executions/:id" \
  200 404

# GET /api/v1/projects/:id/executions → 200 or 404
check_route GET "${API_URL}/projects/00000000-0000-0000-0000-000000000000/executions" \
  "GET /api/v1/projects/:id/executions" \
  200 404

# ─────────────────────────────────────────────────────────────────────────────
log_header "MODULE 4 — Salesforce"
# GET /api/v1/salesforce/metadata/:objectName → 200 or 400 (missing projectId) or 502
check_route GET "${API_URL}/salesforce/metadata/Account" \
  "GET /api/v1/salesforce/metadata/Account (no projectId → 400)" \
  400

# With a dummy projectId → 200, 400, 404, or 502 (no real SF creds)
check_route GET "${API_URL}/salesforce/metadata/Account?projectId=00000000-0000-0000-0000-000000000000" \
  "GET /api/v1/salesforce/metadata/Account?projectId=..." \
  200 400 404 502

# GET /api/v1/salesforce/fields/:objectName
check_route GET "${API_URL}/salesforce/fields/Account?projectId=00000000-0000-0000-0000-000000000000" \
  "GET /api/v1/salesforce/fields/Account" \
  200 400 404 502

# GET /api/v1/salesforce/picklist/:objectName/:fieldName
check_route GET "${API_URL}/salesforce/picklist/Account/Type?projectId=00000000-0000-0000-0000-000000000000" \
  "GET /api/v1/salesforce/picklist/Account/Type" \
  200 400 404 502

# ─────────────────────────────────────────────────────────────────────────────
log_header "MODULE 5 — Self-Healing"
# GET /api/v1/heal/:executionId → 200 or 404
check_route GET "${API_URL}/heal/00000000-0000-0000-0000-000000000000" \
  "GET /api/v1/heal/:id" \
  200 404

# ─────────────────────────────────────────────────────────────────────────────
log_header "MODULE 6 — Analytics"
# GET /api/v1/analytics/dashboard-stats → 200
check_route GET "${API_URL}/analytics/dashboard-stats" \
  "GET /api/v1/analytics/dashboard-stats" \
  200

# GET /api/v1/analytics/projects/:id/summary → 200 or 404
check_route GET "${API_URL}/analytics/projects/00000000-0000-0000-0000-000000000000/summary" \
  "GET /api/v1/analytics/projects/:id/summary" \
  200 404

# GET /api/v1/analytics/projects/:id/flakiness → 200 or 404
check_route GET "${API_URL}/analytics/projects/00000000-0000-0000-0000-000000000000/flakiness" \
  "GET /api/v1/analytics/projects/:id/flakiness" \
  200 404

# GET /api/v1/analytics/projects/:id/coverage → 200 or 404
check_route GET "${API_URL}/analytics/projects/00000000-0000-0000-0000-000000000000/coverage" \
  "GET /api/v1/analytics/projects/:id/coverage" \
  200 404

# ─────────────────────────────────────────────────────────────────────────────
log_header "MODULE 7 — Notifications"
# POST /api/v1/notifications/test → 200 or 401 or 422
check_route POST "${API_URL}/notifications/test" \
  "POST /api/v1/notifications/test" \
  200 401 422 \
  -- -H "Content-Type: application/json" \
  -d '{"project_id":"00000000-0000-0000-0000-000000000000","channel":"slack","message":"Smoke test ping"}'

# ─────────────────────────────────────────────────────────────────────────────
log_header "MODULE 8 — Auth"
# POST /api/v1/users/register → 201 or 409 or 422
check_route POST "${API_URL}/users/register" \
  "POST /api/v1/users/register" \
  201 400 409 422 \
  -- -H "Content-Type: application/json" \
  -d '{"email":"smoke@test.local","password":"Smoke1234!","full_name":"Smoke Tester"}'

# POST /api/v1/users/login → 200 or 401 or 422
check_route POST "${API_URL}/users/login" \
  "POST /api/v1/users/login" \
  200 401 422 \
  -- -H "Content-Type: application/json" \
  -d '{"email":"smoke@test.local","password":"Smoke1234!"}' \
  -H "Content-Type: application/x-www-form-urlencoded"

# ─────────────────────────────────────────────────────────────────────────────
# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}══════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Smoke Test Results${RESET}"
echo -e "${BOLD}══════════════════════════════════════════${RESET}"
echo -e "  Total:  ${BOLD}${TOTAL}${RESET}"
echo -e "  ${GREEN}Passed: ${PASS}${RESET}"
if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}Failed: ${FAIL}${RESET}"
else
  echo -e "  Failed: ${FAIL}"
fi
echo -e "${BOLD}══════════════════════════════════════════${RESET}"

if [[ $FAIL -gt 0 ]]; then
  echo -e "\n${RED}${BOLD}SMOKE TEST FAILED — ${FAIL} route(s) did not respond as expected.${RESET}\n"
  exit 1
else
  echo -e "\n${GREEN}${BOLD}SMOKE TEST PASSED — all ${PASS} routes responded correctly.${RESET}\n"
  exit 0
fi
