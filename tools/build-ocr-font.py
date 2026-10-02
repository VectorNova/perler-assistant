"""Build semantic character templates, using fonts only (no chart images).

Usage: python tools/build-ocr-font.py [path-to-Arial.ttf]
Requires Pillow. The runtime consumes the resulting JSON and needs no installed fonts.
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import json
import sys

font_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r'C:\Windows\Fonts\arial.ttf')
output = Path(__file__).resolve().parents[1] / 'src' / 'data' / 'ocrGlyphTemplates.json'
if not font_path.is_file():
    raise SystemExit('Provide an Arial TTF file path; existing checked-in templates need no font installation.')
templates = []
for size in (16, 18, 19, 20, 22, 24):
    font = ImageFont.truetype(str(font_path), size)
    for char in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789':
        image = Image.new('L', (64, 64))
        ImageDraw.Draw(image).text((8, 8), char, font=font, fill=255)
        for threshold in (64, 128, 192):
            mask = image.point(lambda p: 255 if p >= threshold else 0)
            box = mask.getbbox()
            if box is None:
                continue
            mask = mask.crop(box)
            templates.append({
                'char': char, 'width': mask.width, 'height': mask.height,
                'bits': ''.join('1' if p else '0' for p in mask.getdata()),
            })
output.write_text(json.dumps({
    'source': 'Microsoft Arial Regular; semantic characters rendered independently with Pillow/Freetype. No chart pixels.',
    'sizes': [16, 18, 19, 20, 22, 24],
    'thresholds': [64, 128, 192],
    'templates': templates,
}, separators=(',', ':')), encoding='utf-8')
print(f'{len(templates)} templates written to {output}')
