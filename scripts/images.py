"""Builds site/assets/img from raw/ (cropped, resized WebP). Run: python scripts/images.py"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW, OUT = ROOT / "raw", ROOT / "site" / "assets" / "img"
OUT.mkdir(parents=True, exist_ok=True)

# name: (source, crop box or None) — crops remove Google Maps UI and black edges
PHOTOS = {
    "havadan-genis": ("1.png", (14, 0, 1090, 614)),
    "avlu": ("3.png", None),
    "tabela": ("4.png", None),
    "salon": ("5.png", (8, 4, 688, 830)),
    "teras": ("6.png", (6, 2, 688, 830)),
    "koridor": ("7.png", (7, 4, 688, 830)),
    "havadan": ("8.png", (52, 2, 786, 830)),
}
WIDTHS = (640, 1200, 1600)

for name, (src, box) in PHOTOS.items():
    im = Image.open(RAW / src).convert("RGB")
    if box:
        im = im.crop(box)
    made = []
    for w in WIDTHS:
        if made and w >= im.width:
            w = im.width  # last size: the original, never upscaled
        h = round(im.height * w / im.width)
        im.resize((w, h), Image.LANCZOS).save(OUT / f"{name}-{w}.webp", "WEBP", quality=80, method=6)
        made.append(f"{w}x{h}")
        if w == im.width:
            break
    print(name, made)

seal = Image.open(RAW / "logo-src.png").convert("RGBA").crop((0, 0, 229, 229))
seal.save(OUT / "logo.png", optimize=True)
seal.save(OUT / "logo.webp", "WEBP", quality=90)
for s in (32, 180, 192):
    seal.resize((s, s), Image.LANCZOS).save(OUT / f"icon-{s}.png", optimize=True)
print("logo ok")
