"""生成图例小字号的语义字模，不读取任何图纸像素。"""
from pathlib import Path
import json
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
sizes = (12, 13, 14, 15, 16, 18, 20, 22, 24)
thresholds = (64, 96, 128, 160, 192)
templates = []
for name in ('arial.ttf', 'arialbd.ttf'):
    for size in sizes:
        font = ImageFont.truetype(str(Path(r'C:\Windows\Fonts') / name), size)
        for char in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789':
            image = Image.new('L', (64, 64))
            ImageDraw.Draw(image).text((8, 8), char, font=font, fill=255)
            for threshold in thresholds:
                mask = image.point(lambda value: 255 if value >= threshold else 0)
                box = mask.getbbox()
                if box is None:
                    continue
                cropped = mask.crop(box)
                templates.append({'char': char, 'width': cropped.width, 'height': cropped.height,
                                  'bits': ''.join('1' if value else '0' for value in cropped.getdata())})
output = root / 'src' / 'data' / 'legendGlyphTemplates.json'
output.write_text(json.dumps({'source': 'Arial Regular/Bold; semantic font glyphs only, no chart pixels.',
                             'sizes': sizes, 'thresholds': thresholds, 'templates': templates},
                            separators=(',', ':')), encoding='utf-8')
print(f'{len(templates)} templates written to {output}')
