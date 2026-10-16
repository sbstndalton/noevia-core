# DAV QA matrix (noevia#263)

`dav-matrix.cjs` runs the DAV interoperability matrix against a throwaway QA account and prints a
results table. It needs no dependencies (Node 22, built-in `fetch`). The account comes from the
environment only:

| Variable | Meaning |
|---|---|
| `NOEVIA_QA_DAV_URL` | collection root, e.g. `https://<nextcloud>/remote.php/dav/files/noevia-qa/` |
| `NOEVIA_QA_DAV_USER` | the QA user; must contain "qa" (override: `NOEVIA_QA_ALLOW_ANY_USER=1`); admin names are refused |
| `NOEVIA_QA_DAV_APP_PASSWORD` | an app password for that user |
| `NOEVIA_QA_DAV_LARGE_MB` | optional, large-file size in MiB (default 8, max 256) |

```sh
# Local file outside any repo, owner-only:
mkdir -p ~/.config/noevia-qa && chmod 700 ~/.config/noevia-qa
$EDITOR ~/.config/noevia-qa/dav.env && chmod 600 ~/.config/noevia-qa/dav.env

node tools/dav-qa/dav-matrix.cjs --env-file ~/.config/noevia-qa/dav.env --dry-run   # plan + env check, no requests
node tools/dav-qa/dav-matrix.cjs --env-file ~/.config/noevia-qa/dav.env             # the run
node tools/dav-qa/dav-matrix.cjs --env-file ~/.config/noevia-qa/dav.env --json      # machine-readable
```

Rows: list (PROPFIND Depth 0/1), text and binary read, large file (with Range report), unicode and
space names, nested folders, ETag change detection (stale `If-Match` 412, `If-None-Match: *` 412),
401 with a wrong password (exactly one wrong attempt is sent, to stay clear of brute-force
throttling), and cleanup. Everything lives in one folder `noevia-qa-matrix-<utc>-<rand>` under the
URL root, deleted at the end and also after failed rows. Exit code 0 = all pass, 1 = a row failed,
2 = bad configuration. If cleanup itself fails the folder name is printed to delete by hand.

`fake-dav.cjs` is an in-memory DAV server for rehearsing without an account
(`node tools/dav-qa/fake-dav.cjs` prints matching env values). Tests: `node --test tools/dav-qa/*.test.cjs`.
