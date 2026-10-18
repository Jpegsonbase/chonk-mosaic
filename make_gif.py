#!/usr/bin/env python3
"""Chonkit GIFs: turn a Blender MP4 into the best GIF that fits under a size cap (default 15 MB).

Tries the biggest, smoothest settings first and only gives up quality until the file fits:
720 px then smaller, 15 fps then lower, with gifsicle's lossy compression stepped up gently.
Needs ffmpeg and gifsicle.

  python3 make_gif.py gifs/videos/clip.mp4 gifs/videos/clip.gif [--cap 15000000] [--gifsicle PATH]
"""
import argparse, os, shutil, subprocess, sys, tempfile

def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("out")
    ap.add_argument("--cap", type=int, default=15_000_000)
    ap.add_argument("--gifsicle", default=shutil.which("gifsicle") or "gifsicle")
    a = ap.parse_args()
    tmp = tempfile.mkdtemp()
    raw = os.path.join(tmp, "raw.gif"); opt = os.path.join(tmp, "opt.gif")
    for width, fps in [(1080, 15), (900, 15), (720, 15), (600, 15), (540, 15), (480, 15), (480, 12), (400, 12)]:
        vf = (f"fps={fps},scale={width}:-2:flags=lanczos,split[a][b];"
              "[a]palettegen=max_colors=256:stats_mode=diff[p];"
              "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle")
        run(["ffmpeg", "-v", "error", "-y", "-i", a.src, "-vf", vf, raw])
        for lossy in (0, 20, 40, 60, 80):
            run([a.gifsicle, "-O3", f"--lossy={lossy}", raw, "-o", opt])
            size = os.path.getsize(opt)
            if size <= a.cap:
                shutil.copyfile(opt, a.out)
                print(f"{a.out}: {width}px, {fps} fps, lossy {lossy}, {size / 1e6:.1f} MB")
                return
    sys.exit("Couldn't get the GIF under the cap; try a shorter clip.")

if __name__ == "__main__":
    main()
