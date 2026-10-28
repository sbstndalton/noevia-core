#!/bin/sh
# Fixed, source-only supervisor selector. This is CMD, not ENTRYPOINT:
# code-verify's explicit native command bypasses this sandbox-only selector.
set -eu

fail() {
    printf '%s\n' "code-sandbox: $1" >&2
    exit 2
}

case "${CODE_SANDBOX_SUPERVISOR_IMPL-node}" in
    node)
        exec /usr/local/bin/node /srv/supervisor.cjs
        ;;
    rust)
        supervisor=/usr/local/libexec/noevia/code-sandbox-supervisor
        helper=/usr/local/libexec/noevia/code-sandbox-session-exec
        [ -f "$supervisor" ] && [ -x "$supervisor" ] && [ ! -L "$supervisor" ] ||
            fail "native supervisor is unavailable"
        [ -f "$helper" ] && [ -x "$helper" ] && [ ! -L "$helper" ] ||
            fail "native session helper is unavailable"
        [ "${SANDBOX_BRIDGE_IMPL:-}" = rust ] ||
            fail "native supervisor requires SANDBOX_BRIDGE_IMPL=rust"
        # Only image-reviewed harness paths are accepted. Never resolve the
        # client or operator PATH when selecting what the supervisor execs.
        case "${CODE_HARNESS_COMMAND:-}" in
            opencode|/usr/local/bin/opencode)
                harness=/usr/local/bin/opencode
                ;;
            node|/usr/local/bin/node)
                harness=/usr/local/bin/node
                ;;
            *)
                fail "native harness command is not an image-reviewed path"
                ;;
        esac
        [ -f "$harness" ] && [ -x "$harness" ] ||
            fail "native harness executable is unavailable"
        export CODE_HARNESS_COMMAND="$harness"
        /usr/local/bin/node -e 'require("/srv/sandbox-bridge-wasm.cjs").ensure()' ||
            fail "pinned sandbox bridge preflight failed"
        exec "$supervisor"
        ;;
    *)
        fail "unknown CODE_SANDBOX_SUPERVISOR_IMPL"
        ;;
esac
