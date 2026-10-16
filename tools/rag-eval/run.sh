#!/bin/bash
# noevia#1866 chunker eval runner for DaServer. Throwaway containers only (rr3-*, --rm, exact names, <= 2 CPU / 2 GB).
#   W=<workdir> SRC=<dir with chunk-eval.cjs + dataset.json> run.sh [smoke|full|clean]
# smoke: all arms, embed + gte rerank, hard deadline 15 min. full: same, deadline 3 h (the coordinator schedules it off-hours).
# Live services are read only: the live embed service gets throttled embedding requests (paused while chat is active);
# rerank uses its OWN gte TEI container (rr3-gte, --network none), never cowork-rerank-1. No downloads (--pull never;
# the gte model must already be on disk). Never prunes; removes only rr3-* containers by exact name. Stop: touch $W/out/ABORT
set -u
MODE=${1:-smoke}
W=${W:-/mnt/docker/appdata/cowork/eval/chunk1866}
SRC=${SRC:-$(dirname "$0")}
ARMS=${ARMS:-A,B,C,D,E,F}
FBASE=${FBASE:-D}
EMBED_MODEL=${EMBED_MODEL:-embeddinggemma-2-Q8_0}   # the id the live embed service lists (EmbeddingGemma 2; EG2 framing is the harness default)
NODE=node:22-bookworm-slim
TEI=ghcr.io/huggingface/text-embeddings-inference:cpu-1.9
S=/mnt/user/ai-models/rerank-eval/onnx-community_gte-multilingual-reranker-base/ee64367e35a2db0da46bb6497e13a18f8bd585cb
NAMES="rr3-embed rr3-gte rr3-client rr3-score rr3-hc"
case $MODE in smoke) DEADLINE=$(( $(date +%s) + 900 )); EBUDGET=480; RBUDGET=300 ;; full) DEADLINE=$(( $(date +%s) + 10800 )); EBUDGET=2400; RBUDGET=7200 ;;
  clean) for n in $NAMES; do docker rm -f $n >/dev/null 2>&1; done; echo cleaned; exit 0 ;; *) echo "smoke|full|clean"; exit 2 ;; esac
mkdir -p $W/bin $W/data $W/out; LOG=$W/out/run.log
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a $LOG; }
left() { echo $(( DEADLINE - $(date +%s) )); }
avail_mib() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
gtt_mib() { local m=0 f v; for f in /sys/class/drm/card*/device/mem_info_gtt_used; do [ -r "$f" ] || continue; v=$(( $(cat $f) / 1048576 )); [ "$v" -gt "$m" ] && m=$v; done; echo $m; }
chat_events() { docker logs --since "$1" cowork-llama-1 2>&1 | grep -ciE "launch_slot|print_timing|prompt eval"; }
cleanup() { for n in $NAMES; do docker rm -f $n >/dev/null 2>&1; done; touch $W/out/DONE; rm -f $W/out/PAUSE; }
trap cleanup EXIT

gate() {
  local busy g a; busy=$(chat_events 3m); g=$(gtt_mib); a=$(avail_mib)
  [ "$busy" = 0 ] || { log "GATE_FAIL llama busy=$busy"; return 1; }
  [ "$g" -le 1024 ] || { log "GATE_FAIL GTT=${g}MiB > 1024"; return 1; }
  [ "$a" -ge 8192 ] || { log "GATE_FAIL MemAvailable=${a}MiB < 8192"; return 1; }
  grep -lsE '"status":"(running|queued|starting)"' /mnt/docker/appdata/cowork/state/web/native-autotune-*.json >/dev/null && { log "GATE_FAIL autotune running"; return 1; }
  pgrep -f 'preflight/up.sh|compose.* up' >/dev/null && { log "GATE_FAIL compose up running"; return 1; }
  local docw; docw=$( { docker logs --since 3m cowork-docling-1 2>&1; docker logs --since 3m cowork-ocr-1 2>&1; } | grep -vciE 'GET /health|healthz|^\s*$')
  local webw; webw=$(docker logs --since 3m cowork-web-1 2>&1 | grep -ciE 'extract|indexProject|reindex|indexing|docling')
  [ "$docw" = 0 ] && [ "$webw" = 0 ] || { log "GATE_FAIL document work in progress (docling/ocr lines=$docw, web index lines=$webw)"; return 1; }
  for n in $NAMES; do docker ps -a --format '{{.Names}}' | grep -qx $n && { log "GATE_FAIL leftover container $n"; return 1; }; done
  [ -e $W/out/ABORT ] && { log "GATE_FAIL ABORT"; return 1; }
  log "GATE_OK busy=0 GTT=${g}MiB MemAvailable=${a}MiB"
}
guard() { # $1 container: records cgroup peak, kills on host MemAvailable < 6 GiB or ABORT; ends with the container or the deadline
  local c=$1 id; for i in $(seq 1 20); do id=$(docker inspect -f '{{.Id}}' $c 2>/dev/null) && break; sleep 0.5; done; [ -n "${id:-}" ] || return
  local cg=/sys/fs/cgroup/docker/$id minav=999999 pk=0
  while [ "$(left)" -gt 0 ] && docker inspect -f '{{.State.Running}}' $c 2>/dev/null | grep -q true; do
    local a p; a=$(avail_mib); p=$(( $(cat $cg/memory.peak 2>/dev/null || echo 0) / 1048576 )); [ $p -gt $pk ] && pk=$p; [ $a -lt $minav ] && minav=$a
    echo "$c cgroup_peak_MiB=$pk min_host_avail_MiB=$minav" > $W/out/guard-$c.txt
    [ $a -lt 6144 ] && { log "BREACH MemAvailable=${a}MiB, killing $c"; docker kill $c >/dev/null; touch $W/out/BREACH; return; }
    [ -e $W/out/ABORT ] && { log "ABORT, killing $c"; docker kill $c >/dev/null; return; }
    sleep 1
  done
}
watch_chat() { # PAUSE while chat is active (the harness waits between embed requests); counts what it saw
  : > $W/out/chat-seen.txt
  while [ ! -e $W/out/DONE ] && [ "$(left)" -gt 0 ]; do
    local n; n=$(chat_events 20s)
    if [ "$n" -gt 0 ]; then [ -e $W/out/PAUSE ] || log "CHAT activity ($n events), pausing embeds"; touch $W/out/PAUSE; echo "$(date -u +%H:%M:%S) $n" >> $W/out/chat-seen.txt
    elif [ -e $W/out/PAUSE ]; then log "chat idle, resuming"; rm -f $W/out/PAUSE; fi
    sleep 5
  done
}
hrun() { # $1 name $2 network $3 cpus $4 mem $5 timeout-s, rest = chunk-eval.cjs args
  local n=$1 net=$2 cpus=$3 mem=$4 to=$5; shift 5
  [ "$to" -gt "$(left)" ] && to=$(left); [ "$to" -le 0 ] && { log "DEADLINE before $n"; return 9; }
  timeout $to docker run --rm --pull never --name $n --network $net --cpus $cpus --memory $mem --memory-swap $mem \
    -v $W/bin:/bin2:ro -v $W/data:/data:ro -v $W/out:/out $NODE node /bin2/chunk-eval.cjs "$@" 2>&1 | tee -a $LOG
  local rc=${PIPESTATUS[0]}; docker rm -f $n >/dev/null 2>&1; return $rc
}

