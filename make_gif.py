#!/usr/bin/env python3
"""Chonkit GIFs: turn a Blender MP4 into the best GIF that fits under a size cap (default 15 MB, X's GIF limit).

Tries the biggest size first and only gives up quality until the file fits: for each size it first checks
whether even the strongest compression can fit (if not, it moves straight on to a smaller size), then uses
the lightest compression that fits. Needs ffmpeg and gifsicle.

  python3 make_gif.py clip.mp4 clip.gif [--cap 15000000] [--gifsicle PATH]
"""
import argparse, os, shutil, subprocess, sys, tempfile

LADDER = [(1080, 15), (900, 15), (720, 15), (600, 15), (540, 15), (480, 15), (480, 12), (400, 12), (320, 12)]
LOSSY = [0, 20, 40, 60, 80]

def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def best_gif(src, out, cap=15_000_000, gifsicle=None):
    gifsicle = gifsicle or shutil.which("gifsicle") or "gifsicle"
    tmp = tempfile.mkdtemp()
    raw, opt = os.path.join(tmp, "raw.gif"), os.path.join(tmp, "opt.gif")
    try:
        for width, fps in LADDER:
            vf = (f"fps={fps},scale='min({width},iw)':-2:flags=lanczos,split[a][b];"
                  "[a]palettegen=max_colors=256:stats_mode=diff[p];"
                  "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle")
            run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", vf, raw])
            run([gifsicle, "-O3", f"--lossy={LOSSY[-1]}", raw, "-o", opt])
            if os.path.getsize(opt) > cap:
                continue                                  # can't fit at this size: go smaller
            for lossy in LOSSY:
                run([gifsicle, "-O3", f"--lossy={lossy}", raw, "-o", opt])
                if os.path.getsize(opt) <= cap:
                    shutil.copyfile(opt, out)
                    return {"width": width, "fps": fps, "lossy": lossy, "bytes": os.path.getsize(out)}
        raise RuntimeError("Couldn't get the GIF under the cap; try a shorter clip.")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("out")
    ap.add_argument("--cap", type=int, default=15_000_000)
    ap.add_argument("--gifsicle")
    a = ap.parse_args()
    try:
        r = best_gif(a.src, a.out, a.cap, a.gifsicle)
    except RuntimeError as e:
        sys.exit(str(e))
    print(f"{a.out}: {r['width']}px, {r['fps']} fps, lossy {r['lossy']}, {r['bytes'] / 1e6:.1f} MB")
