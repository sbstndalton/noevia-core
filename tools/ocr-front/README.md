# Required native OCR front contracts (#1271)

Run from an assembled core/web checkout:

```sh
NOEVIA_OCR_FRONT_BIN=/absolute/rs/target/debug/noevia-server \
NOEVIA_OCR_NATIVE_BIN=/absolute/rs/target/debug/noevia-ocr \
NOEVIA_OCR_FIXTURE_SOURCE=/absolute/services/ocr \
node tools/ocr-front/run.cjs
```

Build the Rust inputs with `cargo build --locked -p noevia-server -p noevia-ocr --features native-ocr`. Install Node server dependencies and Tesseract (eng/deu), Poppler and Ghostscript. Missing inputs or engines fail; there is no skip path.

The dedicated CI job is unconditional for every PR. It uses the exact S3 draft dependency heads recorded in the workflow as acceptance test inputs; it does not change release pins or bypass the integration ancestry guard. Repository branch protection must require **Required native OCR front contracts** before merging this slice.

The harness starts the feature-probed `noevia-ocr` native binary on loopback (the only OCR owner; `NOEVIA_OCR_IMPL` is retired, #1071), then boots the actual Node server with the existing clean environment and outbound guard. It generates synthetic scan, DOCX, and oversized PDF bytes from standard-library fixture builders. No chat, model, coding, calibration, or autotune request is made. No live configuration or data is read.

Uploads are the Rust front's (sbstndalton/noevia#2191 round 8): the same HTTP requests run through the compiled Rust front and every contract is asserted on its answers (Node refuses the upload and has no reference answer to compare with). The front reads documents with Docling alone and reaches its workers by the variables Core's clients read, so the harness gives the front `OCR_BASE_URL` (the recording relay in front of the real native OCR worker) and `DOCLING_BASE_URL` (a synthetic Docling stand-in started by `run.cjs`: it reads a PDF's text layer with Poppler and answers each page `native`, or `ocr-needed` where there is none, as the synthetic `scan.pdf` has none; so the front must send that page to the OCR worker and recover its rows from there). With no Docling configured nothing is read, only queued. A DOCX goes to Docling when Docling is configured, as in production, so the worker's `/extract-docx` is covered by a separate front run with no `DOCLING_BASE_URL` (`only: 'docx'`). The relay counts the worker's `/extract`, `/extract-docx` and `/reduce-pdf` calls and forwards, without counting, the front's `GET /health` capability probe. Node saves projects.json through a loopback stand-in for the front's project store (tests/server/project-store-server.cjs), since it refuses to start without one. The accounts and their sessions are seeded in the data directory (tests/server/seed-account.cjs): sign-in is the Rust front's (sbstndalton/noevia#1071), not Node's. The front itself, not Node, dispatches `/extract` (with the selected `X-OCR-Pages` header), `/extract-docx` and `/reduce-pdf` to the native worker through the relay, which records and checks all three routes, the selected OCR page header and the reduction input above 25 MiB. Ready OCR status and every synthetic financial row are required. Persisted DOCX and reduction content are checked. Complete upload/page response contracts and source content/metadata must match; asynchronous RAG indexing progress is omitted and Ghostscript output identities are bound consistently across runs (its generated PDF metadata changes the byte hash). Output sizes, reduction shape, extracted text, and identity relationships are still checked. Tenant page/original/upload/sync/folder-plan refusals must produce 404 without calling the worker.

Two additional fresh Rust-front runs inject a 503 and a plausible incorrect OCR transcription at the relay. Both must fail the exact scan oracle used by positive coverage. A boot or setup failure cannot satisfy these controls. They prove worker omission/outage and incorrect recognized content cannot pass the positive gate. The positive relay forwards to the real native worker; the controls deliberately do not.

Processes, private fixture files and tenant stores are removed in `finally`. These are equivalent front document contract cases, not a refresh of the broad Rust replay corpus. Existing replay remains a separate gate; service-level differential alone does not satisfy this test.
