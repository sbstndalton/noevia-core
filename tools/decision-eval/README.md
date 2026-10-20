# decision-eval (#1639)

An offline harness that compares decision models on the requests production sends to the private
decision service (`POST {COWORK_DECISION_URL}/v1/decisions`, `server/decision-endpoint.cjs`).
Synthetic cases only: no chats, no Diary.

| File | What it does |
| --- | --- |
| `cases/*.json` | Labelled synthetic cases per purpose and language (en, de, fr, es, it, nb, nl, pt, sv). `route.json` English reuses noevia-web `scripts/system-one-probe.cjs` and `system-one-probe-heldout{,2,3}.json` verbatim; the rest are new. Labels were written before any run. |
| `build-requests.cjs` | Drives the real callers (system-one-router, routing-modes sensitivity, tool-gate, step-supervision, chat-framing, load-advisor) with a capturing fetch, so each body is exactly what production would POST. The tool-gate requests need `dav-parse.wasm` (`server/wasm/` or `DAV_PARSE_WASM`): the gate's rules and option shaping are Rust only since #1071. Also adds `nocode` (route without the Code role) and `perm1`/`perm2` (options rotated, for the order-flip rate) and a stratified smoke subset. |
| `adapter.cjs` | Our `{state, question, options}` to a TypeSafe `choice` question and back: renormalises the 4-decimal probabilities, takes the argmax, refuses an exact tie, and checks the result with core's five contract rules. |
| `run.cjs` | Sends the requests one at a time to our contract (`--target laya`) or through the adapter (`--target ollaya`), records the raw scores and latency per request, resumes after a stop, and pauses when the idle gate closes. Dependency-free, so it runs with the host's Node. |
| `score.cjs` | Scores the raw outputs itself (it does not need core's `confidence`, see #1640): accuracy, macro-F1, ECE (10 bins) and Brier on the selected option's probability, risk-coverage at 0.6, p50/p95/max latency and misses over 1.3 s and 1.8 s, per purpose, per language, sensitive recall, escalations caught, and the order-flip rate. Writes JSON and markdown tables. |
| `split.cjs` | A fixed tuning/held-out split (phase A of #1639): stratified by purpose, language and label, seeded (mulberry32), about 60/40 by case; a case's `nocode`/`perm*` variants follow it. Wording is tuned on the tuning split only and measured on the held-out split. |
| `gate.sh` | Read-only idle gate for the inference host (auto-tune, chat activity, engine activity, Coding jobs, available memory). |
| `run-candidates.sh` | Runs every request against each candidate in turn, one loaded at a time, in a fresh offline container per candidate (so its memory peak is its own); gate and memory check before each load; resumable. |
| `host.sh` | The one resource-capped evaluation container (CPU only, 4 CPUs, 5 GB, 127.0.0.1, its own network): setup, start, pull by digest, load with a memory check, peak memory, stop. |

```sh
node build-requests.cjs --out requests.jsonl --smoke 20 --smoke-out smoke.jsonl           # standard wording (production default)
node build-requests.cjs --wording tuned --out requests-tuned.jsonl                              # tuned wording for Kev-0.8B (#1739); the old values laya and kev still work
node run.cjs --requests requests.jsonl --out laya.jsonl --target laya --url http://<laya>:8040 --min-interval-ms 1000 --gate ./gate.sh
node run.cjs --requests requests.jsonl --out decima.jsonl --target ollaya --url http://127.0.0.1:11535 --model decima:small --api-key-file <key> --warmup 3 --gate ./gate.sh
node score.cjs --out report.json --md report.md --rss rss.json laya.jsonl decima.jsonl
node split.cjs --requests requests.jsonl --seed 1639 --tune tune.jsonl --heldout heldout.jsonl
node score.cjs --temperature 0.6 --out kev.json --md kev.md kev-heldout.jsonl   # a model's fitted T, as its adapter applies it
```

`run.cjs` sends only to loopback or private IP literals (or `localhost`) unless `--allow-remote` is
given, since the requests and the Ollaya bearer key go to `--url`. `host.sh start offline` points
Ollaya's registry and Hugging Face endpoint at a closed port, so it downloads nothing during a run, but
it does not block outbound traffic: the container is on an ordinary bridge network so its port can be
published on 127.0.0.1. Use a `--internal` network for a hard block.

Limits: the sensitivity state carries a short synthetic stand-in for the system prompt (production's
`Context` section is the real one, usually longer); supervision states are first-round, read-only
rounds; the tool gate offers one fixed set of four read tools, so its labels are cut to 34 characters (44 before #1639's longer question)
as production would cut them for that set.
