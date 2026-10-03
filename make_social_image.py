"""
Chonkit - link preview image (og.png, 1200 x 630)
======================================================

Builds the picture X, Discord and iMessage show when your site's link is
shared, entirely from your own Chonk data:

  * left:  a big Chonk rebuilt out of hundreds of smaller Chonks
  * right: a chunky pixel "CHONK MOSAIC" title, tagline and "Chonks on Base"
  * around it: floating, tilted Chonk tiles on Base blue

Run it after build_dataset.py (it reads web/data):

    python make_social_image.py                 # random Chonk for the big mosaic
    python make_social_image.py --chonk 1234    # pick the Chonk to rebuild
    python make_social_image.py --seed 7        # try a different random layout
    python make_social_image.py --art starry.jpg  # a painting/photo rebuilt from
                                                  # Chonks fills the right of the card

Then upload web/og.png next to index.html.
"""

import argparse
import json
import math
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

WEB = Path(__file__).resolve().parent.parent / "web"
DATA = WEB / "data"
OUT = WEB / "og.png"

S = 2                        # draw at 2x, then shrink for smooth edges
W, H = 1200 * S, 630 * S
BLUE_TOP, BLUE_BOTTOM = (22, 92, 255), (6, 52, 214)
INK = (14, 18, 48)
WORD2_COLOURS = [(255, 79, 163), (255, 160, 30), (60, 205, 80), (30, 190, 255), (160, 100, 255), (139, 92, 255)]

