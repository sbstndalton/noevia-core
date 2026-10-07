# code-sandbox

The container a coding harness runs in, and the ~100-line supervisor that starts it.

Code mode's rules live in noevia (`apps/web/server/code-*.cjs`): what a task may do, what needs
a human's answer, which paths it may write. **This container is what makes those rules hold when
the harness ignores them** — and the ACP spike showed one that did: with default settings
OpenCode wrote a file without asking, and every approved command ran in its own process rather
than through the client's terminal API. ACP events are evidence of intent; the container is the
boundary.

## What it is

`supervisor.cjs` accepts one connection, reads one line from noevia naming the worktree, spawns
the harness, and pipes. Everything after that first line is the ACP stream, byte for byte. It
decides nothing about permissions, paths or tools.

It does constrain what it is told:

- **`cwd` must resolve inside `WORKSPACE_ROOT`** after `realpath`, so a symlink cannot point out.
- **Only an allowlist of environment variables** is accepted (`HOME`, `PATH`, `LANG`, `TMPDIR`
  and the proxy variables). Nothing of the supervisor's own environment is passed on.
- **The connection is the lifetime.** Hanging up — a cancelled task, a restarted web container —
  kills the agent's process group. noevia never reaches across the container boundary.

There is no authentication, on purpose. The port is on an internal network with one member; a
deployment where anything else can reach it has already lost, and a shared secret in an
environment variable would imply otherwise. `deploy/examples/code-sandbox.override.yml` is the
control: read-only root, `cap_drop: ALL`, no-new-privileges, uid 1000, tmpfs `/tmp` and `$HOME`,
bounded memory and pids, one volume, no `ports:`.

## The verifier (#703)

The pipeline's "do the tests pass?" is answered by `verifier.cjs`, not by the agent, and **not in
this container**. It ships in the same image but runs as its own service, `code-verify` (see
`deploy/examples/code-sandbox.override.yml`). The agent runs here as uid 1000 with a writable
`/tmp` and `HOME`, so anything it leaves behind could otherwise reach the run that judges it: a
process that outlived its turn, an `.npmrc` `script-shell`, a `.gitconfig`, a `.pth`, or a swapped
loose object.

- **Its own container:** no network (`network_mode: none`). Web reaches it over a unix socket on a
  volume only web and the verifier mount. The workspaces volume is mounted read-only, the root
  filesystem is read-only, it has its own tmpfs, and pids/memory/CPU are limited. The agent
  sandbox has no verify mode.
- **Three identities, so the test never shares a uid with anything that matters:**
  - The **server** starts as root with `cap_drop: ALL` plus only `SETUID`/`SETGID`, and
    no-new-privileges. It owns the socket and its directory (root, 0770) and never runs git or
    repository code.
  - **git** runs as 1002, with the repositories' shared group, for the copy.
  - The **test command** runs as 1003, so it cannot signal the server, enter the socket
    directory, or write or chmod the copy, which belongs to 1002 and is read-only.
- **One-shot:** the verifier serves exactly one request, then exits, and `restart: always` brings it
  back with empty tmpfs. Every process a test left behind, even one that escaped with `setsid`, dies
  with the container. Before that, after the copy step and after the command, every process of the
  uid that just ran is killed (`kill -9 -1` run *as* that uid, which needs no capability). The
  answer is sent only after that cleanup. Web retries the connection for a few seconds while the
  verifier restarts, then reports `busy`.
- **The command is the operator's:** `CODE_VERIFY=name|command` (one per line, names as in web's
  `CODE_REPOS`), set only on `code-verify`. noevia sends a repository name, the source path, the
  commit and a per-request **nonce** (echoed back, so a stale answer is rejected). It never sends a
  command, and nothing in the repository decides what runs.
- **A verified copy:**
  - The source's `.git/config` is **copied**, and the copy is checked for anything git would run.
  - Then `git clone --no-local` (index-pack recomputes every object id) runs with
    `GIT_CONFIG_NOSYSTEM`, a global config the server wrote, a HOME git cannot write, and
    `-c`/`--config` overrides.
  - `git fsck` runs on the copy, and HEAD and its tree must equal the requested commit.
  - upload-pack runs inside the source and reads its live config, which the copy-and-check cannot
    freeze. git ignores `uploadpack.packObjectsHook` from repository config. Anything else a
    swapped config could start runs as the git uid, with no network, and is killed before the copy
    is used; fsck and the HEAD/tree checks cover what it could do to the copy.
- **The run:** fixed environment: `PATH`, `LANG`, `CI`, `NO_COLOR`, and the test uid's own
  `HOME`/`TMPDIR`; no proxy variables. Stdin is closed, core dumps are off, CPU is limited per
  process, and `CODE_VERIFY_WALL_MS` (default 10 min) covers the copy and the run. The output tail
  (16 KiB by default) comes back inside one JSON line.

Tests that write must use `$TMPDIR` (the copy is read-only). With no network, the repository must
run without installing dependencies. git inside the tests sees a repository owned by another uid.

**Shipping it** needs a code-sandbox image release (new `verifier.cjs`, socket and tmpfs
directories) **and** the new `code-verify` container. See `docs/deployment.md` under Code mode.

## Why not the Docker socket

