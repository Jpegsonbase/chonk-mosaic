"""
Chonk Mosaic - link preview image
=================================

Makes web/og.png: the 1200 x 630 picture that X, Discord, iMessage etc. show
when someone shares your site's link. It's a wall of random Chonks taken from
your built data, with the site name on top.

Run it after build_dataset.py (it reads web/data):

    python make_social_image.py

Then upload web/og.png to your GitHub repo next to index.html.
"""

import json
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WEB = Path(__file__).resolve().parent.parent / "web"
DATA = WEB / "data"
OUT = WEB / "og.png"
W, H = 1200, 630

FACE = ["..aaaaaaaa.", ".aaaaaaaaaa", ".aaaaaaaaaa", "baacdaaacda", "baacdbbbcda", ".aaaaaaaaaa", "..aaaaaaaa."]
FACE_COLOURS = {"a": "#FDCB58", "b": "#F4900C", "c": "#E6E7E8", "d": "#31373D"}


def font(size, bold=True):
    names = (["arialbd.ttf", "seguibl.ttf", "segoeuib.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf"]
             if bold else ["arial.ttf", "segoeui.ttf", "Arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf"])
    folders = ["", "C:/Windows/Fonts/", "/Library/Fonts/", "/System/Library/Fonts/Supplemental/",
               "/usr/share/fonts/truetype/dejavu/", "/usr/share/fonts/truetype/liberation/"]
    for name in names:
        for folder in folders:
            try:
                return ImageFont.truetype(folder + name, size)
            except OSError:
                continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def main():
    meta_path = DATA / "meta.json"
    if not meta_path.exists():
        sys.exit("web/data/meta.json not found. Run build_dataset.py first.")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    thumb, side = meta["thumb"], meta["perAtlasSide"]
    per = side * side
    fmt = meta.get("atlasFormat", "webp")

    # Background: a wall of random Chonks.
    tile = 90
    cols, rows = -(-W // tile), -(-H // tile)
    rng = random.Random()
    picks = rng.sample(range(meta["count"]), min(meta["count"], cols * rows))
    atlases = {}
    bg = Image.new("RGB", (cols * tile, rows * tile), "white")
    for n, idx in enumerate(picks):
        a = idx // per
        if a not in atlases:
            atlases[a] = Image.open(DATA / "atlas" / f"atlas_{a:03d}.{fmt}").convert("RGBA")
        slot = idx % per
        sx, sy = (slot % side) * thumb, (slot // side) * thumb
        chonk = atlases[a].crop((sx, sy, sx + thumb, sy + thumb)).resize((tile, tile), Image.NEAREST)
        bg.paste(chonk, ((n % cols) * tile, (n // cols) * tile), chonk)
    img = bg.crop(((bg.width - W) // 2, (bg.height - H) // 2, (bg.width - W) // 2 + W, (bg.height - H) // 2 + H))

    # Centre card with the logo face, name and tagline.
    d = ImageDraw.Draw(img, "RGBA")
    cw, ch = 760, 300
    cx, cy = (W - cw) // 2, (H - ch) // 2
    d.rounded_rectangle((cx + 8, cy + 14, cx + cw + 8, cy + ch + 14), 36, fill=(14, 18, 48, 90))
    d.rounded_rectangle((cx, cy, cx + cw, cy + ch), 36, fill="white")

    px = 10
    fx, fy = (W - 11 * px) // 2, cy + 44
    for r, row in enumerate(FACE):
        for c, ch_ in enumerate(row):
            if ch_ != ".":
                d.rectangle((fx + c * px, fy + r * px, fx + (c + 1) * px - 1, fy + (r + 1) * px - 1), fill=FACE_COLOURS[ch_])

    title, tag = "Chonk Mosaic", "Your picture, rebuilt from Chonks"
    tf, sf = font(72), font(32, bold=False)
    tw = d.textlength(title, font=tf)
    d.text(((W - tw) / 2, cy + 130), title, font=tf, fill="#0E1230")
    sw = d.textlength(tag, font=sf)
    d.text(((W - sw) / 2, cy + 224), tag, font=sf, fill="#5B6185")

    img.save(OUT, optimize=True)
    print(f"Saved {OUT} ({OUT.stat().st_size // 1024} KB). Upload it next to index.html.")


if __name__ == "__main__":
    main()
