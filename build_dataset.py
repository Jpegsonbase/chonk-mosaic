"""
Chonk Mosaic - one-time dataset builder
=======================================

Run this ONCE on your computer, against your folder of 83k+ Chonk images
(PNG, JPG/JPEG or WebP, named <id>.png / <id>.jpg).
It produces a small static dataset the website loads in the browser:

    web/data/meta.json        ids + settings
    web/data/features.bin     compact per-Chonk matching features (uint8)
    web/data/atlas/*.webp     sprite sheets of small Chonk thumbnails

The features are calculated with exactly the same maths as your original
mosaic script (64x64 LANCZOS analysis, LAB mean of visible pixels,
brightness, saturation, edge strength, LAB fingerprint), then quantised
to bytes so the whole collection fits in a few MB.

Usage:
    pip install pillow numpy
    python build_dataset.py --images path/to/images --out ../web/data

Options:
    --fingerprint 4   fingerprint grid (4 = 48 bytes/Chonk, 8 = 192 bytes/Chonk)
    --thumb 60        thumbnail size stored in the atlases (pixels). Use a size that
                      divides your image size evenly (300px images: 30, 60, 150 or 300).
    --workers N       CPU processes to use (default: all)
"""

import argparse
import json
import math
import os
import sys
import time
import warnings
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True

PER_ATLAS_SIDE = 64                 # 64 x 64 = 4096 Chonks per sprite sheet
PER_ATLAS = PER_ATLAS_SIDE ** 2
HEADER_BYTES = 6                    # L, a, b, brightness, saturation, edge


# ------------------------------------------------------------
# Same colour maths as the original script
# ------------------------------------------------------------

def rgb_to_lab(rgb):
    rgb = np.asarray(rgb, dtype=np.float32) / 255.0
    rgb_linear = np.where(rgb > 0.04045, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)
    r, g, b = rgb_linear[..., 0], rgb_linear[..., 1], rgb_linear[..., 2]
    x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
    y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.00000
    z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883
    eps, kappa = 216 / 24389, 24389 / 27

    def f(t):
        return np.where(t > eps, np.cbrt(t), (kappa * t + 16) / 116)

    fx, fy, fz = f(x), f(y), f(z)
    return np.stack([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)], axis=-1)


def extract_features(image, fp_size):
    image = image.convert("RGBA")
    rgba = np.asarray(image.resize((64, 64), Image.Resampling.LANCZOS), dtype=np.float32)
    rgb, alpha = rgba[..., :3], rgba[..., 3]
    visible = alpha > 0
    if not np.any(visible):
        raise ValueError("no visible pixels")

    mean_lab = rgb_to_lab(rgb)[visible].mean(axis=0)

    lum = rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722
    brightness = float(lum[visible].mean())

    n = rgb / 255.0
    mx, mn = n.max(axis=2), n.min(axis=2)
    with np.errstate(divide="ignore", invalid="ignore"):
        sat_map = np.where(mx == 0, 0, (mx - mn) / mx)
    saturation = float(sat_map[visible].mean())

    edge = float((np.abs(lum[:, 1:] - lum[:, :-1]).mean() +
                  np.abs(lum[1:, :] - lum[:-1, :]).mean()) / 2)

    fp_rgb = np.asarray(image.resize((fp_size, fp_size), Image.Resampling.LANCZOS),
                        dtype=np.float32)[..., :3]
    fingerprint = rgb_to_lab(fp_rgb).reshape(-1, 3)

    return mean_lab, brightness, saturation, edge, fingerprint


# ------------------------------------------------------------
# Byte packing (decoded identically in web/mosaic-core.js)
# ------------------------------------------------------------

def q(v):
    return np.clip(np.round(v), 0, 255).astype(np.uint8)


def pack(mean_lab, brightness, saturation, edge, fingerprint):
    head = q(np.array([
        mean_lab[0] * 2.55,
        mean_lab[1] + 128,
        mean_lab[2] + 128,
        brightness,
        saturation * 255,
        edge * 4,
    ]))
    fp = np.empty_like(fingerprint)
    fp[:, 0] = fingerprint[:, 0] * 2.55
    fp[:, 1] = fingerprint[:, 1] + 128
    fp[:, 2] = fingerprint[:, 2] + 128
    return head.tobytes() + q(fp).tobytes()