cp -f $SRC/chunk-eval.cjs $W/bin/ && cp -f $SRC/dataset.json $W/data/ || { log "FATAL payload missing in $SRC"; exit 4; }
[ -f $S/onnx/model_int8.onnx ] || { log "NO_RERANK_MODEL: gte files not on disk; running cosine arms only"; NORERANK=1; }
docker image inspect $NODE >/dev/null 2>&1 && docker image inspect $TEI >/dev/null 2>&1 || { log "FATAL image missing (no pulls allowed)"; exit 4; }
T0=$(date +%s); log "START $MODE arms=$ARMS fbase=$FBASE dataset sha256 $(sha256sum $W/data/dataset.json | cut -c1-16)"
gate || exit 3
watch_chat & WP=$!

# 1. embed (live embed service, read only, throttled; network cowork_default only to reach http://embed:8080)
( sleep 1; guard rr3-embed ) & G1=$!
hrun rr3-embed cowork_default 1 1g $EBUDGET embed /data/dataset.json /out http://embed:8080/v1 --model=$EMBED_MODEL --arms=$ARMS --fbase=$FBASE --dim=768 --budget=$EBUDGET; ERC=$?
wait $G1; log "EMBED rc=$ERC $(cat $W/out/guard-rr3-embed.txt 2>/dev/null)"
[ $ERC = 0 ] || { log "STOP: embed failed"; touch $W/out/DONE; wait $WP; exit 5; }

# 2. rerank with a separate gte TEI eval container (same flags as the live one; offline, no network)
if [ -z "${NORERANK:-}" ] && gate; then
  TL0=$(date +%s.%N)
  docker run -d --rm --pull never --name rr3-gte --network none --cpus 2 --memory 2g --memory-swap 2g \
    -v $S/onnx/model_int8.onnx:/model/onnx/model.onnx:ro -v $S/config.json:/model/config.json:ro -v $S/tokenizer.json:/model/tokenizer.json:ro \
    -v $S/tokenizer_config.json:/model/tokenizer_config.json:ro -v $S/special_tokens_map.json:/model/special_tokens_map.json:ro \
    -e HF_HUB_OFFLINE=1 $TEI --model-id /model --hostname 127.0.0.1 --port 8080 --auto-truncate --max-batch-tokens 2048 --max-client-batch-size 64 >/dev/null
  guard rr3-gte & G2=$!
  ok=0; for i in $(seq 1 120); do   # health wait, at most 120 x 1 s
    timeout 10 docker run --rm --pull never --name rr3-hc --network container:rr3-gte $NODE node -e 'fetch("http://127.0.0.1:8080/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1 && { ok=1; break; }
    docker rm -f rr3-hc >/dev/null 2>&1; docker inspect rr3-gte >/dev/null 2>&1 || break; sleep 1; done
  log "LOAD rr3-gte ok=$ok cold_load_s=$(awk -v a=$TL0 -v b=$(date +%s.%N) 'BEGIN{printf "%.1f", b-a}')"
  if [ $ok = 1 ]; then hrun rr3-client container:rr3-gte 1 512m $RBUDGET rerank /data/dataset.json /out http://127.0.0.1:8080 --arms=$ARMS --budget=$RBUDGET; log "RERANK rc=$?"; fi
  docker logs rr3-gte > $W/out/server-rr3-gte.log 2>&1; docker stop -t 10 rr3-gte >/dev/null 2>&1; docker rm -f rr3-gte >/dev/null 2>&1; wait $G2
  log "GUARD $(cat $W/out/guard-rr3-gte.txt 2>/dev/null)"
else log "rerank arms skipped"; fi

# 3. score (no network)
hrun rr3-score none 1 512m 120 score /data/dataset.json /out
touch $W/out/DONE; wait $WP
log "END runtime_s=$(( $(date +%s) - T0 )) chat_seen_intervals=$(wc -l < $W/out/chat-seen.txt) llama_events_during_run=$(chat_events $(( $(date +%s) - T0 + 5 ))s)"
