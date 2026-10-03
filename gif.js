/*
 * Chonkit – GIF maker.
 * Turns the finished mosaic (the on-screen canvas) into a looping GIF:
 *   zoom:   starts on a single Chonk and pulls back to the whole picture
 *   reveal: the original picture turns into Chonks from the centre outwards
 * Uses the bundled gifenc encoder (vendor/gifenc.js, MIT).
 */
(function (root) {
  "use strict";

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const ease = (t) => t * t * (3 - 2 * t);

  /**
   * opts: { mosaic (canvas), original (canvas), cols, rows, style, maxSide, onProgress }
   * Returns a Blob (image/gif).
   */
  async function makeGif(opts) {
    const { GIFEncoder, quantize, applyPalette } = root.gifenc;
    const { mosaic, original, cols, rows, style, onProgress } = opts;
    const maxSide = opts.maxSide || 600;
    const k = maxSide / Math.max(mosaic.width, mosaic.height);
    const W = Math.max(2, Math.round(mosaic.width * k)), H = Math.max(2, Math.round(mosaic.height * k));
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const ctx = out.getContext("2d", { willReadFrequently: true });

    // the finished mosaic at GIF size (used for the last frames and the palette)
    const small = document.createElement("canvas");
    small.width = W; small.height = H;
    const sctx = small.getContext("2d");
    sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = "high";
    sctx.drawImage(mosaic, 0, 0, W, H);

    const frames = [];          // { draw: fn, delay }
    if (style === "reveal") {
      const orig = document.createElement("canvas");
      orig.width = W; orig.height = H;
      const octx = orig.getContext("2d");
      octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = "high";
      octx.drawImage(original, 0, 0, W, H);
      // tiles ordered by distance from the centre
      const order = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        order.push({ x, y, d: Math.hypot(x + 0.5 - cols / 2, (y + 0.5 - rows / 2) * 1.0) + Math.random() * 1.5 });
      }
      order.sort((a, b) => a.d - b.d);
      const steps = 28, tw = W / cols, th = H / rows;
      let shown = 0;
      frames.push({ delay: 700, draw: () => ctx.drawImage(orig, 0, 0) });
      for (let s = 1; s <= steps; s++) {
        const upto = Math.round(order.length * ease(s / steps));
        const batch = order.slice(shown, upto); shown = upto;
        frames.push({
          delay: 60,
          draw: () => {
            for (const t of batch) {
              const x0 = Math.floor(t.x * tw), y0 = Math.floor(t.y * th);
              const x1 = Math.ceil((t.x + 1) * tw), y1 = Math.ceil((t.y + 1) * th);
              ctx.drawImage(small, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
            }
          },
        });
      }
      frames[frames.length - 1].delay = 2200;
    } else {
      // zoom out: from one Chonk near the centre to the whole mosaic
      const tile = mosaic.width / cols;
      const cx = (Math.floor(cols / 2) + 0.5) * tile, cy = (Math.floor(rows / 2) + 0.5) * tile;
      const startW = tile * 1.4, endW = mosaic.width;
      const steps = 34;
      for (let s = 0; s <= steps; s++) {
        const t = ease(s / steps);
        const w = startW * Math.pow(endW / startW, t), h = w * H / W;
        let x0 = cx - w / 2 + (w / 2 - cx) * t, y0 = cy - h / 2 + (h / 2 - cy) * t;
        x0 = Math.min(Math.max(0, x0), mosaic.width - w);
        y0 = Math.min(Math.max(0, y0), mosaic.height - h);
        frames.push({
          delay: s === 0 ? 900 : s === steps ? 2200 : 55,
          draw: () => {
            const zoomedIn = w < W;            // enlarging: keep Chonk pixels crisp
            ctx.imageSmoothingEnabled = !zoomedIn;
            ctx.imageSmoothingQuality = "high";
            if (s === steps) ctx.drawImage(small, 0, 0);
            else ctx.drawImage(mosaic, x0, y0, w, h, 0, 0, W, H);
          },
        });
      }
    }

    // one palette for the whole GIF, built from the first and last frames
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    frames[0].draw();
    const first = ctx.getImageData(0, 0, W, H).data;
    const last = sctx.getImageData(0, 0, W, H).data;
    const sample = new Uint8ClampedArray(first.length + last.length);
    sample.set(first); sample.set(last, first.length);
    const palette = quantize(sample, 256);

    const gif = GIFEncoder();
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < frames.length; i++) {
      frames[i].draw();
      const data = ctx.getImageData(0, 0, W, H).data;
      gif.writeFrame(applyPalette(data, palette), W, H, { palette, delay: frames[i].delay, repeat: 0 });
      if (onProgress) onProgress((i + 1) / frames.length);
      await tick();
    }
    gif.finish();
    return new Blob([gif.bytes()], { type: "image/gif" });
  }

  root.ChonkGif = { makeGif, supported: () => !!root.gifenc };
})(window);
