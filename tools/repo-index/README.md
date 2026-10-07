# repo-index

Search tools for agents working **on** noevia. Development tooling: it is not part
of the product, is not reachable from `server`, and appears in no compose
file. It reads the working tree and never writes.

## Why

The server is split across area modules and route factories. Without a way to
ask *where* something is decided, the safe move is to read whole files — which is most
of what a session costs before any work starts.

`zilliztech/claude-context` solves this with Milvus plus a hosted embedding provider.
Neither is wanted here: noevia already runs its own embedding server and its own
sqlite-vec store, and a dev tool has no business adding infrastructure the product
does not need. So this is ripgrep plus a brace-counting outliner — no index to build,
no service to run, nothing to keep in sync with the working tree.

## Tools

- `search_code(query, k?, glob?)` — ripgrep, with each hit reported alongside the
  top-level declaration that encloses it and its line range, so you can read one function
  instead of a file. Nested helpers are reported under their enclosing factory.
- `outline_file(path)` — a file's top-level declarations with line ranges. Outline
  `server/toolboxes.cjs` and read only the range you need.

Both return a header line, then tab-separated rows with the column names first,
capped at the same 8,000 characters the product gives a tool result
(`server/tool-result-reduce.cjs`).

End lines come from brace counting, not a parser: they are wrong inside strings and
regexes, so they are advisory. The outline points you at a range to read; it does not
replace reading it.

## Running

Registered in the repo-root `.mcp.json`, so Claude Code picks it up automatically.
Requires `rg` on PATH and nothing else.

    node --test tools/repo-index/*.test.cjs

## Protocol

`initialize`, `tools/list`, `tools/call` over newline-delimited JSON-RPC on stdio —
the same three methods `server/mcp.cjs` implements on the client side, for
the same reason.
