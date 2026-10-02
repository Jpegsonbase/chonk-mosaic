(() => {
  "use strict";

  const SAMPLE = 8;                 // pixels sampled per tile (like DETAIL=8 in the script)
  const MAX_SIDE = 16000;           // browser canvas limits
  const MAX_AREA = 160e6;

  const $ = (id) => document.getElementById(id);
  const el = {
    drop: $("drop"), file: $("file"), dropHint: $("dropHint"),
    cols: $("cols"), colsOut: $("colsOut"), gridNote: $("gridNote"),
    tile: $("tile"), tileOut: $("tileOut"), sizeNote: $("sizeNote"),
    source: $("source"), sourceNote: $("sourceNote"),
    variety: $("variety"), varOut: $("varOut"),
    go: $("go"), canvas: $("mosaic"), empty: $("empty"),
    phase: $("phase"), msg: $("msg"), progress: $("progress"),
    stats: $("stats"), dl: $("dl"), dlList: $("dlList"), tip: $("tip"),
    vArt: $("vArt"), vId: $("vId"), vGo: $("vGo"), vInfo: $("vInfo"), vTraits: $("vTraits"),
    rpc: $("rpc"), only: $("only"),
  };

  el.rpc.value = ChonkChain.DEFAULT_RPC;
  $("contractLink").href = `https://basescan.org/address/${ChonkChain.CHONKS_CONTRACT}`;

  const state = {
    meta: null, idToIndex: null, worker: null, ready: false,
    image: null, source: "atlas", busy: false,
    last: null, // { result, cols, rows, tile }
    atlases: new Map(),
  };

  // ---------------------------------------------------------------- status
  function setPhase(text, msg = "", p = null) {
    el.phase.textContent = text;
    el.msg.textContent = msg;
    if (p !== null) el.progress.style.width = `${Math.round(p * 100)}%`;
  }

  // ---------------------------------------------------------------- dataset
  async function loadDataset() {
    try {
      setPhase("Loading Chonk data…", "", 0.05);
      const meta = await (await fetch("data/meta.json")).json();
      const res = await fetch("data/features.bin");
      if (!res.ok) throw new Error("features.bin missing");
      const buffer = await res.arrayBuffer();
      state.meta = meta;
      state.idToIndex = new Map(meta.ids.map((id, i) => [id, i]));
      state.worker = new Worker("worker.js");
      state.worker.onmessage = onWorker;
      state.worker.postMessage({ type: "load", buffer, meta }, [buffer]);
      paintHero();
    } catch (err) {
      setPhase("Chonk data not found", "Run prep/build_dataset.py to create web/data/ — see README.", 0);
      el.go.textContent = "Data missing";
    }
  }

  // Hero: a wall of random Chonks from the first sprite sheet.
  async function paintHero() {
    const canvas = document.getElementById("hero");
    if (!canvas) return;
    try {
      const img = await loadAtlas(0);
      const { thumb, perAtlasSide, count } = state.meta;
      const per = Math.min(count, perAtlasSide * perAtlasSide);
      const cols = 8, rows = 6, size = canvas.width / cols;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const slot = Math.floor(Math.random() * per);
        ctx.drawImage(img, (slot % perAtlasSide) * thumb, Math.floor(slot / perAtlasSide) * thumb, thumb, thumb,
          c * size, r * size, size, size);
      }
      canvas.classList.add("on");
      const cap = document.getElementById("heroCap");
      if (cap) cap.textContent = `${cols * rows} of ${count.toLocaleString()} Chonks`;
    } catch (_) { /* hero stays plain */ }
  }

  let buildResolve = null, buildReject = null;
  function onWorker(e) {
    const m = e.data;
    if (m.type === "loaded") {
      state.ready = true;
      setPhase("Ready", `${m.count.toLocaleString()} Chonks loaded`, 0);
      refreshButton();
    } else if (m.type === "progress") {
      setPhase("Matching Chonks…", `${Math.round(m.value * 100)}%`, m.value * 0.6);
    } else if (m.type === "done") {
      buildResolve && buildResolve(m);
    } else if (m.type === "error") {
      buildReject ? buildReject(new Error(m.message)) : setPhase("Error", m.message);
    }
  }

  // ---------------------------------------------------------------- inputs
  function refreshButton() {
    el.go.disabled = !(state.ready && state.image) || state.busy;
    el.go.textContent = state.busy ? "Working…" : state.ready ? (state.image ? "Make mosaic" : "Pick a picture") : el.go.textContent;
  }

  function gridSize() {
    const cols = +el.cols.value;
    if (!state.image) return { cols, rows: 0 };
    const rows = Math.max(1, Math.round(cols * state.image.height / state.image.width));
    return { cols, rows };
  }

  function effectiveTile(cols, rows) {
    let t = +el.tile.value;
    while (t > 4 && (cols * t > MAX_SIDE || rows * t > MAX_SIDE || cols * rows * t * t > MAX_AREA)) t -= 1;
    return t;
  }

  function updateNotes() {
    const { cols, rows } = gridSize();
    el.colsOut.textContent = `${cols} across`;
    el.tileOut.textContent = `${el.tile.value} px`;
    if (!rows) return;
    el.gridNote.textContent = `${cols} × ${rows} grid = ${(cols * rows).toLocaleString()} Chonks`;
    const t = effectiveTile(cols, rows);
    const w = cols * t, h = rows * t;
    el.sizeNote.innerHTML = `Output ${w.toLocaleString()} × ${h.toLocaleString()} px` +
      (t !== +el.tile.value ? ` <span class="warn">(capped to ${t}px per Chonk for your browser)</span>` : "");
  }

  function varietySettings() {
    const v = +el.variety.value;
    el.varOut.textContent = v < 12 ? "closest match" : v < 50 ? "balanced" : v < 80 ? "varied" : "max variety";
    return { reusePenalty: v / 200 };
  }

  function loadFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      state.image = img;
      el.drop.querySelectorAll("img").forEach((n) => n.remove());
      const preview = img.cloneNode();
      el.dropHint.style.display = "none";
      el.drop.appendChild(preview);
      updateNotes();
      refreshButton();
    };
    img.src = url;
  }

  el.file.addEventListener("change", () => loadFile(el.file.files[0]));
  ["dragenter", "dragover"].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove("over"); }));
  el.drop.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));
  window.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) loadFile(item.getAsFile());
  });
  el.cols.addEventListener("input", updateNotes);
  el.tile.addEventListener("input", updateNotes);
  el.variety.addEventListener("input", varietySettings);
  el.source.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    el.source.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    state.source = b.dataset.v;
    el.sourceNote.textContent = state.source === "atlas"
      ? "Uses pre-rendered Chonk thumbnails — instant."
      : "Draws each Chonk live from the Base contract (current traits). Slower for big mosaics.";
  });
  varietySettings();

  function parseOnly(text) {
    text = text.trim();
    if (!text) return null;
    const idx = [];
    for (const part of text.split(/[\s,]+/)) {
      if (!part) continue;
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      const a = +m[1], b = m[2] ? +m[2] : a;
      for (let id = Math.min(a, b); id <= Math.max(a, b); id++) {
        const i = state.idToIndex.get(id);
        if (i !== undefined) idx.push(i);
      }
    }
    return idx.length ? Int32Array.from(new Set(idx)) : null;
  }

  function readSettings() {
    const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
    return Object.assign({
      colorWeight: num("w_color", 0.45),
      fingerprintWeight: num("w_fp", 0.30),
      brightnessWeight: num("w_bright", 0.10),
      saturationWeight: num("w_sat", 0.10),
      edgeWeight: num("w_edge", 0.05),
      paletteAdaptation: num("p_adapt", 0.65),
      recentMemory: Math.max(0, Math.round(num("r_mem", 20))),
      candidates: Math.max(100, Math.round(num("cands", 1500))),
    }, varietySettings());
  }

  // ---------------------------------------------------------------- build
  async function build() {
    if (!state.ready || !state.image || state.busy) return;
    state.busy = true; refreshButton();
    if (window.innerWidth < 960) document.querySelector(".wall")?.scrollIntoView({ behavior: "smooth", block: "start" });
    el.dl.disabled = el.dlList.disabled = true;
    try {
      const { cols, rows } = gridSize();
      const tile = effectiveTile(cols, rows);

      // 1. Sample the target picture: cols*8 x rows*8, flattened on white.
      setPhase("Reading your picture…", "", 0.02);
      const c = document.createElement("canvas");
      c.width = cols * SAMPLE; c.height = rows * SAMPLE;
      const cx = c.getContext("2d", { willReadFrequently: true });
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height);
      cx.imageSmoothingQuality = "high";
      cx.drawImage(state.image, 0, 0, c.width, c.height);
      const rgba = cx.getImageData(0, 0, c.width, c.height).data;

      // 2. Match in the worker.
      const allowed = parseOnly(el.only.value);
      const done = await new Promise((resolve, reject) => {
        buildResolve = resolve; buildReject = reject;
        state.worker.postMessage({
          type: "build", rgba, cols, rows, D: SAMPLE, settings: readSettings(), allowed,
        }, [rgba.buffer]);
      });
      buildResolve = buildReject = null;
      const result = done.result;
      state.last = { result, cols, rows, tile };

      // 3. Draw.
      const used = new Map(); // index -> [tile positions]
      result.forEach((idx, pos) => {
        if (idx < 0) return;
        let arr = used.get(idx); if (!arr) used.set(idx, (arr = [])); arr.push(pos);
      });
      $("sTiles").textContent = result.length.toLocaleString();
      $("sUnique").textContent = used.size.toLocaleString();
      $("sSize").textContent = `${cols * tile}×${rows * tile}`;
      $("sTime").textContent = `${(done.ms / 1000).toFixed(1)}s`;
      el.stats.style.display = "";

      const canvas = el.canvas;
      canvas.width = cols * tile; canvas.height = rows * tile;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      el.empty.style.display = "none"; canvas.style.display = "block";
      window.MosaicZoom && MosaicZoom.reset();

      await drawFromAtlases(ctx, used, cols, tile);
      if (state.source === "chain") await drawFromChain(ctx, used, cols, tile);

      setPhase("Done", `${used.size.toLocaleString()} different Chonks`, 1);
      el.dl.disabled = el.dlList.disabled = false;
    } catch (err) {
      console.error(err);
      setPhase("Something went wrong", err.message || String(err));
    } finally {
      state.busy = false; refreshButton();
    }
  }

  function loadAtlas(n) {
    if (!state.atlases.has(n)) {
      const name = `data/atlas/atlas_${String(n).padStart(3, "0")}.${state.meta.atlasFormat || "webp"}`;
      state.atlases.set(n, new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => { state.atlases.delete(n); reject(new Error(`missing ${name}`)); };
        img.src = name;
      }));
    }
    return state.atlases.get(n);
  }

  async function drawFromAtlases(ctx, used, cols, tile) {
    const { thumb, perAtlasSide } = state.meta;
    const per = perAtlasSide * perAtlasSide;
    const byAtlas = new Map();
    for (const idx of used.keys()) {
      const a = Math.floor(idx / per);
      if (!byAtlas.has(a)) byAtlas.set(a, []);
      byAtlas.get(a).push(idx);
    }
    let n = 0;
    for (const [a, list] of byAtlas) {
      setPhase("Painting Chonks…", `sheet ${++n} of ${byAtlas.size}`, 0.6 + 0.4 * (n / byAtlas.size) * (state.source === "chain" ? 0.25 : 1));
      let img;
      try { img = await loadAtlas(a); } catch (_) { continue; }
      for (const idx of list) {
        const slot = idx % per;
        const sx = (slot % perAtlasSide) * thumb, sy = Math.floor(slot / perAtlasSide) * thumb;
        for (const pos of used.get(idx)) {
          ctx.drawImage(img, sx, sy, thumb, thumb, (pos % cols) * tile, Math.floor(pos / cols) * tile, tile, tile);
        }
      }
    }
  }

  async function drawFromChain(ctx, used, cols, tile) {
    const ids = [...used.keys()].map((i) => state.meta.ids[i]);
    const indexOf = (id) => state.idToIndex.get(id);
    let drawn = 0;
    const images = await ChonkChain.getManyChonkImages(ids, {
      rpc: el.rpc.value.trim() || undefined,
      onProgress: (p) => setPhase("Fetching Chonks from Base…", `${Math.round(p * ids.length).toLocaleString()} / ${ids.length.toLocaleString()}`, 0.7 + 0.3 * p),
    });
    for (const [id, img] of images) {
      for (const pos of used.get(indexOf(id))) {
        const x = (pos % cols) * tile, y = Math.floor(pos / cols) * tile;
        ctx.fillStyle = "#fff"; ctx.fillRect(x, y, tile, tile);
        ctx.drawImage(img, x, y, tile, tile);
      }
      drawn++;
    }
    if (drawn < ids.length) {
      el.msg.textContent = `${ids.length - drawn} Chonks fell back to cached art (RPC busy)`;
    }
  }

  el.go.addEventListener("click", build);

  // ---------------------------------------------------------------- export
  el.dl.addEventListener("click", () => {
    try {
      el.canvas.toBlob((blob) => {
        if (!blob) return setPhase("Export failed", "Image too large for this browser — try a smaller Chonk size.");
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `chonk-mosaic-${Date.now()}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, "image/png");
    } catch (err) {
      setPhase("Export blocked", "The browser refused to export onchain SVGs — switch to Fast mode and rebuild.");
    }
  });

  el.dlList.addEventListener("click", () => {
    const { result, cols } = state.last;
    const lines = ["row,col,chonk_id"];
    result.forEach((idx, pos) => lines.push(`${Math.floor(pos / cols)},${pos % cols},${idx >= 0 ? state.meta.ids[idx] : ""}`));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = "chonk-mosaic-tiles.csv";
    a.click();
  });

  // ---------------------------------------------------------------- hover + viewer
  function tileAt(e) {
    if (!state.last) return null;
    const r = el.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * el.canvas.width;
    const y = (e.clientY - r.top) / r.height * el.canvas.height;
    const { cols, rows, tile, result } = state.last;
    const c = Math.floor(x / tile), rr = Math.floor(y / tile);
    if (c < 0 || rr < 0 || c >= cols || rr >= rows) return null;
    const idx = result[rr * cols + c];
    return idx >= 0 ? state.meta.ids[idx] : null;
  }
  el.canvas.addEventListener("mousemove", (e) => {
    const id = tileAt(e);
    if (id == null) { el.tip.style.display = "none"; return; }
    el.tip.textContent = `Chonk #${id}`;
    el.tip.style.display = "block";
    el.tip.style.left = `${e.clientX + 14}px`;
    el.tip.style.top = `${e.clientY + 14}px`;
  });
  el.canvas.addEventListener("mouseleave", () => { el.tip.style.display = "none"; });
  el.canvas.addEventListener("click", (e) => {
    const id = tileAt(e);
    if (id != null) { el.vId.value = id; showChonk(id); }
  });

  async function showChonk(id) {
    id = parseInt(id, 10);
    if (!Number.isFinite(id)) return;
    el.vInfo.textContent = `Reading Chonk #${id} from Base…`;
    el.vTraits.innerHTML = "";
    el.vArt.innerHTML = "";
    try {
      const meta = await ChonkChain.getChonkMeta(id, el.rpc.value.trim() || undefined);
      const img = new Image();
      img.alt = `Chonk #${id}`;
      img.src = meta.image && !meta.image.trim().startsWith("<")
        ? meta.image
        : URL.createObjectURL(new Blob([meta.image || meta.image_data], { type: "image/svg+xml" }));
      el.vArt.appendChild(img);
      el.vInfo.textContent = meta.name || `Chonk #${id}`;
      for (const t of meta.attributes || []) {
        const s = document.createElement("span");
        s.textContent = t.trait_type ? `${t.trait_type}: ${t.value}` : String(t.value);
        el.vTraits.appendChild(s);
      }
    } catch (err) {
      el.vInfo.textContent = `Couldn't read Chonk #${id}: ${err.message}`;
    }
  }
  el.vGo.addEventListener("click", () => showChonk(el.vId.value));
  el.vId.addEventListener("keydown", (e) => { if (e.key === "Enter") showChonk(el.vId.value); });

  updateNotes();
  loadDataset();
})();