# 5x7 pixel letters for the title
GLYPHS = {
    "C": ["01111", "11000", "10000", "10000", "10000", "11000", "01111"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "O": ["01110", "11011", "10001", "10001", "10001", "11011", "01110"],
    "N": ["10001", "11001", "11101", "10111", "10011", "10001", "10001"],
    "K": ["10011", "10110", "11100", "11000", "11100", "10110", "10011"],
    "M": ["10001", "11011", "11111", "10101", "10001", "10001", "10001"],
    "S": ["01111", "11000", "11000", "01110", "00011", "00011", "11110"],
    "A": ["01110", "11011", "10001", "11111", "10001", "10001", "10001"],
    "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
}


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


# ------------------------------------------------------------------ data
class Chonks:
    def __init__(self):
        meta_path = DATA / "meta.json"
        if not meta_path.exists():
            sys.exit("web/data/meta.json not found. Run build_dataset.py first.")
        self.meta = json.loads(meta_path.read_text(encoding="utf-8"))
        m = self.meta
        self.thumb, self.side = m["thumb"], m["perAtlasSide"]
        self.per = self.side * self.side
        self.fmt = m.get("atlasFormat", "webp")
        self.ids = m["ids"]
        self.sheets = {}
        raw = np.fromfile(DATA / "features.bin", dtype=np.uint8).reshape(m["count"], m["recordBytes"])
        self.lab = np.stack([raw[:, 0] / 2.55, raw[:, 1].astype(float) - 128, raw[:, 2].astype(float) - 128], axis=1)

    def image(self, idx):
        a = idx // self.per
        if a not in self.sheets:
            self.sheets[a] = Image.open(DATA / "atlas" / f"atlas_{a:03d}.{self.fmt}").convert("RGBA")
        slot = idx % self.per
        x, y = (slot % self.side) * self.thumb, (slot // self.side) * self.thumb
        return self.sheets[a].crop((x, y, x + self.thumb, y + self.thumb))


def rgb_to_lab(rgb):
    rgb = np.asarray(rgb, dtype=float) / 255.0
    lin = np.where(rgb > 0.04045, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)
    x = (lin[..., 0] * 0.4124564 + lin[..., 1] * 0.3575761 + lin[..., 2] * 0.1804375) / 0.95047
    y = lin[..., 0] * 0.2126729 + lin[..., 1] * 0.7151522 + lin[..., 2] * 0.0721750
    z = (lin[..., 0] * 0.0193339 + lin[..., 1] * 0.1191920 + lin[..., 2] * 0.9503041) / 1.08883
    f = lambda t: np.where(t > 216 / 24389, np.cbrt(t), (24389 / 27 * t + 16) / 116)
    fx, fy, fz = f(x), f(y), f(z)
    return np.stack([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)], axis=-1)


# ------------------------------------------------------------------ pieces
def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius, fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def tile(chonk_img, size, radius_frac=0.16, border=None):
    """A Chonk on a rounded square, optional coloured rim."""
    art = chonk_img.resize((size, size), Image.NEAREST)
    base = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    base.alpha_composite(art)
    t = rounded(base, int(size * radius_frac))
    if border:
        b = max(2, size // 16)
        rim = rounded(Image.new("RGBA", (size + 2 * b, size + 2 * b), border + (255,)), int((size + 2 * b) * radius_frac))
        rim.alpha_composite(t, (b, b))
        t = rim
    return t


def drop_shadow(img, offset=(0, 14), blur=18, opacity=110):
    pad = blur * 3
    sh = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))
    alpha = img.split()[3].point(lambda a: a * opacity // 255)
    sh.paste((6, 20, 90, 255), (pad + offset[0], pad + offset[1]), alpha)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    sh.alpha_composite(img, (pad, pad))
    return sh, pad


def paste_centre(canvas, img, cx, cy):
    canvas.alpha_composite(img, (int(cx - img.width / 2), int(cy - img.height / 2)))


def build_mosaic(ch, target_idx, rng):
    """Rebuild one Chonk out of Chonks, cropped close around the character."""
    src = ch.image(target_idx).convert("RGBA")
    bg = Image.new("RGBA", src.size, (255, 255, 255, 255))
    bg.alpha_composite(src)
    full = 30
    art = np.asarray(bg.convert("RGB").resize((full, full), Image.BOX), dtype=float)
    # background colour = most common colour around the border
    border = np.concatenate([art[0], art[-1], art[:, 0], art[:, -1]])
    vals, counts = np.unique(border.round().astype(int), axis=0, return_counts=True)
    bgc = vals[np.argmax(counts)]
    fg = np.abs(art - bgc).sum(axis=2) > 24
    ys, xs = np.where(fg)
    if len(xs):
        pad = 1 if bgc.min() > 225 else 2
        x0, x1 = max(0, xs.min() - pad), min(full, xs.max() + 1 + pad)
        y0, y1 = max(0, ys.min() - pad), min(full, ys.max() + 1 + pad)
    else:
        x0, y0, x1, y1 = 0, 0, full, full
    crop = art[y0:y1, x0:x1].copy()
    is_bg = ~fg[y0:y1, x0:x1]
    # Transparent / white backgrounds: leave them empty, so the character is a
    # cut-out made of Chonk tiles floating on the blue.
    cutout = bgc.min() > 225
    target = rgb_to_lab(crop)
    rows, cols = crop.shape[:2]
    cell = 40 * S
    gap = max(2, cell // 12)
    mosaic = Image.new("RGBA", (cols * cell, rows * cell), (0, 0, 0, 0))
    used = {}
    for y in range(rows):
        for x in range(cols):
            if cutout and is_bg[y, x]:
                continue
            d = np.linalg.norm(ch.lab - target[y, x], axis=1)
            k = 160 if is_bg[y, x] else 12      # character: closest colours; background: variety
            cand = np.argpartition(d, k)[:k]
            scores = d[cand] + np.array([used.get(int(i), 0) * (8 if is_bg[y, x] else 3) for i in cand]) + rng.random(len(cand)) * (6 if is_bg[y, x] else 1.5)
            best = int(cand[np.argmin(scores)])
            used[best] = used.get(best, 0) + 1
            t = tile(ch.image(best), cell - gap, radius_frac=0.18)
            mosaic.alpha_composite(t, (x * cell + gap // 2, y * cell + gap // 2))
    return mosaic


def art_mosaic(ch, path, box_w, box_h, cell, focus_x=0.65):
    """A picture rebuilt from Chonks, cover-cropped to box_w x box_h.
    focus_x (0-1) picks which part of a wide picture to keep."""
    src = Image.open(path).convert("RGB")
    r = box_w / box_h
    if src.width / src.height > r:
        nw = int(src.height * r); x0 = int((src.width - nw) * focus_x)
        src = src.crop((x0, 0, x0 + nw, src.height))
    else:
        nh = int(src.width / r); y0 = (src.height - nh) // 2
        src = src.crop((0, y0, src.width, y0 + nh))
    cols, rows = math.ceil(box_w / cell), math.ceil(box_h / cell)
    target = rgb_to_lab(np.asarray(src.resize((cols, rows), Image.BOX), dtype=float))
    out = Image.new("RGBA", (cols * cell, rows * cell), (255, 255, 255, 255))
    used, placed = {}, {}
    flat = target.reshape(-1, 3)
    for n, t in enumerate(flat):
        x, y = n % cols, n // cols
        d = np.linalg.norm(ch.lab - t, axis=1)
        cand = np.argpartition(d, 24)[:24]
        near = {placed.get((x - 1, y)), placed.get((x, y - 1)), placed.get((x - 1, y - 1)), placed.get((x + 1, y - 1))}
        scores = d[cand] + np.array([used.get(int(i), 0) * 1.5 + (30 if int(i) in near else 0) for i in cand])
        best = int(cand[np.argmin(scores)])
        used[best] = used.get(best, 0) + 1
        placed[(x, y)] = best
        out.alpha_composite(ch.image(best).resize((cell, cell), Image.NEAREST), (x * cell, y * cell))
    return out.crop((0, 0, box_w, box_h))


def tilt(img, strength=0.12):
    """Gentle perspective: the far (right) edge leans away, like the reference."""
    w, h = img.size
    pad = int(h * strength)
    out_w = w
    # map output quad -> input rectangle
    coeffs = find_coeffs(
        [(0, 0), (out_w, pad), (out_w, h - pad), (0, h)],
        [(0, 0), (w, 0), (w, h), (0, h)],
    )
    return img.transform((out_w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC)


def find_coeffs(pa, pb):
    m = []
    for p1, p2 in zip(pa, pb):
        m.append([p1[0], p1[1], 1, 0, 0, 0, -p2[0] * p1[0], -p2[0] * p1[1]])
        m.append([0, 0, 0, p1[0], p1[1], 1, -p2[1] * p1[0], -p2[1] * p1[1]])
    A = np.array(m, dtype=float)
    B = np.array(pb, dtype=float).reshape(8)
    return np.linalg.solve(A, B).tolist()


def pixel_word(word, px, fill_for, outline=INK, depth=None):
    """Chunky title word from 5x7 pixel glyphs, with outline and 3D depth."""
    gap = px                       # space between letters
    w = len(word) * 5 * px + (len(word) - 1) * gap
    h = 7 * px
    o = max(4, px // 2)            # outline thickness
    depth = depth or px // 2
    img = Image.new("RGBA", (w + 2 * o + depth, h + 2 * o + depth), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cells = []
    for i, ch in enumerate(word):
        x0 = o + i * (5 * px + gap)
        for r, row in enumerate(GLYPHS[ch]):
            for c, v in enumerate(row):
                if v == "1":
                    cells.append((i, x0 + c * px, o + r * px))
    for i, x, y in cells:                       # outline + depth
        d.rectangle((x - o, y - o, x + px + o + depth, y + px + o + depth), fill=outline)
    for i, x, y in cells:                       # extrusion shade
        col = fill_for(i)
        shade = tuple(int(v * 0.68) for v in col)
        d.rectangle((x + depth // 2, y + depth // 2, x + px + depth // 2, y + px + depth // 2), fill=shade)
    for i, x, y in cells:                       # face
        d.rectangle((x, y, x + px, y + px), fill=fill_for(i))
    return img


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chonk", type=int, help="Chonk ID to rebuild on the left (default: random)")
    ap.add_argument("--seed", type=int, help="change the random layout")
    ap.add_argument("--art", help="a picture (painting, photo) to rebuild from Chonks on the card")
    ap.add_argument("--focus", type=float, default=1.0, help="with --art: which part of a wide picture to show, 0 = left, 1 = right")
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    rnd = random.Random(args.seed)

    ch = Chonks()
    if args.art:
        return art_card(ch, args, rng, rnd)
    if args.chonk is not None:
        if args.chonk not in ch.ids:
            sys.exit(f"Chonk #{args.chonk} isn't in your data.")
        target = ch.ids.index(args.chonk)
    else:
        target = rnd.randrange(len(ch.ids))
    print(f"Rebuilding Chonk #{ch.ids[target]} out of Chonks…")

    # background: Base blue gradient with a soft glow behind the title
    y = np.linspace(0, 1, H)[:, None, None]
    grad = (np.array(BLUE_TOP) * (1 - y) + np.array(BLUE_BOTTOM) * y).repeat(W, axis=1)
    canvas = Image.fromarray(grad.astype(np.uint8), "RGB").convert("RGBA")
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((W * 0.42, H * 0.18, W * 1.02, H * 0.86), fill=(90, 160, 255, 90))
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(120 * S // 2)))

    # small blurred background tiles for depth
    picks = rnd.sample(range(len(ch.ids)), min(len(ch.ids), 40))
    for idx, (fx, fy, size, blur) in zip(picks[:6], [
        (0.60, 0.08, 40, 2), (0.76, 0.06, 34, 1), (0.92, 0.55, 40, 5),
        (0.58, 0.95, 44, 2), (0.70, 0.96, 38, 3), (0.80, 0.86, 30, 4)]):
        t = tile(ch.image(idx), size * S, border=rnd.choice(WORD2_COLOURS)).rotate(rnd.uniform(-22, 22), expand=True, resample=Image.BICUBIC)
        if blur:
            t = t.filter(ImageFilter.GaussianBlur(blur * S))
        paste_centre(canvas, t, fx * W, fy * H)

    # the big mosaic on the left
    m = build_mosaic(ch, target, rng)
    mh = int(H * 1.04)
    mw = int(m.width * mh / m.height)
    max_w = int(W * 0.40)
    if mw > max_w:                      # wide characters: fit the width instead
        mh = int(mh * max_w / mw); mw = max_w
    m = m.resize((mw, mh), Image.LANCZOS)
    m = tilt(m, 0.06)
    m, pad = drop_shadow(m, offset=(18 * S, 26 * S), blur=26 * S, opacity=140)
    left = int(min(W * 0.03, W * 0.40 - mw))   # keep the whole character in frame
    canvas.alpha_composite(m, (left - pad, int((H - mh) / 2) - pad))

    # title block
    right_cx = W * 0.665
    px1 = 15 * S
    w1 = pixel_word("CHONK", px1, lambda i: (250, 252, 255))
    w2 = pixel_word("IT", px1, lambda i: WORD2_COLOURS[i % len(WORD2_COLOURS)])
    top = H * 0.2
    paste_centre(canvas, w1, right_cx, top + w1.height / 2)
    paste_centre(canvas, w2, right_cx, top + w1.height + 6 * S + w2.height / 2)

    d = ImageDraw.Draw(canvas)
    tag = "Your picture, rebuilt from Chonks."
    tf = font(30 * S)
    tw = d.textlength(tag, font=tf)
    ty = top + w1.height + w2.height + 34 * S
    d.text((right_cx - tw / 2 + 2 * S, ty + 3 * S), tag, font=tf, fill=(6, 30, 140))
    d.text((right_cx - tw / 2, ty), tag, font=tf, fill="white")

    # "Chonks on Base" pill
    pf = font(21 * S)
    label = "CHONKS ON BASE"
    lw = d.textlength(label, font=pf)
    ph, dot = 52 * S, 30 * S
    pw = int(lw + dot + 54 * S)
    py = ty + 62 * S
    px0 = right_cx - pw / 2
    line_y = py + ph / 2
    d.line((px0 - 70 * S, line_y, px0 - 18 * S, line_y), fill=(70, 160, 255), width=3 * S)
    d.line((px0 + pw + 18 * S, line_y, px0 + pw + 70 * S, line_y), fill=(70, 160, 255), width=3 * S)
    d.rounded_rectangle((px0, py, px0 + pw, py + ph), ph // 2, fill=(10, 24, 80))
    cx0, cy0 = px0 + 14 * S + dot / 2, py + ph / 2
    d.ellipse((cx0 - dot / 2, cy0 - dot / 2, cx0 + dot / 2, cy0 + dot / 2), fill="white")
    d.rounded_rectangle((cx0 - dot * 0.3, cy0 - 2.5 * S, cx0 + dot * 0.3, cy0 + 2.5 * S), 2 * S, fill=(0, 82, 255))
    d.text((cx0 + dot / 2 + 12 * S, cy0), label, font=pf, fill=(110, 200, 255), anchor="lm")

    # big floating tiles around the right edge
    for idx, (fx, fy, size, rot) in zip(picks[6:], [
        (0.90, 0.10, 104, -6), (1.00, 0.40, 96, 10), (0.99, 0.72, 100, -12),
        (0.86, 0.95, 84, 8), (0.42, 0.92, 84, -14), (0.47, 0.07, 58, 14)]):
        t = tile(ch.image(idx), size * S, border=rnd.choice(WORD2_COLOURS)).rotate(rot, expand=True, resample=Image.BICUBIC)
        t, pad = drop_shadow(t, offset=(0, 10 * S), blur=12 * S, opacity=120)
        paste_centre(canvas, t, fx * W, fy * H)

    out = canvas.convert("RGB").resize((W // S, H // S), Image.LANCZOS)
    out.save(OUT, optimize=True)
    print(f"Saved {OUT} ({OUT.stat().st_size // 1024} KB, {out.width} x {out.height}). Upload it next to index.html.")


def title_block(canvas, cx, top, scale=1.0):
    """CHONK MOSAIC title, tagline and pill, centred on cx."""
    px1 = int(12 * S * scale)
    w1 = pixel_word("CHONK", px1, lambda i: (250, 252, 255))
    w2 = pixel_word("IT", px1, lambda i: WORD2_COLOURS[i % len(WORD2_COLOURS)])
    paste_centre(canvas, w1, cx, top + w1.height / 2)
    paste_centre(canvas, w2, cx, top + w1.height + 6 * S + w2.height / 2)
    d = ImageDraw.Draw(canvas)
    tag = "Your picture, rebuilt from Chonks."
    tf = font(int(30 * S * scale))
    tw = d.textlength(tag, font=tf)
    ty = top + w1.height + w2.height + int(34 * S * scale)
    d.text((cx - tw / 2 + 2 * S, ty + 3 * S), tag, font=tf, fill=(4, 14, 60))
    d.text((cx - tw / 2, ty), tag, font=tf, fill="white")
    pf = font(int(21 * S * scale))
    label = "CHONKS ON BASE"
    lw = d.textlength(label, font=pf)
    ph, dot = int(52 * S * scale), int(30 * S * scale)
    pw = int(lw + dot + 54 * S * scale)
    py = ty + int(62 * S * scale)
    px0 = cx - pw / 2
    d.rounded_rectangle((px0, py, px0 + pw, py + ph), ph // 2, fill=(10, 24, 80))
    c0x, c0y = px0 + 14 * S + dot / 2, py + ph / 2
    d.ellipse((c0x - dot / 2, c0y - dot / 2, c0x + dot / 2, c0y + dot / 2), fill="white")
    d.rounded_rectangle((c0x - dot * 0.3, c0y - 2.5 * S, c0x + dot * 0.3, c0y + 2.5 * S), 2 * S, fill=(0, 82, 255))
    d.text((c0x + dot / 2 + 12 * S, c0y), label, font=pf, fill=(110, 200, 255), anchor="lm")


def art_card(ch, args, rng, rnd):
    print(f"Rebuilding {Path(args.art).name} out of Chonks (takes ~30 seconds)…")
    # Base-blue background with a soft glow
    y = np.linspace(0, 1, H)[:, None, None]
    grad = (np.array(BLUE_TOP) * (1 - y) + np.array(BLUE_BOTTOM) * y).repeat(W, axis=1)
    canvas = Image.fromarray(grad.astype(np.uint8), "RGB").convert("RGBA")
    # the painting, built from Chonks, fills the right side
    pw = int(W * 0.56)
    art = art_mosaic(ch, args.art, pw, H, 9 * S, focus_x=args.focus)
    edge = 60 * S                                   # soft blend into the blue
    mask = np.ones((H, pw)); mask[:, :edge] = np.linspace(0, 1, edge)[None, :]
    art.putalpha(Image.fromarray((mask * 255).astype(np.uint8), "L"))
    canvas.alpha_composite(art, (W - pw, 0))
    title_block(canvas, W * 0.225, H * 0.23, scale=0.82)
    out = canvas.convert("RGB").resize((W // S, H // S), Image.LANCZOS)
    out.save(OUT, optimize=True)
    print(f"Saved {OUT} ({OUT.stat().st_size // 1024} KB, {out.width} x {out.height}). Upload it next to index.html.")


if __name__ == "__main__":
    main()
