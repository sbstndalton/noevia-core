#!/bin/bash
# #1639: the evaluation container on the inference host. It only ever touches its own container,
# network and directory; live services are never stopped, restarted or reconfigured.
#
#   host.sh setup               create EVAL_DIR (models/, run/, results/), the API key and the network
#   host.sh start online|offline  (re)create the one container; offline points the registry and
#                               Hugging Face at a closed port, so Ollaya itself downloads nothing
#                               during a run. It does NOT block outbound traffic: the container stays
#                               on an ordinary bridge network (it must, for the 127.0.0.1 port), so
#                               a process in it could still reach the internet. For a hard block,
#                               run on a --internal network and reach the container by its bridge IP.
#   host.sh pull NAME@sha256:D  pull one model by manifest digest (waits until done)
#   host.sh load NAME           load it (keep_alive -1) after checking MemAvailable >= MIN_AVAILABLE_GB;
#                               prints the cold-load time
#   host.sh unload NAME
#   host.sh peak                the container's cgroup memory.peak and its processes' summed VmHWM (bytes)
#   host.sh stop                stop the container (models stay on disk)
#   host.sh du                  disk used by EVAL_DIR
#
# Resource caps: CPU only (no device passed), --cpus CPUS (default 4, at most 4), --memory 5g, bound to
# 127.0.0.1, its own bridge network, a bearer key required. OLLAYA_MAX_LOADED_MODELS=1.
set -euo pipefail
EVAL_DIR=${EVAL_DIR:-/mnt/docker/appdata/cowork/eval/decisions}
IMAGE=${IMAGE:-ghcr.io/ollaya-dev/ollaya:0.13.0@sha256:31f749def61165d7bbb15def4e3d799a403461e0b8b777f359a924bb9b845ce6}
NAME=${NAME:-noevia-eval-decisions}
NET=${NET:-noevia-eval-decisions}
PORT=${PORT:-11535}
MIN_AVAILABLE_GB=${MIN_AVAILABLE_GB:-8}
CPUS=${CPUS:-4} # 1-4; the live Laya service is capped at 2, so 2 gives a like-for-like latency
URL="http://127.0.0.1:$PORT"

key() { cat "$EVAL_DIR/run/api-key"; }
api() { curl -fsS --max-time "${2:-30}" -H "Authorization: Bearer $(key)" -H 'Content-Type: application/json' "$URL$1" "${@:3}"; }
avail_gib() { awk '/^MemAvailable:/{printf "%d", $2/1048576}' /proc/meminfo; }

case "${1:-}" in
  setup)
    mkdir -p "$EVAL_DIR/models" "$EVAL_DIR/run" "$EVAL_DIR/results"
    chown 1000:1000 "$EVAL_DIR/models"
    chmod 700 "$EVAL_DIR/run"
    [ -s "$EVAL_DIR/run/api-key" ] || (umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$EVAL_DIR/run/api-key")
    (umask 077; printf 'OLLAYA_API_KEY=%s\n' "$(key)" > "$EVAL_DIR/run/env")
    docker network inspect "$NET" >/dev/null 2>&1 || docker network create --driver bridge "$NET" >/dev/null
    echo "setup ok: $EVAL_DIR, network $NET"
    ;;
  start)
    mode=${2:?online or offline}
    case "$CPUS" in 1|2|3|4) ;; *) echo "CPUS must be 1-4" >&2; exit 2 ;; esac
    extra=()
    if [ "$mode" = offline ]; then extra=(-e OLLAYA_REGISTRY=http://127.0.0.1:9 -e OLLAYA_HF_ENDPOINT=http://127.0.0.1:9); fi
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" --label noevia.eval=1639 \
      --network "$NET" -p "127.0.0.1:$PORT:11435" \
      --cpus "$CPUS" --memory 5g --memory-swap 5g --pids-limit 512 \
      --cap-drop ALL --security-opt no-new-privileges \
      --env-file "$EVAL_DIR/run/env" \
      -e OLLAYA_DEVICE=cpu -e OLLAYA_THREADS="$CPUS" -e OLLAYA_MAX_LOADED_MODELS=1 -e OLLAYA_KEEP_ALIVE=-1 \
      "${extra[@]}" \
      -v "$EVAL_DIR/models:/home/ollaya/.ollaya" \
      "$IMAGE" >/dev/null
    for _ in $(seq 1 30); do curl -fsS --max-time 2 "$URL/" >/dev/null 2>&1 && { echo "started ($mode)"; exit 0; }; sleep 1; done
    echo "the container did not answer within 30 s" >&2; exit 1
    ;;
  pull)
    model=${2:?NAME@sha256:DIGEST}
    case "$model" in *@sha256:*) ;; *) echo "pull by digest only" >&2; exit 2 ;; esac
    api /api/pull 3600 -d "{\"model\":\"$model\",\"stream\":false}"; echo
    ;;
  load)
    model=${2:?NAME}
    a=$(avail_gib)
    if [ "$a" -lt "$MIN_AVAILABLE_GB" ]; then echo "abort: ${a} GiB available, below ${MIN_AVAILABLE_GB} GiB" >&2; exit 3; fi
    api /api/decide 600 -d "{\"model\":\"$model\",\"keep_alive\":-1}" | jq -c '{model, done_reason, load_ms: (.load_duration/1e6|floor), total_ms: (.total_duration/1e6|floor)}'
    ;;
  unload)
    api /api/decide 60 -d "{\"model\":\"${2:?NAME}\",\"keep_alive\":0}" | jq -c '{model, done_reason}'
    ;;
  peak)
    id=$(docker inspect --format '{{.Id}}' "$NAME")
    cg=$(find /sys/fs/cgroup -maxdepth 4 -type d \( -name "$id" -o -name "docker-$id.scope" \) 2>/dev/null | head -1)
    peak=$(cat "$cg/memory.peak" 2>/dev/null || echo null)
    hwm=0
    for pid in $(docker top "$NAME" -eo pid | tail -n +2); do
      kb=$(awk '/^VmHWM:/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)
      hwm=$((hwm + ${kb:-0}))
    done
    printf '{"cgroupPeakBytes":%s,"vmHwmBytes":%s}\n' "$peak" "$((hwm * 1024))"
    ;;
  stop)
    docker stop "$NAME" >/dev/null && echo stopped
    ;;
  du)
    du -sb "$EVAL_DIR" "$EVAL_DIR/models" 2>/dev/null
    ;;
  *)
    sed -n '2,20p' "$0"; exit 2 ;;
esac
