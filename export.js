/*
 * Full-size PNG export, built in strips.
 * Only one row of Chonks is ever drawn at a time, so the finished image can
 * be far bigger than the browser's canvas limit. Each strip is compressed
 * straight into a single standard PNG file.
 */
(function (root) {
  "use strict";

  const supported = typeof CompressionStream !== "undefined";

  const CRC = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    CRC[n] = c >>> 0;
  }
  function crc32(bytes, crc = 0xFFFFFFFF) {
    for (let i = 0; i < bytes.length; i++) crc = CRC[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return crc;
  }
  function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    const crc = crc32(data, crc32(out.subarray(4, 8))) ^ 0xFFFFFFFF;
    dv.setUint32(8 + data.length, crc >>> 0);
    return out;
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /**
   * opts: { cols, rows, tile, indexAt(pos), drawTile(ctx, idx, x, y, size), onProgress(f), signal }
   * Returns a Blob containing one PNG of cols*tile x rows*tile pixels (RGB, white background).
   */
  async function exportPng(opts) {
    if (!supported) throw new Error("This browser can't build full-size images. Try Chrome, Edge, Firefox or Safari 16.4+.");
    const { cols, rows, tile, indexAt, drawTile, onProgress } = opts;
    const W = cols * tile, H = rows * tile;
    const rowBytes = W * 3;

    // Header
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, W); dv.setUint32(4, H);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 2;  // RGB
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr)];

    // Compressed data flows out of the stream into IDAT chunks. Every ~32 MB is
    // folded into a Blob so the browser can move it out of page memory.
    const cs = new CompressionStream("deflate");
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    let pending = [], pendingBytes = 0, idats = [], idatBytes = 0;
    const flushIdat = () => {
      if (!pendingBytes) return;
      const data = new Uint8Array(pendingBytes);
      let o = 0;
      for (const p of pending) { data.set(p, o); o += p.length; }
      idats.push(pngChunk("IDAT", data));
      idatBytes += data.length;
      pending = []; pendingBytes = 0;
      if (idatBytes > 32 * 1024 * 1024) { parts.push(new Blob(idats)); idats = []; idatBytes = 0; }
    };
    const collect = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending.push(value); pendingBytes += value.length;
        if (pendingBytes >= 1024 * 1024) flushIdat();
      }
      flushIdat();
      if (idats.length) parts.push(new Blob(idats));
    })();

    // Draw in pieces no wider than 8192 px (safe on every browser).
    const chunkCols = Math.max(1, Math.floor(8192 / tile));
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(cols, chunkCols) * tile;
    canvas.height = tile;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;

    const strip = new Uint8Array(tile * rowBytes);
    const prev = new Uint8Array(rowBytes);

    for (let r = 0; r < rows; r++) {
      if (opts.signal && opts.signal.aborted) throw new Error("Cancelled");
      for (let c0 = 0; c0 < cols; c0 += chunkCols) {
        const n = Math.min(chunkCols, cols - c0), pw = n * tile;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, pw, tile);
        for (let c = 0; c < n; c++) drawTile(ctx, indexAt(r * cols + c0 + c), c * tile, 0, tile);
        const px = ctx.getImageData(0, 0, pw, tile).data;
        for (let y = 0; y < tile; y++) {
          let s = y * pw * 4, d = y * rowBytes + c0 * tile * 3;
          for (let x = 0; x < pw; x++, s += 4, d += 3) {
            strip[d] = px[s]; strip[d + 1] = px[s + 1]; strip[d + 2] = px[s + 2];
          }
        }
      }
      // "Up" filter: store each scanline as the difference from the one above.
      // Chonks are blocky, so most lines become zeros and compress to almost nothing.
      const out = new Uint8Array(tile * (rowBytes + 1));
      for (let y = 0; y < tile; y++) {
        const line = strip.subarray(y * rowBytes, (y + 1) * rowBytes);
        const o = y * (rowBytes + 1);
        out[o] = 2;
        for (let i = 0; i < rowBytes; i++) out[o + 1 + i] = (line[i] - prev[i]) & 255;
        prev.set(line);
      }
      await writer.ready;
      writer.write(out);
      if (onProgress) onProgress((r + 1) / rows);
      await tick();
    }
    await writer.close();
    await collect;
    parts.push(pngChunk("IEND", new Uint8Array(0)));
    return new Blob(parts, { type: "image/png" });
  }

  root.ChonkExport = { supported, exportPng };
})(window);
