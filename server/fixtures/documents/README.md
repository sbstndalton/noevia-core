# Synthetic document fixtures

All content is invented. No private statements, diary data or external assets.
See `docs/spec-document-understanding.md` at the repository root for the audit.

`generate.py` regenerates the PDFs and statement PNG using ReportLab, Pillow and
pypdf (development tools only). The encrypted PDF uses `fixture-password`.
`malformed.pdf` deliberately is not a valid PDF. `long.pdf` has 110 synthetic
pages to exceed the extractor's 200,000-character result cap.

The scan marker is `SCAN-P2`, its invoice is `INV-2042`, amounts are `42.15`
and `-7.20`, and total is `34.95`. Digital text uses marker `TEXT-P1`.
`mixed-pages.pdf` puts the scan on page 2; `mixed-page.pdf` has a digital
header above a scan on page 1. No actual OCR engine was run on these fixtures.
