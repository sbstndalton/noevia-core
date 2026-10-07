# The coding sandbox: an ACP harness, and nothing else.
#
# Deliberately not the web image. That one carries noevia's server, its state directory and its
# credentials, and a coding agent has no business near any of them. This image holds a harness,
# a supervisor and a Node runtime.
#
# The harness is pinned. An agent that updates itself under you is a supply-chain change you did
# not review, in the one container allowed to run arbitrary commands.
# sandbox-bridge.wasm (#999): the Rust/WebAssembly port of the bridge's framing, toolCallFor, start
# line and containment decision, used only with SANDBOX_BRIDGE_IMPL=rust. sandbox-bridge.lock pins the
# noevia-rs ref, its tarball sha256 and the module sha256; the tarball is checked before anything is
# built and the module after (the same recipe as the web image's dav-parse.wasm).
FROM node:22-bookworm-slim AS sandbox-bridge-src
COPY sandbox-bridge.lock /lock
RUN set -e; eval "$(grep -E '^(NOEVIA_RS_REF|NOEVIA_RS_SHA256)=[0-9a-f]+$' /lock)"; \
    node -e 'fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);return r.arrayBuffer()}).then(b=>require("fs").writeFileSync("/rs.tgz",Buffer.from(b))).catch(e=>{console.error(e.message);process.exit(1)})' \
      "https://codeload.github.com/sbstndalton/noevia-rs/tar.gz/$NOEVIA_RS_REF"; \
    echo "$NOEVIA_RS_SHA256  /rs.tgz" | sha256sum -c -; \
    mkdir /rs && tar -xzf /rs.tgz --strip-components=1 -C /rs && rm /rs.tgz

FROM rust:1.99-slim-bookworm AS sandbox-bridge
ENV RUSTUP_TOOLCHAIN=1.99.0 CARGO_TERM_COLOR=never
COPY --from=sandbox-bridge-src /rs /src
COPY sandbox-bridge.lock /lock
WORKDIR /src
RUN set -e; rustup target add wasm32-unknown-unknown; \
    tools/build-sandbox-bridge-wasm.sh /out/sandbox-bridge.wasm; \
    echo "$(sed -n 's/^SANDBOX_BRIDGE_WASM_SHA256=//p' /lock)  /out/sandbox-bridge.wasm" | sha256sum -c -

FROM node:22-bookworm-slim

ARG HARNESS_PACKAGE=opencode-ai
ARG HARNESS_VERSION=1.18.31
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && if [ "$HARNESS_PACKAGE" = "@earendil-works/pi-coding-agent" ]; then \
      npm install -g --ignore-scripts --no-fund --no-audit "${HARNESS_PACKAGE}@${HARNESS_VERSION}"; \
    else \
      npm install -g --no-fund --no-audit "${HARNESS_PACKAGE}@${HARNESS_VERSION}"; \
    fi \
 && npm cache clean --force

WORKDIR /srv
# pi-acp-bridge.cjs: noevia's own ACP bridge for pi (routes pi's approvals to noevia). Used only
# when the image installs pi (HARNESS_PACKAGE=@earendil-works/pi-coding-agent) and runs with
# CODE_HARNESS_COMMAND=node CODE_HARNESS_ARGS=/srv/pi-acp-bridge.cjs and CODE_HARNESS_NAME=pi on web.
# verifier.cjs: the server-measured test runner (#703). Runs ONLY in the separate `code-verify`
# container (uid 1002, no network, workspaces read-only); never started in the agent sandbox.
COPY supervisor.cjs pi-acp-bridge.cjs verifier.cjs ./
# SANDBOX_BRIDGE_IMPL=rust (#999; default js): the loader, its lock and the checked module. Read-only
# like everything else here; the loader re-checks the module's sha256 against the lock at startup.
COPY sandbox-bridge-wasm.cjs sandbox-bridge.lock ./
COPY --from=sandbox-bridge /out/sandbox-bridge.wasm ./wasm/sandbox-bridge.wasm
# The verifier's socket directory: root's, 0770, so a fresh named volume inherits that owner and
# neither the agent (1000), git (1002) nor the test command (1003) can enter it. Web connects as
# root. Mount points for the verifier's tmpfs copies exist in the read-only root.
RUN mkdir -p /run/noevia-verify /verify/copy /verify/run && chown 0:0 /run/noevia-verify && chmod 0770 /run/noevia-verify

# `node` (uid 1000) already exists in this image. Nothing here runs as root.
USER node
ENV PORT=8030 \
    WORKSPACE_ROOT=/workspaces \
    CODE_HARNESS_COMMAND=opencode \
    CODE_HARNESS_ARGS=acp \
    HARNESS_VERSION=${HARNESS_VERSION}
EXPOSE 8030

# No health check on purpose: a connection to this port starts an agent, so probing it would
# start one every thirty seconds. Compose watches the process instead.
CMD ["node", "supervisor.cjs"]