def make_thumb(img, size):
    w, h = img.size
    if w == size and h == size:
        return img
    # BOX keeps pixel art crisp when shrinking; NEAREST when enlarging.
    method = Image.Resampling.BOX if w > size else Image.Resampling.NEAREST
    return img.resize((size, size), method)


def process(args):
    path, fp_size, thumb = args
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with Image.open(path) as im:
                img = im.convert("RGBA")
                record = pack(*extract_features(img, fp_size))
                small = make_thumb(img, thumb)
                return path.stem, record, small.tobytes(), None
    except Exception as e:  # noqa: BLE001
        return path.stem, None, None, str(e)


def sort_key(p):
    return (0, int(p.stem)) if p.stem.isdigit() else (1, p.stem)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", default="images")
    ap.add_argument("--out", default="../web/data")
    ap.add_argument("--fingerprint", type=int, default=4, choices=[2, 4, 8])
    ap.add_argument("--thumb", type=int, default=60)
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--format", default="webp", choices=["webp", "png"])
    args = ap.parse_args()

    images_dir = Path(args.images)
    out_dir = Path(args.out)
    atlas_dir = out_dir / "atlas"
    atlas_dir.mkdir(parents=True, exist_ok=True)

    if not images_dir.is_dir():
        sys.exit(f"Folder not found: {images_dir}\n"
                 f"Check the path after --images (put it in quotes).")
    exts = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
    by_stem = {}
    for p in images_dir.iterdir():
        if p.is_file() and p.suffix.lower() in exts:
            by_stem.setdefault(p.stem, p)   # one file per Chonk ID
    paths = sorted(by_stem.values(), key=sort_key)
    if not paths:
        sys.exit(f"No images (png/jpg/jpeg/webp) found in {images_dir.resolve()}")
    print(f"Found {len(paths)} Chonk images. Using {args.workers} processes.")

    ids, records, failed = [], [], []
    thumb = args.thumb
    atlas = None
    atlas_index = 0

    def flush_atlas():
        nonlocal atlas
        if atlas is None:
            return
        name = atlas_dir / f"atlas_{atlas_index:03d}.{args.format}"
        if args.format == "webp":
            atlas.save(name, "WEBP", lossless=True, method=6)
        else:
            atlas.save(name, "PNG", optimize=True)
        atlas = None

    jobs = ((p, args.fingerprint, thumb) for p in paths)
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for n, (stem, record, thumb_bytes, err) in enumerate(
                pool.map(process, jobs, chunksize=64), start=1):
            if err:
                failed.append((stem, err))
            else:
                slot = len(ids) % PER_ATLAS
                if slot == 0 and ids:
                    flush_atlas()
                    atlas_index += 1
                if atlas is None:
                    atlas = Image.new("RGBA", (PER_ATLAS_SIDE * thumb, PER_ATLAS_SIDE * thumb))
                tile = Image.frombytes("RGBA", (thumb, thumb), thumb_bytes)
                atlas.paste(tile, ((slot % PER_ATLAS_SIDE) * thumb, (slot // PER_ATLAS_SIDE) * thumb))
                ids.append(int(stem) if stem.isdigit() else stem)
                records.append(record)
            if n % 1000 == 0:
                print(f"  {n}/{len(paths)}")
    flush_atlas()

    with open(out_dir / "features.bin", "wb") as f:
        for r in records:
            f.write(r)

    meta = {
        "version": 1,
        "built": int(time.time()),
        "count": len(ids),
        "fingerprint": args.fingerprint,
        "recordBytes": HEADER_BYTES + args.fingerprint ** 2 * 3,
        "thumb": thumb,
        "perAtlasSide": PER_ATLAS_SIDE,
        "atlasCount": math.ceil(len(ids) / PER_ATLAS),
        "atlasFormat": args.format,
        "ids": ids,
    }
    with open(out_dir / "meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, separators=(",", ":"))

    size = sum(p.stat().st_size for p in out_dir.rglob("*") if p.is_file())
    print(f"\nDone. {len(ids)} Chonks packed, {len(failed)} failed.")
    for stem, err in failed[:20]:
        print(f"  {stem}: {err}")
    print(f"Dataset size: {size / 1e6:.1f} MB in {out_dir.resolve()}")


if __name__ == "__main__":
    main()
