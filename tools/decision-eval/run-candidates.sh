#!/bin/bash
# #1639: runs every request against each candidate in turn, one model loaded at a time. Each
# candidate gets a fresh offline container (host.sh start offline), so its cgroup memory.peak is
# its own; the idle gate runs first and the memory check runs before the load (host.sh load,
# MIN_AVAILABLE_GB, default 8). A candidate whose results end in .done is skipped, so a paused run
# resumes where it stopped. Whenever the run stops early, the container is stopped too, so no
# model stays loaded while the host is busy.
#
# During a run the gate is checked every GATE_EVERY requests (default 20). Its memory floor is
# RUN_MIN_AVAILABLE_GB (default 6): the candidate itself holds up to ~5 GB by then, so a floor of
# 8 would stop a run on its own model; a further drop means something else started.
#
# Usage: run-candidates.sh REQUESTS LABEL=FULL_MODEL_NAME [LABEL=FULL_MODEL_NAME ...]
# (offline, a model is addressed by its full name, e.g. ollaya.dev/library/decima:small)
# Exit: 0 all done, 75 the idle gate closed, 3 the memory check failed, other: a step failed.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
EVAL_DIR=${EVAL_DIR:-/mnt/docker/appdata/cowork/eval/decisions}
PORT=${PORT:-11535}
GATE_EVERY=${GATE_EVERY:-20}
RUN_MIN_AVAILABLE_GB=${RUN_MIN_AVAILABLE_GB:-6}
REQ=${1:?requests.jsonl}; shift
stop_and_exit() { "$HERE/host.sh" stop >/dev/null 2>&1; echo "stopped the container; exit $1"; exit "$1"; }
for pair in "$@"; do
  label=${pair%%=*}; model=${pair#*=}
  out="$EVAL_DIR/results/$label.jsonl"
  if [ -e "$out.done" ]; then echo "$label: already done"; continue; fi
  "$HERE/gate.sh" || stop_and_exit 75
  "$HERE/host.sh" start offline || stop_and_exit 1
  load=$("$HERE/host.sh" load "$model") || stop_and_exit 3
  printf '{"label":"%s","at":"%s","load":%s}\n' "$label" "$(date -u +%FT%TZ)" "$load" >> "$EVAL_DIR/results/loads.jsonl"
  node "$HERE/run.cjs" --requests "$REQ" --out "$out" --target ollaya --url "http://127.0.0.1:$PORT" --model "$model" --label "$label" \
    --api-key-file "$EVAL_DIR/run/api-key" --warmup 3 --gate "MIN_AVAILABLE_GB=$RUN_MIN_AVAILABLE_GB $HERE/gate.sh" --gate-every "$GATE_EVERY"
  rc=$?
  printf '{"label":"%s","at":"%s","peak":%s}\n' "$label" "$(date -u +%FT%TZ)" "$("$HERE/host.sh" peak)" >> "$EVAL_DIR/results/peaks.jsonl"
  [ "$rc" -eq 0 ] || { echo "$label: stopped with $rc"; stop_and_exit "$rc"; }
  touch "$out.done"
  echo "$label: done"
done
"$HERE/host.sh" stop
