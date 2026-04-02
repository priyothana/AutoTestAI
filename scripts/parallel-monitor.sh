#!/usr/bin/env bash
# =============================================================================
# AutoTest AI — Parallel Run Monitor
# =============================================================================
#
# Polls /health on both backends every 30 s.
# Parses logs/node.log and logs/python.log (JSON lines) for request stats.
# Prints a live ANSI summary table every 60 s.
# Appends a one-line CSV-style summary to logs/parallel-run-YYYY-MM-DD.log.
#
# Usage:
#   ./scripts/parallel-monitor.sh
#   Ctrl+C to stop
#
# Env vars (all optional — sensible defaults supplied):
#   NODE_URL        base URL of Node.js backend  (default: http://localhost:4000)
#   PYTHON_URL      base URL of Python backend   (default: http://localhost:8000)
#   LOG_NODE_PATH   path to Node log file        (default: logs/node.log)
#   LOG_PYTHON_PATH path to Python log file      (default: logs/python.log)
#   POLL_INTERVAL   health-poll interval (s)     (default: 30)
#   TABLE_INTERVAL  table-print interval (s)     (default: 60)
# =============================================================================

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
NODE_URL="${NODE_URL:-http://localhost:4000}"
PYTHON_URL="${PYTHON_URL:-http://localhost:8000}"

# Resolve script dir so relative paths work from any CWD
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOGS_DIR="${REPO_ROOT}/logs"

LOG_NODE_PATH="${LOG_NODE_PATH:-${LOGS_DIR}/node.log}"
LOG_PYTHON_PATH="${LOG_PYTHON_PATH:-${LOGS_DIR}/python.log}"

POLL_INTERVAL="${POLL_INTERVAL:-30}"
TABLE_INTERVAL="${TABLE_INTERVAL:-60}"

# ─── ANSI helpers ────────────────────────────────────────────────────────────
BOLD="\033[1m"
RESET="\033[0m"
RED="\033[31m"
GRN="\033[32m"
YEL="\033[33m"
CYN="\033[36m"
DIM="\033[2m"

# ─── State vars ──────────────────────────────────────────────────────────────
node_status="unknown"
python_status="unknown"
prev_node_5xx=0
prev_python_5xx=0

# ─── Helpers ─────────────────────────────────────────────────────────────────

# Poll /health — returns "online" or "offline"
check_health() {
  local url="$1/health"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 --max-time 5 "$url" 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]]; then
    echo "online"
  else
    echo "offline"
  fi
}

