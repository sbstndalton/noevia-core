#!/bin/bash
# #1639: the idle gate for an evaluation run on the inference host. Read-only: it reads state files,
# container logs (counts only, never the lines) and resource figures, and changes nothing.
# Exit 0 when idle, 1 when busy; one JSON line on stderr says which check closed it.
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

busy() { printf '{"idle":false,"check":"%s","detail":"%s"}\n' "$1" "$2" >&2; exit 1; }
now=$(date +%s)
quiet=$((QUIET_MIN * 60))

for f in "$STATE_DIR"/native-autotune-*.json "$STATE_DIR"/native-calibration-*.json; do
  [ -e "$f" ] || continue
  status=$(jq -r '.job.status // .status // ""' "$f" 2>/dev/null)
  case "$status" in running|queued|pending|starting|tuning|active) busy autotune "$(basename "$f") $status" ;; esac
  age=$((now - $(stat -c %Y "$f")))
  [ "$age" -lt "$quiet" ] && busy autotune "$(basename "$f") written ${age}s ago"
done

log="$STATE_DIR/system-one-decisions.jsonl"
if [ -e "$log" ]; then
  age=$((now - $(stat -c %Y "$log")))
  [ "$age" -lt "$quiet" ] && busy chat "decision log written ${age}s ago"
fi
chat=$(docker logs --since "${QUIET_MIN}m" "$WEB" 2>&1 | grep -cE '^\[(system-one\]|routing\]|tools\] routed)')
[ "$chat" -gt 0 ] && busy chat "$chat routing lines in ${QUIET_MIN} min"

engine=$(docker logs --since 2m "$ENGINE" 2>&1 | grep -cE "launch_slot_|print_timing|spawning server instance")
[ "$engine" -gt 0 ] && busy engine "$engine engine task lines in 2 min"

for c in $CODE_CONTAINERS; do
  cpu=$(docker stats --no-stream --format '{{.CPUPerc}}' "$c" 2>/dev/null | tr -d '%')
  [ -n "$cpu" ] && awk -v c="$cpu" 'BEGIN{exit !(c > 5)}' && busy coding "$c ${cpu}%"
done

avail_kb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
avail_gb=$((avail_kb / 1048576))
[ "$avail_gb" -lt "$MIN_AVAILABLE_GB" ] && busy memory "${avail_gb} GiB available"

printf '{"idle":true,"availableGiB":%s}\n' "$avail_gb" >&2
exit 0
