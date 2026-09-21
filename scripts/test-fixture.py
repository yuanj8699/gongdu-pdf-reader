"""Generate a small real PDF for the embedded reader smoke test.

Requires reportlab; pass a Chinese TrueType font as the first argument on
systems without Windows SimHei. The embedded subset keeps the fixture portable.
"""

from pathlib import Path
import sys

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


root = Path(__file__).resolve().parents[1]
font = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("C:/Windows/Fonts/simhei.ttf")
pdfmetrics.registerFont(TTFont("FixtureChinese", str(font)))
output = root / "tests" / "fixtures" / "reader-smoke.pdf"
output.parent.mkdir(parents=True, exist_ok=True)
document = canvas.Canvas(str(output), pagesize=(612, 792), invariant=1)
document.setTitle("PDF Reader Smoke Fixture")
document.setAuthor("Local test fixture")

pages = [
    ("chapter-one", "第一章 起步", 0, "你好", "Alpha unique first-page context."),
    ("section-one", "第一节 短词", 1, "章", "Beta unique second-page context."),
    ("chapter-two", "第二章 验证", 0, "学习", "Gamma unique third-page context."),
]
for page_number, (key, title, level, short_text, english) in enumerate(pages, 1):
    document.bookmarkPage(key)
    document.addOutlineEntry(title, key, level, closed=False)
    document.setFillColorRGB(0.10, 0.18, 0.25)
    document.setFont("FixtureChinese", 24)
    document.drawString(54, 714, title)
    document.setFont("FixtureChinese", 20)
    document.drawString(54, 660, short_text)
    document.setFont("Helvetica", 15)
    document.drawString(54, 610, english)
    document.drawString(54, 578, "Searchable marker: shared-reading-marker")
    document.setFont("FixtureChinese", 14)
    document.drawString(54, 538, "选择文字后提问，并检查翻页时不保留旧选区。")
    document.setFont("Helvetica", 10)
    document.drawString(54, 40, f"Fixture page {page_number} of 3")
    document.showPage()
document.save()
print(output)