Running `docker run` per task from the web container would mean giving that container the Docker
socket. `docs/research-master-container.md` recorded a socket holder reachable without
authentication as the highest-severity finding open on this deployment. A sidecar on an internal
network gives the same isolation and adds no such power.

## Two things staging this proved

Both were found by building the image on DaServer and running the escape probes against it,
before any harness run:

- **The worktrees must be on the shared volume**, not in the tenant's state directory. noevia
  sends an absolute path and the supervisor resolves that same path, so they have to be the same
  path: one volume, one mount point, both containers. `CODE_WORKSPACE_ROOT` does this.
- **A fresh workspace is root-owned and the sandbox is not root**, so the harness could not write
  the tree it was given (`write /workspaces: Permission denied` in the probes).
  `CODE_HARNESS_USER=1000:1000` hands each one over as it is created, and a handover that fails
  refuses the task rather than starting a harness that cannot work.
- **A handed-over git *worktree* cannot commit.** A worktree keeps its objects and refs in the
  source repository's `.git`, which the harness cannot write — proven here: read, edit and `git
  status` all worked, `git commit` failed. So with a separate harness user noevia gives the task a
  `git clone --shared` instead: a repository it fully owns, with the source read-only to it and no
  objects copied (120 KB for the scratch fixture). On release noevia fetches the branch back into
  the source, never forced — a branch that would not fast-forward is a conflict for a human. A
  fetch that fails keeps the clone and marks the claim stuck, because a task's work is not ours to
  discard quietly.
- **The `$HOME` tmpfs needs `uid=1000,gid=1000`** or the harness cannot write its own
  `.gitconfig`; a bare `mode=0700` tmpfs belongs to root.

## Running it

Built and started only with the `code` profile; see the override file's header for the
environment the web container needs. `CODE_HARNESS_ENDPOINT` takes precedence over
`CODE_HARNESS_COMMAND`, so a deployment that has a sandbox cannot silently fall back to running
the agent beside noevia's own state.

The harness version is pinned as a build argument. An agent that updates itself is a
supply-chain change nobody reviewed, in the one container allowed to run arbitrary commands.

## pi (not installed by default)

pi has no permission prompts of its own and speaks JSONL RPC rather than ACP. noevia pins it with
a gate extension written into the task's `~/.pi/agent/` (`server/code-harness-config.cjs`) and
bridges it with `pi-acp-bridge.cjs`, which turns the gate's confirm into an ACP
`session/request_permission`, so pi's commands reach the same approval card as any harness. The
bridge can only turn a question into "no" by itself. Installing pi in this image is the user's
decision (a supply-chain change); see docs/spec-agent-execution.md.

## SANDBOX_BRIDGE_IMPL=js|rust (#999)

The bridge's and the supervisor's untrusted-input handling has a Rust port, built from
sbstndalton/noevia-rs (`crates/sandbox-bridge`, `bins/sandbox-bridge-wasm`) into
`wasm/sandbox-bridge.wasm` by this image's own build stage. `sandbox-bridge.lock` pins the noevia-rs
ref, the tarball's sha256 and the module's sha256. The default is `js`; set
`SANDBOX_BRIDGE_IMPL=rust` on the sandbox container to switch. Any other value means js, with one
warning in the log. The supervisor reads the flag and passes it to the agent it starts, and
`pi-acp-bridge.cjs` removes it again before starting pi.

What goes through the module under `rust`:

- `pi-acp-bridge.cjs`: `lines()`, the JSONL framing of pi's output and the client's messages
  (state per stream, inside the module). Node still runs `JSON.parse` on every line the module
  hands back, so a message's value (duplicate keys, numbers, `__proto__`) is the JS one.
- `pi-acp-bridge.cjs`: `toolCallFor()`, the tool call noevia classifies and approves.
- `supervisor.cjs`: the start line (`parseStartJs`) and `insideRoot`'s decision (`containedJs`).
  The `realpathSync` of both paths stays in Node, because symlinks belong to the filesystem, not
  to the string. Only the comparison of the two real paths is ported.

It is WebAssembly and not a separate binary because framing runs once per stream chunk and
`toolCallFor` once per tool call. A process per call would cost milliseconds per message, and a
long-lived child would need its own framing in front of it. The module runs in-process, with no
imports, under Node's built-in WebAssembly.

It fails closed. A missing module, a checksum or ABI mismatch, a trap, a malformed reply, or a line
the module passed that `JSON.parse` refuses has these effects:

- the bridge ends the session with "the sandbox bridge (rust) failed; closing the session" and
  refuses everything pending (a bridge that cannot load the module at all exits after one
  JSON-RPC error with the same text);
- the supervisor refuses the connection with "the sandbox bridge is unavailable" and starts
  nothing.

Nothing falls back to JS, and no failure can become a permission.

Differential fixtures come from the JS references
(`node tools/gen-sandbox-bridge-fixtures.cjs > tests/fixtures/sandbox-bridge.v1.json`). The file
is byte-identical to noevia-rs's `crates/sandbox-bridge/tests/fixtures/sandbox-bridge.v1.json`.
CI compares the two, rebuilds the module at the pinned ref, and runs
`sandbox-bridge-wasm.test.cjs` against it (fixtures, seeded random input, live bridge and
supervisor sessions, and failure cases).

One difference from JS is known:

- `String()` of arrays nested more than 1,000 levels deep fails closed. V8 throws at about 5,000.