# Parse a JSON-lines log file for stats.
# Outputs: "requests 5xx avg_ms" space-separated.
# JSON shape expected: {"statusCode":200,"responseTime":45,...}
parse_log_stats() {
  local logfile="$1"
  if [[ ! -f "$logfile" ]]; then
    echo "0 0 0"
    return
  fi

  # Use python3 for JSON parsing (universally available, avoids jq dependency)
  python3 - "$logfile" << 'PYEOF'
import sys, json

path = sys.argv[1]
total = 0
errors5xx = 0
time_sum = 0.0

try:
    with open(path, 'r', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                sc = obj.get('statusCode') or obj.get('res', {}).get('statusCode') if isinstance(obj.get('res'), dict) else None
                rt = obj.get('responseTime')
                if sc is None or rt is None:
                    continue
                sc = int(sc)
                rt = float(rt)
                total += 1
                if sc >= 500:
                    errors5xx += 1
                time_sum += rt
            except (json.JSONDecodeError, ValueError, TypeError):
                continue
except OSError:
    pass

avg = round(time_sum / total) if total > 0 else 0
print(f"{total} {errors5xx} {avg}")
PYEOF
}

# Collect failing URLs from a log file (last N lines)
get_failing_urls() {
  local logfile="$1"
  local max_lines="${2:-500}"
  if [[ ! -f "$logfile" ]]; then
    echo ""
    return
  fi
  tail -n "$max_lines" "$logfile" | python3 - << 'PYEOF'
import sys, json
from collections import defaultdict

counts = defaultdict(int)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
        sc = obj.get('statusCode')
        if isinstance(obj.get('res'), dict):
            sc = obj['res'].get('statusCode', sc)
        url = obj.get('url') or (obj.get('req', {}).get('url') if isinstance(obj.get('req'), dict) else None)
        if sc is not None and url is not None and int(sc) >= 500:
            counts[f"{url} ({sc})"] += 1
    except (json.JSONDecodeError, ValueError, TypeError):
        continue

for k, v in sorted(counts.items(), key=lambda x: -x[1]):
    print(f"  {k} ×{v}")
PYEOF
}

# Pad a string to N chars
pad() {
  local s="$1"
  local n="$2"
  local len="${#s}"
  if (( len >= n )); then
    echo "${s:0:$n}"
  else
    printf "%s%*s" "$s" $((n - len)) ""
  fi
}

# Print the ANSI summary table
print_table() {
  local n_stat="$1"
  local n_req="$2"
  local n_5xx="$3"
  local n_avg="$4"
  local p_stat="$5"
  local p_req="$6"
  local p_5xx="$7"
  local p_avg="$8"

  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')

  local n_icon p_icon
  [[ "$n_stat" == "online" ]] && n_icon="${GRN}✓ online${RESET}" || n_icon="${RED}✗ offline${RESET}"
  [[ "$p_stat" == "online" ]] && p_icon="${GRN}✓ online${RESET}" || p_icon="${RED}✗ offline${RESET}"

  # Determine row colors
  local n_color="" p_color=""
  (( n_5xx > 0 )) && n_color="$RED"
  (( p_5xx > 0 )) && p_color="$RED"

  echo
  echo -e "${BOLD}${CYN}AutoTest AI — Parallel Run Monitor${RESET}"
  echo -e "┌─────────────────┬────────────────┬──────────┬──────────┬───────────┐"
  echo -e "│ ${BOLD}Backend         ${RESET}│ ${BOLD}Status         ${RESET}│ ${BOLD}Requests${RESET} │ ${BOLD}5xx     ${RESET} │ ${BOLD}Avg ms   ${RESET} │"
  echo -e "├─────────────────┼────────────────┼──────────┼──────────┼───────────┤"
  printf "│ ${n_color}%-15s${RESET} │ ${n_icon}       │ ${n_color}%-8s${RESET} │ ${n_color}%-8s${RESET} │ ${n_color}%-9s${RESET} │\n" \
    "Node   :4000" "${n_req}" "${n_5xx}" "${n_avg}ms"
  printf "│ ${p_color}%-15s${RESET} │ ${p_icon}       │ ${p_color}%-8s${RESET} │ ${p_color}%-8s${RESET} │ ${p_color}%-9s${RESET} │\n" \
    "Python :8000" "${p_req}" "${p_5xx}" "${p_avg}ms"
  echo -e "└─────────────────┴────────────────┴──────────┴──────────┴───────────┘"
  echo -e "  ${DIM}Last updated: ${ts}${RESET}"
}

# Append one-line summary to the daily log file
append_daily_log() {
  local n_req="$1" n_5xx="$2" n_avg="$3"
  local p_req="$4" p_5xx="$5" p_avg="$6"
  local date_str ts
  date_str=$(date '+%Y-%m-%d')
  ts=$(date '+%Y-%m-%dT%H:%M:%S')
  local daily_log="${LOGS_DIR}/parallel-run-${date_str}.log"
  mkdir -p "${LOGS_DIR}"
  echo "${ts} | node_req=${n_req} | node_5xx=${n_5xx} | node_avg_ms=${n_avg} | python_req=${p_req} | python_5xx=${p_5xx} | python_avg_ms=${p_avg}" \
    >> "$daily_log"
}

# ─── Health poll loop (background, every POLL_INTERVAL seconds) ─────────────
health_poll_loop() {
  while true; do
    node_status=$(check_health "$NODE_URL")
    python_status=$(check_health "$PYTHON_URL")
    sleep "$POLL_INTERVAL"
  done
}

# ─── Main table loop (every TABLE_INTERVAL seconds) ──────────────────────────
table_loop() {
  while true; do
    # Parse log stats
    read -r n_req n_5xx n_avg <<< "$(parse_log_stats "$LOG_NODE_PATH")"
    read -r p_req p_5xx p_avg <<< "$(parse_log_stats "$LOG_PYTHON_PATH")"

    # Terminal bell if 5xx increased since last check
    if (( n_5xx > prev_node_5xx || p_5xx > prev_python_5xx )); then
      echo -e "\a"
    fi
    prev_node_5xx=$n_5xx
    prev_python_5xx=$p_5xx

    # Print table
    print_table "$node_status" "$n_req" "$n_5xx" "$n_avg" \
                "$python_status" "$p_req" "$p_5xx" "$p_avg"

    # Append to daily log
    append_daily_log "$n_req" "$n_5xx" "$n_avg" "$p_req" "$p_5xx" "$p_avg"

    sleep "$TABLE_INTERVAL"
  done
}

# ─── Startup ─────────────────────────────────────────────────────────────────
echo -e "${BOLD}${CYN}AutoTest AI Parallel Monitor — starting${RESET}"
echo -e "  Node   : ${NODE_URL}"
echo -e "  Python : ${PYTHON_URL}"
echo -e "  Node log   : ${LOG_NODE_PATH}"
echo -e "  Python log : ${LOG_PYTHON_PATH}"
echo -e "  Health poll : every ${POLL_INTERVAL}s  |  Table update: every ${TABLE_INTERVAL}s"
echo -e "  Press Ctrl+C to stop."
echo

# Seed initial health status immediately
node_status=$(check_health "$NODE_URL")
python_status=$(check_health "$PYTHON_URL")

# Run health poll in background
health_poll_loop &
HEALTH_PID=$!

# Cleanup on exit
trap 'kill "$HEALTH_PID" 2>/dev/null; echo -e "\n${YEL}Monitor stopped.${RESET}"; exit 0' INT TERM

# Run table loop in foreground
table_loop
