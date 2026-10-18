#!/usr/bin/env python3
"""Chonkit GIFs: move new uploads from gifs/inbox onto the /gifs page.

For every video in gifs/inbox (named "Title - 12345.mp4"; the Chonk number is optional):
  - the MP4 goes to gifs/videos/ untouched (just rearranged so it starts playing sooner online);
    other formats (.mov, .webm, .m4v) are converted to a high-quality MP4
  - a poster picture is taken from it
  - the best GIF under 15 MB is made (see make_gif.py)
  - it's added to the top of gifs/videos.json, so it shows first on the page
  - the upload is removed from the inbox
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from make_gif import best_gif  # noqa: E402

INBOX, VIDEOS, LIST = (os.path.join(ROOT, "gifs", p) for p in ("inbox", "videos", "videos.json"))
EXTS = (".mp4", ".m4v", ".mov", ".webm")

def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
                          "-show_entries", "stream=width,height,r_frame_rate,nb_read_packets",
                          "-of", "json", path], check=True, capture_output=True, text=True).stdout
    s = json.loads(out)["streams"][0]
    n, d = (int(x) for x in s["r_frame_rate"].split("/"))
    return {"width": int(s["width"]), "height": int(s["height"]), "fps": round(n / d, 3) if n % d else n // d,
            "frames": int(s.get("nb_read_packets") or 0)}

def parse_name(stem):
    m = re.match(r"^(.*?)\s+[-–]\s+#?(\d{1,6})\s*$", stem)   # "Title - 12345" (spaces round the dash)
    title, chonk = (m.group(1), int(m.group(2))) if m else (stem, None)
    title = re.sub(r"[_]+", " ", title).strip() or "Untitled"
    return title, chonk

def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "clip"

def main():
    items = json.load(open(LIST)) if os.path.exists(LIST) else []
    uploads = sorted(f for f in os.listdir(INBOX) if f.lower().endswith(EXTS)) if os.path.isdir(INBOX) else []
    if not uploads:
        print("Nothing new in gifs/inbox."); return
    os.makedirs(VIDEOS, exist_ok=True)
    taken = {os.path.basename(i["file"]).rsplit(".", 1)[0] for i in items}
    for f in uploads:
        src = os.path.join(INBOX, f)
        stem = f.rsplit(".", 1)[0]
        title, chonk = parse_name(stem)
        base = slugify(title + (f" {chonk}" if chonk else "")); slug, k = base, 2
        while slug in taken: slug, k = f"{base}-{k}", k + 1
        taken.add(slug)
        mp4, jpg, gif = (os.path.join(VIDEOS, slug + e) for e in (".mp4", ".jpg", ".gif"))
        if f.lower().endswith(".mp4"):
            run(["ffmpeg", "-v", "error", "-y", "-i", src, "-c", "copy", "-movflags", "+faststart", mp4])
        else:
            run(["ffmpeg", "-v", "error", "-y", "-i", src, "-c:v", "libx264", "-crf", "16", "-preset", "slow",
                 "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", mp4])
        info = probe(mp4)
        secs = info["frames"] / info["fps"] if info["frames"] and info["fps"] else 1
        run(["ffmpeg", "-v", "error", "-y", "-ss", f"{min(2.5, secs / 4):.2f}", "-i", mp4, "-frames:v", "1",
             "-vf", "scale='min(720,iw)':-2", "-q:v", "3", jpg])
        g = best_gif(mp4, gif)
        item = {"file": f"videos/{slug}.mp4", "poster": f"videos/{slug}.jpg", "title": title}
        if chonk: item["chonk"] = chonk
        item.update(info)
        item.update({"gif": f"videos/{slug}.gif", "gifBytes": g["bytes"], "mp4Bytes": os.path.getsize(mp4)})
        items.insert(0, item)
        os.remove(src)
        print(f"Added {title}{f' (Chonk #{chonk})' if chonk else ''}: GIF {g['width']}px {g['fps']} fps, {g['bytes'] / 1e6:.1f} MB")
    with open(LIST, "w") as fh:
        fh.write(json.dumps(items, indent=2) + "\n")

if __name__ == "__main__":
    main()
