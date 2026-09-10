"""Synthetic audit fixtures only. Requires reportlab, Pillow and pypdf for regeneration.
No user files, network access, or production state. Run from any directory.
"""
from pathlib import Path
from io import BytesIO
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter

root = Path(__file__).resolve().parent
scan = Image.new('RGB', (1200, 700), 'white')
draw = ImageDraw.Draw(scan)
font = ImageFont.load_default(size=32)
for y, text in enumerate(['SYNTHETIC SCANNED STATEMENT', 'Page marker SCAN-P2', 'Invoice INV-2042',
                           'Date       Item         Amount', '2042-01-02 Utilities    42.15',
                           '2042-01-03 Refund       -7.20', 'TOTAL                  34.95']):
    draw.text((45, 40 + y * 85), text, fill='black', font=font)
scan.save(root / 'statement.png')

def new(name):
    return canvas.Canvas(str(root / name), pagesize=(612, 792), invariant=1)
def text_page(c):
    c.setFont('Helvetica', 14)
    for y, line in enumerate(['SYNTHETIC TEXT STATEMENT', 'Page marker TEXT-P1', 'Account FIXTURE-0001',
                              'Date                 Item                         Amount',
                              '2042-01-02       Utilities                     42.15',
                              '2042-01-03       Refund                       -7.20',
                              'TOTAL                                                34.95']):
        c.drawString(48, 730-y*36, line)
def scan_page(c):
    c.drawImage(ImageReader(scan), 36, 300, width=540, height=315)

c=new('text.pdf');text_page(c);c.save()
c=new('scanned.pdf');scan_page(c);c.save()
c=new('mixed-pages.pdf');text_page(c);c.showPage();scan_page(c);c.save()
c=new('mixed-page.pdf');c.drawString(48,730,'DIGITAL HEADER ONLY - SCAN CONTENT BELOW');scan_page(c);c.save()
c=new('long.pdf')
for page in range(110):
    c.setFont('Courier', 8)
    for row in range(50):
        c.drawString(35,750-row*13, f'PAGE-{page+1:03} ROW-{row+1:02} SYNTHETIC ONLY 0123456789 0123456789')
    c.showPage()
c.save()
writer=PdfWriter();writer.append(PdfReader(root/'text.pdf'));writer.encrypt('fixture-password')
with (root/'encrypted.pdf').open('wb') as f: writer.write(f)
(root/'malformed.pdf').write_bytes(b'%PDF-1.7\nThis is a deliberately invalid synthetic PDF.\n')
