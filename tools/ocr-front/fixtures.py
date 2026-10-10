"""Synthetic fixtures only; reuse the services real-engine scan generator."""
import importlib.util
import sys
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True
source, destination = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location('synthetic', source / 'synthetic_pdfs.py')
synthetic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(synthetic)
destination.mkdir(parents=True, exist_ok=True)
(destination / 'scan.pdf').write_bytes(synthetic.pdf([{'scan': synthetic.ROWS}]))
(destination / 'large.pdf').write_bytes(synthetic.oversized_text_pdf())
with zipfile.ZipFile(destination / 'body.docx', 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SYNTHETIC DOCX REF 1271</w:t></w:r></w:p></w:body></w:document>')
