#!/bin/bash
# #1639: the idle gate for an evaluation run on the inference host. Read-only: it reads state files,
# container logs (counts only, never the lines) and resource figures, and changes nothing.
# Exit 0 when idle, 1 when busy; one JSON line on stderr says which check closed it.
# Fail closed: a read that fails (a renamed container, no permission, a state file that cannot be
# read or stat'ed, an unreadable meminfo) counts as busy, never as idle.
#
# Busy when any of:
#   - an auto-tune or calibration job is running (state/web/native-{autotune,calibration}-*.json),
#     or one of those files changed in the last QUIET_MIN minutes;
#   - chat activity in the last QUIET_MIN minutes: a decision-log write, or a routing/tool/System-One
#     line in the web log;
#   - the answering engine started a task or a model in the last 2 minutes (launch_slot_,
#     print_timing, a spawned instance; its status-poll proxy lines do not count);
#   - a Coding job: the code sandbox or verifier using more than 5% CPU;
#   - less than MIN_AVAILABLE_GB of available memory (the iGPU shares system RAM, #697).
set -u
STATE_DIR=${STATE_DIR:-/mnt/docker/appdata/cowork/state/web}
WEB=${WEB_CONTAINER:-cowork-web-1}
ENGINE=${ENGINE_CONTAINER:-cowork-llama-1}
CODE_CONTAINERS=${CODE_CONTAINERS:-"cowork-code-sandbox-1 cowork-code-verify-1"}
QUIET_MIN=${QUIET_MIN:-10}
MIN_AVAILABLE_GB=${MIN_AVAILABLE_GB:-8}
MEMINFO=${MEMINFO:-/proc/meminfo}

busy() { printf '{"idle":false,"check":"%s","detail":"%s"}\n' "$1" "$2" >&2; exit 1; }
is_int() { [[ "$1" =~ ^[0-9]+$ ]]; }
now=$(date +%s)
quiet=$((QUIET_MIN * 60))
# Seconds since a file changed; any failure closes the gate under check $2.
age_of() {
  local mtime
  mtime=$(stat -c %Y "$1" 2>/dev/null) && is_int "$mtime" || busy "$2" "cannot stat $(basename "$1")"
  echo $((now - mtime))
}
# Lines matching $3 in container $1's log since $2; a failed docker logs closes the gate under check $4.
log_count() {
  local text
  text=$(docker logs --since "$2" "$1" 2>&1) || busy "$4" "cannot read the $1 log"
  printf '%s\n' "$text" | grep -cE "$3" || true
}

[ -d "$STATE_DIR" ] && [ -r "$STATE_DIR" ] || busy autotune "cannot read $STATE_DIR"
for f in "$STATE_DIR"/native-autotune-*.json "$STATE_DIR"/native-calibration-*.json; do
  [ -e "$f" ] || continue
  status=$(jq -r '.job.status // .status // ""' "$f" 2>/dev/null) || busy autotune "cannot read $(basename "$f")"
  case "$status" in running|queued|pending|starting|tuning|active) busy autotune "$(basename "$f") $status" ;; esac
  age=$(age_of "$f" autotune) || exit 1
  [ "$age" -lt "$quiet" ] && busy autotune "$(basename "$f") written ${age}s ago"
done

log="$STATE_DIR/system-one-decisions.jsonl"
if [ -e "$log" ]; then
  age=$(age_of "$log" chat) || exit 1
  [ "$age" -lt "$quiet" ] && busy chat "decision log written ${age}s ago"
fi
chat=$(log_count "$WEB" "${QUIET_MIN}m" '^\[(system-one\]|routing\]|tools\] routed)' chat) || exit 1
is_int "$chat" || busy chat "unreadable web log count"
[ "$chat" -gt 0 ] && busy chat "$chat routing lines in ${QUIET_MIN} min"

engine=$(log_count "$ENGINE" 2m 'launch_slot_|print_timing|spawning server instance' engine) || exit 1
is_int "$engine" || busy engine "unreadable engine log count"
[ "$engine" -gt 0 ] && busy engine "$engine engine task lines in 2 min"

for c in $CODE_CONTAINERS; do
  cpu=$(docker stats --no-stream --format '{{.CPUPerc}}' "$c" 2>/dev/null) || busy coding "cannot read $c"
  cpu=${cpu%\%}
  [[ "$cpu" =~ ^[0-9]+(\.[0-9]+)?$ ]] || busy coding "unreadable CPU figure for $c"
  awk -v c="$cpu" 'BEGIN{exit !(c > 5)}' && busy coding "$c ${cpu}%"
done

avail_kb=$(awk '/^MemAvailable:/{print $2}' "$MEMINFO" 2>/dev/null) && is_int "$avail_kb" || busy memory "cannot read MemAvailable"
avail_gb=$((avail_kb / 1048576))
[ "$avail_gb" -lt "$MIN_AVAILABLE_GB" ] && busy memory "${avail_gb} GiB available"

printf '{"idle":true,"availableGiB":%s}\n' "$avail_gb" >&2
exit 0
