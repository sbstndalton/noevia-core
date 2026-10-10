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

The harness starts the feature-probed `noevia-ocr` native binary on loopback with `NOEVIA_OCR_IMPL=rust`, then boots the actual Node server with the existing clean environment and outbound guard. It generates synthetic scan, DOCX, and oversized PDF bytes from standard-library fixture builders. No chat, model, coding, calibration, or autotune request is made. No live configuration or data is read.

It records document contract response bodies against Node, then performs the same HTTP requests through the compiled Rust front (`NOEVIA_RUST_AUTH=0`, `NOEVIA_RUST_PROJECTS=0`, matching the current front stage). Upload/extraction routes remain Node-owned: Rust forwards authenticated HTTP requests to Node, which dispatches `/extract`, `/extract-docx`, and `/reduce-pdf` to the native worker. The relay records and checks all three routes, the actual selected OCR page header, and reduction input above 25 MiB. Ready OCR status and every synthetic financial row are required. Persisted DOCX and reduction content are checked. Complete upload/page response contracts and source content/metadata must match; only asynchronous RAG indexing progress is omitted. Tenant page/original/upload refusals must produce 404 without calling the worker.

Two additional fresh Rust-front runs inject a 503 and a plausible incorrect OCR transcription at the relay. Both must fail the exact scan oracle used by positive coverage. A boot or setup failure cannot satisfy these controls. They prove worker omission/outage and incorrect recognized content cannot pass the positive gate. The positive relay forwards to the real native worker; the controls deliberately do not.

Processes, private fixture files and tenant stores are removed in `finally`. These are equivalent front document contract cases, not a refresh of the broad Rust replay corpus. Existing replay remains a separate gate; service-level differential alone does not satisfy this test.
