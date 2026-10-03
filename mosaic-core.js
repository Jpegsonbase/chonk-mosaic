/*
 * Chonk Mosaic – matching engine.
 * A direct port of the original Python matcher (same features, weights,
 * palette adaptation, reuse + recent penalties), plus a colour-grid
 * pre-filter so 83k Chonks can be searched in the browser in seconds.
 * Works in a Web Worker (importScripts) and in Node (require) for tests.
 */
(function (root) {
  "use strict";

  const DEFAULTS = {
    colorWeight: 0.45,
    fingerprintWeight: 0.30,
    brightnessWeight: 0.10,
    saturationWeight: 0.10,
    edgeWeight: 0.05,
    paletteAdaptation: 0.65,
    paletteAbundancePower: 0.65,
    reusePenalty: 0.15,
    recentMemory: 20,
    recentPenalty: 1.0,
    candidates: 1500,      // how many colour-nearest Chonks get the full score
    neighbourPenalty: 40,  // same Chonk touching itself (any of the 8 neighbours)
    centreOut: true,       // place from the middle outwards so the subject gets the best matches
  };

  // ------------------------------------------------------------ LAB
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
  }
  const EPS = 216 / 24389, KAPPA = 24389 / 27;
  const f = (t) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);

  function linToLab(r, g, b, out, o) {
    const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    const y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    const z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
    const fx = f(x), fy = f(y), fz = f(z);
    out[o] = 116 * fy - 16;
    out[o + 1] = 500 * (fx - fy);
    out[o + 2] = 200 * (fy - fz);
  }
  function rgbToLab(r, g, b, out, o) {
    // r,g,b may be fractional (averaged) — interpolate the LUT-free path.
    const lin = (v) => {
      const c = v / 255;
      return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
    };
    linToLab(lin(r), lin(g), lin(b), out, o);
  }

  // ------------------------------------------------------------ dataset
  function decodeFeatures(buffer, meta) {
    const bytes = new Uint8Array(buffer);
    const n = meta.count, fp = meta.fingerprint, cells = fp * fp, rb = meta.recordBytes;
    if (bytes.length < n * rb) throw new Error("features.bin is shorter than meta.json says");
    const lab = new Float32Array(n * 3);
    const bright = new Float32Array(n);
    const sat = new Float32Array(n);
    const edge = new Float32Array(n);
    const fpl = new Float32Array(n * cells * 3);
    for (let i = 0; i < n; i++) {
      const o = i * rb;
      lab[i * 3] = bytes[o] / 2.55;
      lab[i * 3 + 1] = bytes[o + 1] - 128;
      lab[i * 3 + 2] = bytes[o + 2] - 128;
      bright[i] = bytes[o + 3];
      sat[i] = bytes[o + 4] / 255;
      edge[i] = bytes[o + 5] / 4;
      for (let c = 0; c < cells; c++) {
        const s = o + 6 + c * 3, d = (i * cells + c) * 3;
        fpl[d] = bytes[s] / 2.55;
        fpl[d + 1] = bytes[s + 1] - 128;
        fpl[d + 2] = bytes[s + 2] - 128;
      }
    }
    return { n, fp, cells, lab, bright, sat, edge, fpl };
  }

  // ------------------------------------------------------------ palette
  function buildPalette(ds) {
    const buckets = new Map();
    for (let i = 0; i < ds.n; i++) {
      const a = ds.lab[i * 3 + 1], b = ds.lab[i * 3 + 2];
      const key = Math.round(a / 10) + "," + Math.round(b / 10);
      let k = buckets.get(key);
      if (!k) buckets.set(key, (k = { sa: 0, sb: 0, n: 0 }));
      k.sa += a; k.sb += b; k.n++;
    }
    const pts = [], counts = [];
    let max = 1;
    for (const k of buckets.values()) {
      pts.push([k.sa / k.n, k.sb / k.n]);
      counts.push(k.n);
      if (k.n > max) max = k.n;
    }
    return { pts, counts, max };
  }

  function adaptColour(lab, pal, s) {
    if (!pal.pts.length) return lab.slice();
    let best = 0, bestScore = Infinity;
    for (let i = 0; i < pal.pts.length; i++) {
      const da = pal.pts[i][0] - lab[1], db = pal.pts[i][1] - lab[2];
      const dist = Math.sqrt(da * da + db * db);
      const abundance = Math.pow(pal.counts[i] / pal.max, s.paletteAbundancePower);
      const score = dist / (1 + s.paletteAdaptation * abundance * 3);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    const t = Math.min(1, Math.max(0, s.paletteAdaptation));
    return [
      lab[0],
      lab[1] * (1 - t) + pal.pts[best][0] * t,
      lab[2] * (1 - t) + pal.pts[best][1] * t,
    ];
  }

  // ------------------------------------------------------------ colour grid
  const CELL = 8;
  function buildGrid(ds) {
    const map = new Map();
    for (let i = 0; i < ds.n; i++) {
      const key = cellKey(
        Math.floor(ds.lab[i * 3] / CELL),
        Math.floor(ds.lab[i * 3 + 1] / CELL),
        Math.floor(ds.lab[i * 3 + 2] / CELL));
      let arr = map.get(key);
      if (!arr) map.set(key, (arr = []));
      arr.push(i);
    }
    const grid = new Map();
    for (const [k, v] of map) grid.set(k, Int32Array.from(v));
    return grid;
  }
  const cellKey = (x, y, z) => ((x + 64) << 16) | ((y + 64) << 8) | (z + 64);

  function gatherCandidates(grid, lab, want, out) {
    const cx = Math.floor(lab[0] / CELL), cy = Math.floor(lab[1] / CELL), cz = Math.floor(lab[2] / CELL);
    let count = 0;
    for (let r = 0; r <= 32 && count < want; r++) {
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const arr = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
            if (!arr) continue;
            for (let j = 0; j < arr.length; j++) out[count++] = arr[j];
          }
    }
    return count;
  }

  // ------------------------------------------------------------ target tiles
  /**
   * rgba: Uint8ClampedArray of an image exactly cols*D x rows*D pixels
   * (already flattened onto white). Returns per-tile features.
   */
  function tileFeatures(rgba, width, tx, ty, D, fp, tmp) {
    const { labAcc, fpAcc, fpLab } = tmp;
    let L = 0, A = 0, B = 0, br = 0, sat = 0;
    const lum = tmp.lum;
    fpAcc.fill(0);
    const block = D / fp;
    for (let y = 0; y < D; y++) {
      for (let x = 0; x < D; x++) {
        const p = ((ty * D + y) * width + tx * D + x) * 4;
        const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
        linToLab(LIN[r], LIN[g], LIN[b], labAcc, 0);
        L += labAcc[0]; A += labAcc[1]; B += labAcc[2];
        const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
        lum[y * D + x] = l; br += l;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        sat += mx === 0 ? 0 : (mx - mn) / mx;
        const c = (Math.floor(y / block) * fp + Math.floor(x / block)) * 3;
        fpAcc[c] += r; fpAcc[c + 1] += g; fpAcc[c + 2] += b;
      }
    }
    const n = D * D;
    let h = 0, v = 0;
    for (let y = 0; y < D; y++) for (let x = 1; x < D; x++) h += Math.abs(lum[y * D + x] - lum[y * D + x - 1]);
    for (let y = 1; y < D; y++) for (let x = 0; x < D; x++) v += Math.abs(lum[y * D + x] - lum[(y - 1) * D + x]);
    // The Python version measures edges after upscaling the tile to 64x64,
    // which spreads each step over 64/D pixels — scale to match.
    const edge = ((h / (D * (D - 1)) + v / (D * (D - 1))) / 2) * (D / 64);
    const per = block * block;
    for (let c = 0; c < fp * fp; c++)
      rgbToLab(fpAcc[c * 3] / per, fpAcc[c * 3 + 1] / per, fpAcc[c * 3 + 2] / per, fpLab, c * 3);
    return { lab: [L / n, A / n, B / n], brightness: br / n, saturation: sat / n, edge, fp: fpLab };
  }

  // ------------------------------------------------------------ main loop
  /**
   * Returns Int32Array(cols*rows) of dataset indices.
   * onProgress(fraction) is called once per row.
   */
  function buildMosaic(ds, rgba, cols, rows, D, settings, onProgress, allowed) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const sub = allowed ? subset(ds, allowed) : null;
    const work = sub || ds;
    const pal = buildPalette(work);
    const grid = buildGrid(work);
    const map = sub ? sub.map : null;

    const usage = new Uint32Array(work.n);
    const recent = [];
    const result = new Int32Array(cols * rows);
    const cand = new Int32Array(work.n);
    const want = Math.min(work.n, Math.max(50, s.candidates | 0));
    const cells = work.cells;
    const tmp = {
      labAcc: new Float32Array(3),
      fpAcc: new Float32Array(work.fp * work.fp * 3),
      fpLab: new Float32Array(work.fp * work.fp * 3),
      lum: new Float32Array(D * D),
    };
    const width = cols * D;

    // Placement order: centre outwards (rings), or plain reading order.
    const total = cols * rows;
    const order = new Int32Array(total);
    for (let i = 0; i < total; i++) order[i] = i;
    if (s.centreOut) {
      const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
      const key = new Float64Array(total);
      for (let i = 0; i < total; i++) {
        const dx = (i % cols) - cx, dy = Math.floor(i / cols) - cy;
        key[i] = Math.round(Math.hypot(dx, dy) * 4) * 10 + (Math.atan2(dy, dx) + Math.PI);
      }
      order.sort((a, b) => key[a] - key[b]);
    }
    const placed = new Int32Array(total).fill(-1);   // in working indices
    const near = new Int32Array(8);
    const step = Math.max(1, Math.floor(total / 100));

    for (let n = 0; n < total; n++) {
      const pos0 = order[n], tx = pos0 % cols, ty = (pos0 / cols) | 0;
      {
        const t = tileFeatures(rgba, width, tx, ty, D, work.fp, tmp);
        const ad = adaptColour(t.lab, pal, s);
        const nc = gatherCandidates(grid, ad, want, cand);

        // Chonks already placed right next to this square.
        let nn = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const x = tx + ox, y = ty + oy;
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          const v = placed[y * cols + x];
          if (v >= 0) near[nn++] = v;
        }

        let best = -1, bestScore = Infinity;
        for (let k = 0; k < nc; k++) {
          const i = cand[k];
          const dl = ad[0] - work.lab[i * 3], da = ad[1] - work.lab[i * 3 + 1], db = ad[2] - work.lab[i * 3 + 2];
          let score = Math.sqrt(dl * dl + da * da + db * db) * s.colorWeight;
          score += Math.abs(t.brightness - work.bright[i]) * s.brightnessWeight;
          score += Math.abs(t.saturation - work.sat[i]) * 100 * s.saturationWeight;
          score += Math.abs(t.edge - work.edge[i]) * s.edgeWeight;
          score += usage[i] * s.reusePenalty;
          for (let q = 0; q < nn; q++) if (near[q] === i) { score += s.neighbourPenalty; break; }
          if (score >= bestScore) continue;           // cheap early exit
          let fsum = 0;
          const base = i * cells * 3;
          for (let c = 0; c < cells; c++) {
            const e = c * 3;
            const x = t.fp[e] - work.fpl[base + e], y = t.fp[e + 1] - work.fpl[base + e + 1], z = t.fp[e + 2] - work.fpl[base + e + 2];
            fsum += Math.sqrt(x * x + y * y + z * z);
          }
          score += (fsum / cells) * s.fingerprintWeight;
          const pos = recent.indexOf(i);
          if (pos >= 0) score += (recent.length - pos) * s.recentPenalty;
          if (score < bestScore) { bestScore = score; best = i; }
        }

        placed[pos0] = best;
        result[pos0] = best < 0 ? -1 : (map ? map[best] : best);
        if (best >= 0) {
          usage[best]++;
          const pos = recent.indexOf(best);
          if (pos >= 0) recent.splice(pos, 1);
          recent.unshift(best);
          if (recent.length > s.recentMemory) recent.pop();
        }
      }
      if (onProgress && ((n + 1) % step === 0 || n + 1 === total)) onProgress((n + 1) / total);
    }
    return result;
  }

  // Restrict matching to a set of dataset indices (e.g. "only my Chonks").
  function subset(ds, indices) {
    const n = indices.length, cells = ds.cells;
    const out = {
      n, fp: ds.fp, cells,
      lab: new Float32Array(n * 3), bright: new Float32Array(n), sat: new Float32Array(n),
      edge: new Float32Array(n), fpl: new Float32Array(n * cells * 3), map: Int32Array.from(indices),
    };
    indices.forEach((i, j) => {
      out.lab.set(ds.lab.subarray(i * 3, i * 3 + 3), j * 3);
      out.bright[j] = ds.bright[i]; out.sat[j] = ds.sat[i]; out.edge[j] = ds.edge[i];
      out.fpl.set(ds.fpl.subarray(i * cells * 3, (i + 1) * cells * 3), j * cells * 3);
    });
    return out;
  }

  const api = { DEFAULTS, decodeFeatures, buildMosaic, buildPalette, adaptColour, tileFeatures };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MosaicCore = api;
})(typeof self !== "undefined" ? self : this);
