(() => {
  "use strict";

  const SAMPLE = 8;                 // pixels sampled per tile (like DETAIL=8 in the script)
  // Biggest mosaic image this device can safely hold in one canvas.
  // iPhones/iPads cap canvases at ~16.7M pixels; other phones and low-memory
  // computers run out of memory well before the desktop limits.
  const DEVICE = (() => {
    const ua = navigator.userAgent || "";
    const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const mobile = ios || /Android|Mobi/i.test(ua);
    const mem = navigator.deviceMemory || 8; // GB, Chrome/Edge only
    // fullSide/fullArea: limits for the strip-built "Download full size" PNG.
    if (ios) return { ios: true, mobile: true, name: "on your phone", side: 8192, area: 16.7e6, fullSide: 20000, fullArea: 150e6 };
    if (mobile) return { mobile: true, name: "on your phone", side: 12000, area: mem <= 4 ? 30e6 : 50e6, fullSide: 24000, fullArea: mem <= 4 ? 150e6 : 250e6 };
    return { mobile: false, name: "in your browser", side: 16000, area: mem <= 4 ? 80e6 : 160e6, fullSide: 32000, fullArea: mem <= 4 ? 400e6 : 1e9 };
  })();
  const MAX_SIDE = DEVICE.side;
  const MAX_AREA = DEVICE.area;

  const $ = (id) => document.getElementById(id);
  const el = {
    drop: $("drop"), file: $("file"), dropHint: $("dropHint"),
    cols: $("cols"), colsOut: $("colsOut"), gridNote: $("gridNote"),
    tile: $("tile"), tileOut: $("tileOut"), sizeNote: $("sizeNote"), resetSize: $("resetSize"),
    source: $("source"), sourceNote: $("sourceNote"),
    variety: $("variety"), varOut: $("varOut"),
    go: $("go"), canvas: $("mosaic"), empty: $("empty"),
    phase: $("phase"), msg: $("msg"), progress: $("progress"),
    stats: $("stats"), dl: $("dl"), dlFull: $("dlFull"), tip: $("tip"),
    vArt: $("vArt"), vId: $("vId"), vGo: $("vGo"), vInfo: $("vInfo"), vTraits: $("vTraits"),
    rpc: $("rpc"),
    shape: $("shape"), shapeNote: $("shapeNote"), pickId: $("pickId"), pickGo: $("pickGo"), pickRandom: $("pickRandom"),
    tryExample: $("tryExample"), changePic: $("changePic"), makeGif: $("makeGif"),
    pool: $("pool"), poolNote: $("poolNote"), walletRow: $("walletRow"), wallet: $("wallet"), walletGo: $("walletGo"),
    gap: $("gap"), gapNote: $("gapNote"), share: $("share"), artTitle: $("artTitle"), original: $("original"),
    zoomRow: $("zoomRow"), cropZoom: $("cropZoom"), cropZoomOut: $("cropZoomOut"), rotate: $("rotate"),
    cancel: $("cancelBuild"), controls: document.querySelector(".controls"),
  };

  el.rpc.value = ChonkChain.DEFAULT_RPC;
  $("contractLink").href = `https://basescan.org/address/${ChonkChain.CHONKS_CONTRACT}`;

  const state = {
    meta: null, idToIndex: null, worker: null, ready: false,
    image: null, label: null, shape: "original", cropX: 0.5, cropY: 0.5,
    srcImage: null, rotation: 0, zoom: 1,   // picture as loaded; quarter turns; crop zoom (1–3)
    job: null, fullAbort: null,             // the running build (for Cancel); full-size export's AbortController
    pool: "all", walletIdx: null, walletAddr: "", gap: "none", source: "atlas", busy: false,
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
      const meta = await (await fetch("data/meta.json", { cache: "no-cache" })).json();
      const res = await fetch(`data/features.bin?b=${meta.built || 0}`);
      if (!res.ok) throw new Error("features.bin missing");
      const buffer = await res.arrayBuffer();
      state.meta = meta;
      if (meta.built) {
        const d = new Date(meta.built * 1000);
        const dd = document.getElementById("dataDate");
        if (dd) dd.textContent = `Chonk images saved ${d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}.`;
      }
      state.idToIndex = new Map(meta.ids.map((id, i) => [id, i]));
      startWorker(buffer);
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
      const sheet = SMALL() || BIG(), thumb = sheet.thumb;
      const img = await loadAtlas(0, sheet);
      const { perAtlasSide, count } = state.meta;
      const per = Math.min(count, perAtlasSide * perAtlasSide);
      const cols = 8, rows = 6, size = thumb * Math.max(1, Math.round(canvas.width / cols / thumb));
      canvas.width = cols * size; canvas.height = rows * size;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const slot = Math.floor(Math.random() * per);
        ctx.drawImage(img, (slot % perAtlasSide) * thumb, Math.floor(slot / perAtlasSide) * thumb, thumb, thumb,
          c * size, r * size, size, size);
      }
      canvas.classList.add("on");
      const cap = document.getElementById("heroCap");
      if (cap) cap.textContent = `${cols * rows} of ${collectionSize().toLocaleString()} Chonks`;
    } catch (_) { /* hero stays plain */ }
  }

  // Size of the whole collection: live from the contract when available,
  // otherwise the number of Chonks in the saved data.
  const collectionSize = () => state.totalSupply || (state.meta ? state.meta.count : 0);

  // Starts a matcher worker. The first time the features are already fetched;
  // after a Cancel the old worker is thrown away and a new one re-reads
  // features.bin (straight from the browser cache). state.workerReady settles
  // once the "load" message is posted; messages after it queue in order.
  function startWorker(buffer = null) {
    const meta = state.meta;
    const w = new Worker("worker.js?v=42");
    state.worker = w;
    w.onmessage = onWorker;
    w.onerror = (e) => {
      e.preventDefault?.();
      if (w !== state.worker) return;
      if (buildReject) { buildReject(new Error("The matcher stopped (your device may be low on memory). Try a lower Detail and press Chonk it again.")); buildResolve = buildReject = null; }
      else if (!state.ready) { setPhase("Couldn't start the matcher", "Refresh the page to try again.", 0); el.go.textContent = "Refresh to retry"; }
    };
    state.workerReady = (async () => {
      if (!buffer) {
        const res = await fetch(`data/features.bin?b=${meta.built || 0}`);
        if (!res.ok) throw new Error("Couldn't reload the Chonk data. Check your connection and refresh the page.");
        buffer = await res.arrayBuffer();
      }
      if (w === state.worker) w.postMessage({ type: "load", buffer, meta }, [buffer]);
    })();
    state.workerReady.catch(() => {});
    return state.workerReady;
  }
  function restartWorker() {
    const old = state.worker;
    if (old) { old.onmessage = old.onerror = null; old.terminate(); }
    startWorker();
  }

  let buildResolve = null, buildReject = null;
  function onWorker(e) {
    const m = e.data;
    if (m.type === "loaded") {
      if (state.ready) return;            // a fresh worker after Cancel: nothing else to do
      state.ready = true;
      restoreLastPicture();
      setPhase("Ready", `${collectionSize().toLocaleString()} Chonks in the collection`, 0);
      // Read the real collection size from the contract and update the labels.
      ChonkChain.getTotalSupply(el.rpc.value.trim() || undefined).then((n) => {
        if (!(n > 0)) return;
        state.totalSupply = n;
        if (el.phase.textContent === "Ready" && /in the collection$/.test(el.msg.textContent)) {
          el.msg.textContent = `${n.toLocaleString()} Chonks in the collection`;
        }
        const cap = document.getElementById("heroCap");
        if (cap && /^\d+ of /.test(cap.textContent)) cap.textContent = cap.textContent.replace(/of [\d,]+ Chonks/, `of ${n.toLocaleString()} Chonks`);
      }).catch(() => { /* keep the saved count */ });
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
    el.go.disabled = !(state.ready && state.image) || state.busy || !!state.gifBusy;
    el.go.textContent = state.busy ? "Working…" : state.ready ? (state.image ? "Chonk it" : "Pick a picture") : el.go.textContent;
    if (el.cancel) { el.cancel.hidden = !state.busy; el.cancel.disabled = false; }
    lockSettings(state.busy);
    if (typeof syncMobileGo === "function") syncMobileGo();
  }

  // While a build (or full-size export) runs, the settings can't be changed:
  // every control in the left panel is disabled except Chonk it / Cancel.
  function lockSettings(on) {
    const panel = el.controls; if (!panel) return;
    panel.classList.toggle("locked", on);
    if (on) {
      panel.querySelectorAll("input, button, select, textarea").forEach((n) => {
        if (n === el.go || n === el.cancel || n.disabled) return;
        n.disabled = true; n.dataset.locked = "1";
      });
      el.drop.tabIndex = -1;
    } else {
      panel.querySelectorAll("[data-locked]").forEach((n) => { n.disabled = false; delete n.dataset.locked; });
      el.drop.tabIndex = 0;
    }
  }

  // ---------------------------------------------------------------- shape / crop
  const DRAG = " Drag the box on your picture to place it; zoom in to frame it tighter.";
  const SHAPES = {
    original: { ratio: null, note: "Keeps your picture's shape." },
    square: { ratio: 1, note: "1:1, ready for a profile picture." + DRAG },
    banner: { ratio: 3, note: "3:1, the shape of an X header (1500 × 500)." + DRAG },
    "4:5": { ratio: 4 / 5, note: "4:5 portrait, the best fit for an Instagram post (1080 × 1350)." + DRAG },
    "16:9": { ratio: 16 / 9, note: "16:9 widescreen, for YouTube thumbnails, slides and wallpapers." + DRAG },
  };
  const imgW = (im) => im.naturalWidth || im.width;
  const imgH = (im) => im.naturalHeight || im.height;
  function cropRect() {
    const im = state.image, w = imgW(im), h = imgH(im);
    const ratio = SHAPES[state.shape].ratio;
    if (!ratio) return { sx: 0, sy: 0, sw: w, sh: h };
    // The biggest window of this shape, made smaller by the zoom.
    // cropX / cropY (0–1) say where it sits in the space left over; 0.5 is centred.
    let sw, sh;
    if (w / h > ratio) { sh = h; sw = h * ratio; } else { sw = w; sh = w / ratio; }
    const z = Math.min(3, Math.max(1, state.zoom || 1));
    sw /= z; sh /= z;
    return { sx: (w - sw) * state.cropX, sy: (h - sh) * state.cropY, sw, sh };
  }

  // Rotation: the picture is drawn turned into a canvas, and that canvas is
  // used as the picture everywhere else (crop, build, before/after, GIF).
  const ROT_MAX_SIDE = 4096, ROT_MAX_AREA = 16e6;
  function rotatedImage(src, quarter) {
    if (!quarter) return src;
    const w = imgW(src), h = imgH(src);
    const k = Math.min(1, ROT_MAX_SIDE / Math.max(w, h), Math.sqrt(ROT_MAX_AREA / (w * h)));
    const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
    const c = document.createElement("canvas");
    const swap = quarter % 2 === 1;
    c.width = swap ? dh : dw; c.height = swap ? dw : dh;
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = k < 1;
    x.imageSmoothingQuality = "high";
    x.translate(c.width / 2, c.height / 2);
    x.rotate(quarter * Math.PI / 2);
    x.drawImage(src, -dw / 2, -dh / 2, dw, dh);
    return c;
  }
  function syncCropTools() {
    const crop = !!SHAPES[state.shape].ratio;
    if (el.zoomRow) el.zoomRow.hidden = !crop;
    if (el.cropZoom) {
      el.cropZoom.value = state.zoom;
      el.cropZoom.disabled = !state.image || state.busy;
      el.cropZoomOut.textContent = `${(+state.zoom).toFixed(1)}×`;
    }
    if (el.rotate) el.rotate.disabled = !state.image || state.busy;
  }

  function gridSize() {
    const cols = +el.cols.value;
    if (!state.image) return { cols, rows: 0 };
    const { sw, sh } = cropRect();
    const rows = Math.max(1, Math.round(cols * sh / sw));
    return { cols, rows };
  }

  // Defaults for Detail and Chonk size (phones start at 30 px so the default fits their canvas).
  const DEFAULT_COLS = 80;
  const defaultTileIndex = () => (DEVICE.mobile ? 1 : 2);

  // Chonk sizes that keep every art pixel square (Chonks are drawn on a 30 px grid).
  const SIZES = [15, 30, 60, 90, 120];
  const chosenTile = () => SIZES[Math.min(SIZES.length - 1, Math.max(0, +el.tile.value | 0))];
  function effectiveTile(cols, rows) {
    const fits = (t) => cols * t <= MAX_SIDE && rows * t <= MAX_SIDE && cols * rows * t * t <= MAX_AREA;
    const want = chosenTile();
    for (let i = SIZES.indexOf(want); i >= 0; i--) if (fits(SIZES[i])) return SIZES[i];
    let t = SIZES[0] - 1;
    while (t > 4 && !fits(t)) t -= 1;
    return t;
  }

  function updateNotes() {
    const { cols, rows } = gridSize();
    el.colsOut.textContent = `${cols} across`;
    el.tileOut.textContent = `${chosenTile()} px`;
    el.resetSize.hidden = cols === DEFAULT_COLS && +el.tile.value === defaultTileIndex();
    if (!rows) return;
    el.gridNote.textContent = `${cols} × ${rows} grid = ${(cols * rows).toLocaleString()} Chonks`;
    const t = effectiveTile(cols, rows);
    const w = cols * t, h = rows * t;
    el.sizeNote.innerHTML = `Output ${w.toLocaleString()} × ${h.toLocaleString()} px` +
      (t !== chosenTile()
        ? `<br>Chonks set to ${t} px so the image fits ${DEVICE.name}. Lower the detail for bigger Chonks.`
        : "");
  }

  function varietySettings() {
    const v = +el.variety.value;
    el.varOut.textContent = v < 12 ? "closest match" : v < 50 ? "balanced" : v < 80 ? "varied" : "max variety";
    return { reusePenalty: v / 200 };
  }

  // Show the whole picture in the drop box. For Square / X banner, the part
  // outside the crop is dimmed and the crop box can be dragged into place.
  const cropping = () => !!(state.image && SHAPES[state.shape].ratio);
  function renderPreview() {
    if (!state.image) return;
    const w = imgW(state.image), h = imgH(state.image);
    const scale = Math.min(1, 640 / Math.max(w, h));
    let pv = el.drop.querySelector("canvas.preview");
    if (!pv) {
      pv = document.createElement("canvas"); pv.className = "preview"; el.drop.appendChild(pv);
      attachCropDrag(pv);
    }
    pv.width = Math.max(1, Math.round(w * scale)); pv.height = Math.max(1, Math.round(h * scale));
    const c = pv.getContext("2d");
    c.imageSmoothingEnabled = !state.label;          // keep Chonk pixels crisp
    c.fillStyle = "#fff"; c.fillRect(0, 0, pv.width, pv.height);
    c.drawImage(state.image, 0, 0, pv.width, pv.height);
    pv.classList.toggle("cropping", cropping());
    if (cropping()) {
      const { sx, sy, sw, sh } = cropRect();
      const x = sx * scale, y = sy * scale, cw = sw * scale, ch = sh * scale;
      c.fillStyle = "rgba(14, 18, 48, 0.6)";
      c.fillRect(0, 0, pv.width, y);
      c.fillRect(0, y + ch, pv.width, pv.height - y - ch);
      c.fillRect(0, y, x, ch);
      c.fillRect(x + cw, y, pv.width - x - cw, ch);
      const lw = Math.max(2, Math.round(pv.width / 160));
      c.strokeStyle = "#fff"; c.lineWidth = lw;
      c.strokeRect(x + lw / 2, y + lw / 2, cw - lw, ch - lw);
    }
    el.dropHint.style.display = "none";
    el.changePic.hidden = false;
    document.getElementById("clearPic").hidden = false;
  }

  // the × on the picture: back to an empty drop box (a mosaic already made stays on screen)
  function clearPicture() {
    if (state.busy) return;
    state.image = state.srcImage = null; state.label = state.fileTitle = null;
    state.cropX = state.cropY = 0.5; state.rotation = 0; state.zoom = 1;
    el.drop.querySelector("canvas.preview")?.remove();
    el.dropHint.style.display = "";
    el.changePic.hidden = true;
    document.getElementById("clearPic").hidden = true;
    el.pickId.value = ""; el.file.value = "";
    el.gridNote.textContent = "Choose a picture to see the grid.";
    el.sizeNote.textContent = "";
    if (!state.last) {
      const t = document.getElementById("emptyText"); if (t) t.textContent = "Choose a picture to get started.";
      el.tryExample.hidden = false;
    }
    lastPic = null; LastPic.clear().catch(() => {});
    syncCropTools(); updateNotes(); refreshButton();
    setPhase("Ready", "Picture removed", 0);
  }
  document.getElementById("clearPic").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); clearPicture(); });

  // Drag the crop box. Works with mouse and touch; a drag never opens the file picker.
  function attachCropDrag(pv) {
    let drag = null;
    pv.addEventListener("pointerdown", (e) => {
      if (!cropping() || state.busy) return;
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, cropX: state.cropX, cropY: state.cropY };
      pv.setPointerCapture(e.pointerId);
    });
    pv.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const r = pv.getBoundingClientRect();
      const w = imgW(state.image), h = imgH(state.image);
      const { sw, sh } = cropRect();
      const srcPerPx = w / r.width;
      const freeX = w - sw, freeY = h - sh;
      if (freeX > 0) state.cropX = Math.min(1, Math.max(0, drag.cropX + (e.clientX - drag.x) * srcPerPx / freeX));
      if (freeY > 0) state.cropY = Math.min(1, Math.max(0, drag.cropY + (e.clientY - drag.y) * srcPerPx / freeY));
      renderPreview();
    });
    const end = () => { if (drag) rememberCrop(); drag = null; };
    pv.addEventListener("pointerup", end);
    pv.addEventListener("pointercancel", end);
    // While cropping, clicking the picture shouldn't open the file picker.
    pv.addEventListener("click", (e) => { if (cropping()) e.preventDefault(); });
  }

  // a readable title from a file name, for the gallery label ("starry-night.jpg" -> "Starry night")
  function titleFromFile(name) {
    const base = String(name || "").replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
    if (!base || /^(image|pasted|img ?\d*|dsc ?\d*|photo ?\d*|screenshot.*|\d+)$/i.test(base)) return null;
    return base.charAt(0).toUpperCase() + base.slice(1);
  }
  function setPicture(img, label = null) {
    state.fileTitle = null;
    state.srcImage = img;
    state.image = img;
    state.label = label;
    state.cropX = state.cropY = 0.5;
    state.rotation = 0; state.zoom = 1;
    renderPreview();
    updateNotes();
    refreshButton();
    syncCropTools();
    const t = document.getElementById("emptyText");
    if (t) t.textContent = "Picture ready. Press Chonk it to build your mosaic.";
    el.tryExample.hidden = true;
  }

  // ---- paste hint (right-click menus only offer Paste in text boxes, so say Ctrl/⌘+V)
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const dropHow = document.getElementById("dropHow");
  if (dropHow) {
    if (DEVICE.mobile) dropHow.textContent = "or tap to choose a photo.";
    else if (isMac) dropHow.innerHTML = "or click to browse. Copied an image? Press <kbd>⌘</kbd>+<kbd>V</kbd>.";
  }

  function loadFile(file) {
    if (!file || state.busy) return;
    if (!file.type.startsWith("image/")) { setPhase("That file isn't a picture", "Choose a JPG, PNG, WebP or GIF.", 0); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); el.pickId.value = ""; setPicture(img, null); state.fileTitle = titleFromFile(file.name); rememberPicture(); if (!state.busy) setPhase("Ready", "Picture loaded", 0); };
    img.onerror = () => { URL.revokeObjectURL(url); setPhase("Couldn't open that picture", "Try a JPG or PNG. Some phone formats (like HEIC) don't open in every browser.", 0); };
    img.src = url;
  }

  // Use a Chonk itself as the picture: read live from the contract,
  // falling back to the saved thumbnail if the RPC is busy.
  async function loadChonkPicture(id) {
    id = parseInt(id, 10);
    if (!Number.isFinite(id) || !state.meta || state.busy) return;
    const idx = state.idToIndex.get(id);
    setPhase("Loading Chonk…", `#${id}`, 0);
    const SIZE = 600;
    const c = document.createElement("canvas");
    c.width = c.height = SIZE;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    let ok = false;
    try {
      const img = await ChonkChain.getChonkImage(id, el.rpc.value.trim() || undefined);
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      ctx.getImageData(0, 0, 1, 1); // throws if the browser blocks reading it
      ok = true;
    } catch (_) { /* fall back below */ }
    if (!ok && idx !== undefined) {
      try {
        const { perAtlasSide } = state.meta;
        const sheet = sheetFor(SIZE), thumb = sheet.thumb;
        const per = perAtlasSide * perAtlasSide;
        const atlas = await loadAtlas(Math.floor(idx / per), sheet);
        const slot = idx % per;
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.drawImage(atlas, (slot % perAtlasSide) * thumb, Math.floor(slot / perAtlasSide) * thumb, thumb, thumb, 0, 0, SIZE, SIZE);
        ok = true;
      } catch (_) { /* nothing */ }
    }
    if (!ok) { setPhase("Couldn't load that Chonk", `Check the ID and try again.`, 0); return; }
    if (state.busy) return;   // a build started while the Chonk was loading
    el.pickId.value = id;
    setPicture(c, `Chonk #${id}`);
    rememberPicture();
    setPhase("Ready", `Chonk #${id} loaded as your picture`, 0);
  }

  // ---------------------------------------------------------------- remember the last picture
  // A smaller copy of the last picture (plus its title, shape and crop) is kept
  // in IndexedDB so it's back after a reload. One record in its own database.
  const LastPic = (() => {
    const DB = "chonkit-last", STORE = "last", KEY = "picture";
    let dbp = null;
    function open() {
      if (!dbp) {
        dbp = new Promise((resolve, reject) => {
          let r;
          try { r = indexedDB.open(DB, 1); } catch (err) { reject(err); return; }
          r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
          r.onblocked = () => reject(new Error("blocked"));
        });
        dbp.catch(() => { dbp = null; });
      }
      return dbp;
    }
    async function run(mode, fn) {
      if (!window.indexedDB) throw new Error("IndexedDB unavailable");
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req.result);
        t.onerror = t.onabort = () => reject(t.error);
      });
    }
    return {
      get: () => run("readonly", (s) => s.get(KEY)),
      put: (v) => run("readwrite", (s) => s.put(v, KEY)),
      clear: () => run("readwrite", (s) => s.delete(KEY)),
    };
  })();

  let lastPic = null;   // { img, blob, label, fileTitle } for the picture on screen
  function rememberPicture() {
    const img = state.srcImage; if (!img) return;
    const label = state.label, fileTitle = state.fileTitle;
    try {
      const w = imgW(img), h = imgH(img), k = Math.min(1, 2048 / Math.max(w, h));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      const x = c.getContext("2d");
      x.imageSmoothingEnabled = !label; x.imageSmoothingQuality = "high";
      x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);   // JPEG has no transparency
      x.drawImage(img, 0, 0, c.width, c.height);
      // Chonks stay PNG so their pixels stay crisp (they're small anyway).
      c.toBlob((blob) => {
        if (!blob || state.srcImage !== img) return;
        lastPic = { img, blob, label, fileTitle };
        writeLastPic();
      }, label ? "image/png" : "image/jpeg", 0.9);
    } catch (_) { /* never mind */ }
  }
  function writeLastPic() {
    if (!lastPic || lastPic.img !== state.srcImage) return;
    LastPic.put({
      blob: lastPic.blob, label: lastPic.label, fileTitle: lastPic.fileTitle,
      shape: state.shape, cropX: state.cropX, cropY: state.cropY, zoom: state.zoom, rotation: state.rotation,
      saved: Date.now(),
    }).catch(() => {});
  }
  let cropTimer = 0;
  function rememberCrop() {
    clearTimeout(cropTimer);
    cropTimer = setTimeout(writeLastPic, 300);
  }
  async function restoreLastPicture() {
    try {
      const rec = await LastPic.get();
      if (!rec || !(rec.blob instanceof Blob) || state.image || state.busy) return;
      const url = URL.createObjectURL(rec.blob);
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = url;
      }).finally(() => URL.revokeObjectURL(url));
      if (state.image || state.busy) return;   // a picture was chosen meanwhile
      setPicture(img, rec.label || null);
      state.fileTitle = rec.fileTitle || null;
      lastPic = { img, blob: rec.blob, label: state.label, fileTitle: state.fileTitle };
      if (rec.shape && SHAPES[rec.shape] && rec.shape !== state.shape) el.shape.querySelector(`button[data-v="${rec.shape}"]`)?.click();
      const unit = (v) => (Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : 0.5);
      state.rotation = (rec.rotation | 0) & 3;
      state.image = rotatedImage(img, state.rotation);
      state.zoom = Number.isFinite(+rec.zoom) ? Math.min(3, Math.max(1, +rec.zoom)) : 1;
      state.cropX = unit(rec.cropX); state.cropY = unit(rec.cropY);
      const m = /^Chonk #(\d+)$/.exec(state.label || "");
      if (m) el.pickId.value = m[1];
      renderPreview(); updateNotes(); syncCropTools(); refreshButton();
      clearTimeout(cropTimer);
      setPhase("Ready", "Your last picture is back", 0);
    } catch (_) { /* no saved picture, or storage blocked: start fresh */ }
  }
  const randomChonkId = () => state.meta.ids[Math.floor(Math.random() * state.meta.ids.length)];
  el.pickGo.addEventListener("click", () => loadChonkPicture(el.pickId.value));
  el.pickId.addEventListener("keydown", (e) => { if (e.key === "Enter") loadChonkPicture(el.pickId.value); });
  el.pickRandom.addEventListener("click", () => state.meta && loadChonkPicture(randomChonkId()));
  el.tryExample.addEventListener("click", async () => {
    if (!state.ready) return;
    await loadChonkPicture(randomChonkId());
    if (state.image) build();
  });

  el.shape.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    el.shape.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    state.shape = b.dataset.v;
    el.shapeNote.textContent = SHAPES[state.shape].note;
    renderPreview(); updateNotes(); saveSettings(); syncCropTools(); rememberCrop();
  });
  if (el.cropZoom) el.cropZoom.addEventListener("input", () => {
    state.zoom = Math.min(3, Math.max(1, +el.cropZoom.value || 1));
    el.cropZoomOut.textContent = `${state.zoom.toFixed(1)}×`;
    renderPreview(); rememberCrop();
  });
  if (el.rotate) el.rotate.addEventListener("click", () => {
    if (!state.srcImage || state.busy) return;
    state.rotation = (state.rotation + 1) & 3;
    state.image = rotatedImage(state.srcImage, state.rotation);
    state.cropX = state.cropY = 0.5;
    renderPreview(); updateNotes(); rememberCrop();
  });

  el.file.addEventListener("change", () => loadFile(el.file.files[0]));
  el.changePic.addEventListener("click", () => { el.file.value = ""; el.file.click(); });
  // Keyboard: Enter or Space on the drop box opens the file picker.
  el.drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.file.value = ""; el.file.click(); }
  });

  // Phones: a Chonk it bar pinned to the bottom once a picture is chosen,
  // hidden while the real button is on screen.
  const mobileGo = document.getElementById("mobileGo");
  let goVisible = true;
  function syncMobileGo() {
    if (!mobileGo) return;
    // While building, the bar turns into a Cancel button.
    const show = !!state.image && !goVisible;
    mobileGo.classList.toggle("show", show);
    mobileGo.classList.toggle("cancel", state.busy);
    document.body.classList.toggle("has-mobile-go", show);
    mobileGo.textContent = state.busy ? "Cancel" : "Chonk it";
    mobileGo.disabled = state.busy ? false : el.go.disabled;
  }
  if (mobileGo && "IntersectionObserver" in window) {
    new IntersectionObserver(([en]) => { goVisible = en.isIntersecting; syncMobileGo(); }).observe(el.go);
    mobileGo.addEventListener("click", () => (state.busy ? cancelWork() : build()));
  }
  if (el.cancel) el.cancel.addEventListener("click", () => cancelWork());
  ["dragenter", "dragover"].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove("over"); }));
  el.drop.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));
  window.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) loadFile(item.getAsFile());
  });
  el.cols.addEventListener("input", updateNotes);
  el.tile.addEventListener("input", updateNotes);
  el.resetSize.addEventListener("click", () => {
    el.cols.value = DEFAULT_COLS;
    el.tile.value = defaultTileIndex();
    updateNotes();
    saveSettings();
    el.cols.focus();
  });
  el.variety.addEventListener("input", varietySettings);
  el.source.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    el.source.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    state.source = b.dataset.v;
    el.sourceNote.textContent = state.source === "atlas"
      ? "Uses saved Chonk images. Instant."
      : `Draws Chonks live from the contract on Base, with current traits. Slower; big mosaics fetch the ${ONCHAIN_LIMIT.toLocaleString()} most-used Chonks live and use saved art for the rest.`;
    saveSettings();
  });
  varietySettings();

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

  // ---------------------------------------------------------------- spacing
  const GAPS = {
    none: { bg: "#fff", note: "Chonks sit edge to edge." },
    white: { bg: "#fff", note: "A thin white line between every Chonk." },
    black: { bg: "#000", note: "A thin black line between every Chonk." },
  };
  // How far each Chonk is pulled in from its square (0 when there's no spacing).
  const gapInset = (gap, size) => (gap === "none" ? 0 : Math.max(1, Math.round(size * 0.05)));
  el.gap.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    el.gap.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    state.gap = b.dataset.v;
    el.gapNote.textContent = GAPS[state.gap].note;
    saveSettings();
  });

  // ---------------------------------------------------------------- wallet
  function setPool(v) {
    state.pool = v;
    el.pool.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === v));
    el.walletRow.hidden = v !== "wallet";
    if (v === "all") el.poolNote.textContent = "Picks from the whole collection.";
    else if (state.walletIdx) showWalletNote();
    else el.poolNote.textContent = "Paste a wallet address or ENS name to build only from the Chonks it holds.";
    saveSettings();
  }
  function showWalletNote() {
    const n = state.walletIdx.length;
    const shortAddr = `${state.walletAddr.slice(0, 6)}…${state.walletAddr.slice(-4)}`;
    const short = state.walletName ? `${state.walletName} (${shortAddr})` : shortAddr;
    el.poolNote.innerHTML = n
      ? `<span class="ok">${n.toLocaleString()} Chonk${n === 1 ? "" : "s"}</span> found in ${short}.` +
        (n < 40 ? " Mosaics look best with 40 or more, so expect lots of repeats." : "")
      : `No Chonks found in ${short}. Chonks listed for sale on a market may be held by the market instead.`;
  }
  async function loadWallet() {
    let input = el.wallet.value.trim();
    let addr = input, name = "";
    try {
      // Names: "jpegsonbase.eth", "name.base.eth", or just "jpegsonbase" (assumes .eth).
      if (input && !/^0x/i.test(input)) {
        name = input.includes(".") ? input : `${input}.eth`;
        el.poolNote.textContent = `Looking up ${name}…`;
        addr = await ChonkChain.resolveName(name, el.rpc.value.trim() || undefined);
        if (!addr) throw new Error(`${name} isn't linked to a wallet address.`);
      }
      el.poolNote.textContent = "Looking up wallet on Base…";
      const ids = await ChonkChain.getWalletChonks(addr, el.rpc.value.trim() || undefined);
      state.walletAddr = addr;
      state.walletName = name;
      state.walletFor = input;
      state.walletIdx = ids.map((id) => state.idToIndex.get(id)).filter((i) => i !== undefined);
      showWalletNote();
      saveSettings();
    } catch (err) {
      state.walletIdx = null;
      el.poolNote.textContent = err.message || "Couldn't read that wallet. Check the address and try again.";
    }
  }
  el.pool.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setPool(b.dataset.v); });
  el.walletGo.addEventListener("click", loadWallet);
  el.wallet.addEventListener("keydown", (e) => { if (e.key === "Enter") loadWallet(); });

  // ---------------------------------------------------------------- gallery
  // "Add to Gallery" keeps the finished mosaic in this browser; gallery.html hangs it in a 3D gallery.
  const addGalleryBtn = document.getElementById("addGallery");
  const openGalleryLink = document.getElementById("openGallery");
  const galBadge = document.getElementById("galBadge");
  function updateGalleryBadge() {
    if (!galBadge || !window.ChonkitGallery || !ChonkitGallery.supported) return;
    ChonkitGallery.count().then((n) => { galBadge.textContent = n; galBadge.hidden = !n; }).catch(() => {});
  }
  function galleryReset(busy) {
    if (!addGalleryBtn) return;
    const ok = window.ChonkitGallery && ChonkitGallery.supported;
    addGalleryBtn.hidden = !ok || !!(state.last && state.last.inGallery && !busy);
    addGalleryBtn.disabled = busy || !state.last;
    addGalleryBtn.textContent = "Add to Gallery";
    if (openGalleryLink) openGalleryLink.hidden = true;
  }
  // Add to Gallery first asks for a name (prefilled with the picture's title).
  const nameDlg = document.getElementById("nameDialog");
  const nameInput = document.getElementById("galName");
  const defaultName = () => String(state.last.label || state.last.fileTitle || "Untitled").slice(0, 40);
  if (nameDlg) {
    document.getElementById("nameCancel")?.addEventListener("click", () => nameDlg.close("cancel"));
    nameDlg.addEventListener("click", (e) => { if (e.target === nameDlg) nameDlg.close("cancel"); }); // click outside
    nameDlg.addEventListener("close", () => {
      if (nameDlg.returnValue === "add") addToGallery(nameInput.value.trim().slice(0, 40) || "Untitled");
    });
  }
  if (addGalleryBtn) {
    addGalleryBtn.addEventListener("click", () => {
      if (!state.last || state.busy) return;
      if (!nameDlg || !nameInput || typeof nameDlg.showModal !== "function") { addToGallery(defaultName()); return; }
      nameInput.value = defaultName();
      nameDlg.returnValue = "";
      nameDlg.showModal();
      nameInput.focus(); nameInput.select();
    });
  }
  async function addToGallery(title) {
    if (!state.last || state.busy || !addGalleryBtn) return;
    const last = state.last;
    addGalleryBtn.disabled = true; addGalleryBtn.textContent = "Adding…";
    try {
      await ChonkitGallery.addCanvas(el.canvas, { title, tiles: last.result.length });
      last.inGallery = true;
      if (state.last !== last) return;   // a new build started meanwhile
      addGalleryBtn.hidden = true;
      if (openGalleryLink) openGalleryLink.hidden = false;
      updateGalleryBadge();
    } catch (err) {
      console.error(err);
      if (state.last !== last) return;
      addGalleryBtn.disabled = false; addGalleryBtn.textContent = "Add to Gallery";
      setPhase("Couldn't add to the gallery", "Your browser may be out of storage space, or blocking it in private mode.", 1);
    }
  }
  updateGalleryBadge();

  // after a failed build, the previous mosaic is still on screen: let people save it again
  function restoreActions() {
    const { cols, rows, tile } = state.last;
    el.dl.disabled = false;
    if (el.dlFull) el.dlFull.disabled = !window.ChonkExport || !ChonkExport.supported || fullSizeTile(cols, rows) <= tile;
    if (el.makeGif) el.makeGif.disabled = !(window.ChonkGif && ChonkGif.supported());
    setShareEnabled(true);
    galleryReset(false);
  }

  // option buttons tell screen readers which one is chosen
  (function syncPressed() {
    const groups = ["shape", "source", "pool", "gap", "gifStyle"].map((id) => document.getElementById(id)).filter(Boolean);
    const sync = () => groups.forEach((g) => g.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.classList.contains("on"))));
    groups.forEach((g) => new MutationObserver(sync).observe(g, { subtree: true, attributes: true, attributeFilter: ["class"] }));
    sync();
  })();

  // ---------------------------------------------------------------- build
  // Cancel: the matcher can't be interrupted mid-match, so its worker is thrown
  // away and a fresh one started. Loading art stops at the next sprite sheet,
  // before the canvas is touched, so the last mosaic stays as it was. Fetching
  // live Chonks stops at the next batch and keeps saved art for the rest.
  const cancelError = () => Object.assign(new Error("Cancelled"), { cancelled: true });
  function cancelWork() {
    if (!state.busy) return;
    if (state.fullAbort) { state.fullAbort.abort(); setPhase("Cancelling…", ""); return; }
    const job = state.job;
    if (!job || job.cancelled) return;
    job.cancelled = true;
    if (el.cancel) el.cancel.disabled = true;
    setPhase("Cancelling…", "");
    if (buildReject) {
      const reject = buildReject;
      buildResolve = buildReject = null;
      restartWorker();
      reject(cancelError());
    }
    if (job.onCancel) job.onCancel();
  }

  async function build() {
    if (!state.ready || !state.image || state.busy) return;
    state.busy = true; refreshButton();
    if (window.innerWidth < 960) document.querySelector(".wall")?.scrollIntoView({ behavior: "smooth", block: "start" });
    el.dl.disabled = true;
    if (el.dlFull) el.dlFull.disabled = true;
    setShareEnabled(false);
    if (el.makeGif) el.makeGif.disabled = true;
    galleryReset(true);
    if (window.MosaicZoom && MosaicZoom.setCompare) MosaicZoom.setCompare(false);
    saveSettings();
    // freeze what this build is for, so changing the picture or options mid-build can't mix things up
    const job = { image: state.image, label: state.label, fileTitle: state.fileTitle, gap: state.gap, source: state.source, cancelled: false };
    state.job = job;
    const check = () => { if (job.cancelled) throw cancelError(); };
    if (!state.gifBusy) { gifJob++; resetGif(); }          // an old GIF belongs to the old mosaic
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
      const crop = cropRect();
      cx.drawImage(job.image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, c.width, c.height);
      const rgba = cx.getImageData(0, 0, c.width, c.height).data;

      // 2. Match in the worker.
      let allowed = null;
      if (state.pool === "wallet") {
        // (re)load the wallet if none is loaded or the box now holds a different one
        if (!state.walletIdx || (el.wallet.value.trim() && el.wallet.value.trim() !== state.walletFor)) { if (el.wallet.value.trim()) await loadWallet(); }
        check();
        if (!state.walletIdx || !state.walletIdx.length) throw new Error("Load a wallet that holds Chonks first (step 7), or switch to All Chonks.");
        allowed = Int32Array.from(state.walletIdx);
      }
      await state.workerReady;   // after a Cancel the new matcher may still be loading
      check();
      const done = await new Promise((resolve, reject) => {
        buildResolve = resolve; buildReject = reject;
        state.worker.postMessage({
          type: "build", rgba, cols, rows, D: SAMPLE, settings: readSettings(), allowed,
        }, [rgba.buffer]);
      });
      buildResolve = buildReject = null;
      check();
      const result = done.result;
      const used = new Map(); // index -> [tile positions]
      result.forEach((idx, pos) => {
        if (idx < 0) return;
        let arr = used.get(idx); if (!arr) used.set(idx, (arr = [])); arr.push(pos);
      });

      // 3. Load the art (can be cancelled between sheets; the canvas isn't touched yet).
      state.missingSheets = 0;
      const sheets = await loadSheets(used, tile, job);

      // 4. Draw.
      state.last = { result, cols, rows, tile, source: job.source, label: job.label, fileTitle: job.fileTitle, gap: job.gap };
      $("sTiles").textContent = result.length.toLocaleString();
      $("sUnique").textContent = used.size.toLocaleString();
      $("sSize").textContent = `${cols * tile}×${rows * tile}`;
      $("sTime").textContent = `${(done.ms / 1000).toFixed(1)}s`;
      el.stats.style.display = "";

      const canvas = el.canvas;
      canvas.width = cols * tile; canvas.height = rows * tile;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = GAPS[job.gap].bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
      el.empty.style.display = "none"; canvas.style.display = "block";
      if (window.MosaicZoom) MosaicZoom.reset();
      else {
        // zoom.js missing: just show the picture scaled to fit.
        const vp = document.getElementById("viewport");
        if (vp) vp.hidden = false;
        Object.assign(canvas.style, { position: "static", width: "100%", height: "auto" });
      }

      drawFromAtlases(ctx, used, cols, tile, sheets);
      let chainStopped = false;
      if (job.source === "chain") {
        try { await drawFromChain(ctx, used, cols, tile, job); }
        catch (err) { if (!err.cancelled) throw err; chainStopped = true; }
      }
      drawGapGrid(ctx, cols, rows, tile, job.gap);

      drawOriginal(crop, cols * tile, rows * tile, job);
      el.artTitle.textContent = (job.label || job.fileTitle) ? `${job.label || job.fileTitle}, rebuilt from Chonks` : "Untitled, Chonks on canvas";
      setShareEnabled(true);
      preparePhoto();
      if (el.makeGif) el.makeGif.disabled = !(window.ChonkGif && ChonkGif.supported());
      galleryReset(false);
      if (job.source !== "chain") state.onchainNote = "";
      if (chainStopped) setPhase("Cancelled", "Stopped fetching live Chonks. The rest use saved art.", 1);
      else setPhase("Done", state.missingSheets
        ? `Some Chonks couldn't load (blank squares). Check your connection and press Chonk it again.`
        : (job.source === "chain" && state.onchainNote) || `${used.size.toLocaleString()} different Chonks`, 1);
      el.dl.disabled = false;
      if (el.dlFull) {
        const ft = fullSizeTile(cols, rows);
        el.dlFull.disabled = !window.ChonkExport || !ChonkExport.supported || ft <= tile;
        el.dlFull.title = ft > tile
          ? `${(cols * ft).toLocaleString()} × ${(rows * ft).toLocaleString()} px, ${ft} px per Chonk`
          : "Your download is already the biggest size this device can make.";
      }
    } catch (err) {
      if (err && err.cancelled) {
        setPhase("Cancelled", state.last ? "Your last mosaic is still here." : "Press Chonk it when you're ready.", 0);
      } else {
        console.error(err);
        setPhase("Something went wrong", err.message || String(err));
      }
      if (state.last && el.canvas.width) restoreActions();
    } finally {
      if (buildReject && state.job === job) buildResolve = buildReject = null;
      job.onCancel = null;
      state.job = null;
      state.busy = false; refreshButton();
    }
  }

  // Two sets of sprite sheets: normal (e.g. 60 px) and light (30 px, if built).
  // Phones always use the light ones for the on-screen mosaic, which is about
  // a quarter of the download. Computers pick whichever divides evenly into the
  // Chonk size, so pixels stay square. Full-size downloads always use normal.
  const BIG = () => ({ prefix: "atlas", thumb: state.meta.thumb });
  const SMALL = () => (state.meta.smallThumb ? { prefix: "atlas_s", thumb: state.meta.smallThumb } : null);
  function sheetFor(drawSize) {
    const big = BIG(), small = SMALL();
    if (!small) return big;
    if (DEVICE.mobile) return small;
    if (drawSize % big.thumb === 0) return big;
    if (drawSize % small.thumb === 0) return small;
    return big;
  }

  function loadAtlas(n, sheet = BIG()) {
    const key = `${sheet.prefix}_${n}`;
    if (!state.atlases.has(key)) {
      const name = `data/atlas/${sheet.prefix}_${String(n).padStart(3, "0")}.${state.meta.atlasFormat || "webp"}`;
      state.atlases.set(key, new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => { state.atlases.delete(key); reject(new Error(`missing ${name}`)); };
        img.src = `${name}?b=${state.meta.built || 0}.${state.meta.thumb}`;
      }));
    }
    return state.atlases.get(key);
  }

  // Thin lines between Chonks are painted over the tile edges afterwards, so
  // the Chonks themselves keep their exact size and crisp pixels.
  function drawGapGrid(ctx, cols, rows, tile, gap) {
    const ins = gapInset(gap, tile);
    if (!ins) return;
    ctx.fillStyle = GAPS[gap].bg;
    for (let c = 0; c <= cols; c++) ctx.fillRect(c * tile - ins, 0, ins * 2, rows * tile);
    for (let r = 0; r <= rows; r++) ctx.fillRect(0, r * tile - ins, cols * tile, ins * 2);
  }

  // Loads every sprite sheet the mosaic needs, one at a time, checking for
  // Cancel between sheets. Returns [[img, indexes]] for drawFromAtlases.
  async function loadSheets(used, tile, job) {
    const sheet = sheetFor(tile);
    const per = state.meta.perAtlasSide * state.meta.perAtlasSide;
    const byAtlas = new Map();
    for (const idx of used.keys()) {
      const a = Math.floor(idx / per);
      if (!byAtlas.has(a)) byAtlas.set(a, []);
      byAtlas.get(a).push(idx);
    }
    const out = [];
    let n = 0;
    for (const [a, list] of byAtlas) {
      if (job.cancelled) throw cancelError();
      setPhase("Painting Chonks…", `sheet ${++n} of ${byAtlas.size}`, 0.6 + 0.4 * (n / byAtlas.size) * (job.source === "chain" ? 0.25 : 1));
      try { out.push([await loadAtlas(a, sheet), list]); } catch (_) { state.missingSheets = (state.missingSheets || 0) + 1; }
    }
    if (job.cancelled) throw cancelError();
    return { sheet, list: out };
  }

  function drawFromAtlases(ctx, used, cols, tile, sheets) {
    const thumb = sheets.sheet.thumb;
    const { perAtlasSide } = state.meta;
    ctx.imageSmoothingEnabled = tile < thumb;   // smooth only when shrinking
    ctx.imageSmoothingQuality = "high";
    const per = perAtlasSide * perAtlasSide;
    for (const [img, list] of sheets.list) {
      for (const idx of list) {
        const slot = idx % per;
        const sx = (slot % perAtlasSide) * thumb, sy = Math.floor(slot / perAtlasSide) * thumb;
        for (const pos of used.get(idx)) {
          ctx.drawImage(img, sx, sy, thumb, thumb, (pos % cols) * tile, Math.floor(pos / cols) * tile, tile, tile);
        }
      }
    }
  }

  // Onchain mode reads every Chonk from the free public Base server. For big
  // mosaics only the most-used Chonks are fetched live, so it stays quick and
  // the server isn't flooded; the rest keep their saved art.
  const ONCHAIN_LIMIT = 1500;
  function onchainPick(used) {
    const order = [...used.keys()].sort((a, b) => used.get(b).length - used.get(a).length);
    return order.slice(0, ONCHAIN_LIMIT);
  }

  async function drawFromChain(ctx, used, cols, tile, job) {
    const picked = onchainPick(used);
    const ids = picked.map((i) => state.meta.ids[i]);
    const indexOf = (id) => state.idToIndex.get(id);
    let drawn = 0;
    const fetching = ChonkChain.getManyChonkImages(ids, {
      rpc: el.rpc.value.trim() || undefined,
      onProgress: (p) => { if (!job.cancelled) setPhase("Fetching Chonks from Base…", `${Math.round(p * ids.length).toLocaleString()} / ${ids.length.toLocaleString()}`, 0.7 + 0.3 * p); },
    });
    fetching.catch(() => {});
    // Cancel stops waiting at once; batches already in flight just fill the cache.
    const images = await new Promise((resolve, reject) => {
      if (job.cancelled) { reject(cancelError()); return; }
      job.onCancel = () => reject(cancelError());
      fetching.then(resolve, reject);
    });
    job.onCancel = null;
    for (const [id, img] of images) {
      for (const pos of used.get(indexOf(id))) {
        const x = (pos % cols) * tile, y = Math.floor(pos / cols) * tile;
        ctx.fillStyle = "#fff"; ctx.fillRect(x, y, tile, tile);
        ctx.drawImage(img, x, y, tile, tile);
      }
      drawn++;
    }
    state.onchainNote = used.size > ONCHAIN_LIMIT
      ? `The ${ONCHAIN_LIMIT.toLocaleString()} most-used Chonks are live from Base; the other ${(used.size - ONCHAIN_LIMIT).toLocaleString()} use saved art.`
      : drawn < ids.length ? `${ids.length - drawn} Chonks used saved art (Base server busy).` : "";
  }

  el.go.addEventListener("click", build);

  // ---------------------------------------------------------------- export
  el.dl.addEventListener("click", () => {
    try {
      el.canvas.toBlob((blob) => {
        if (!blob) return setPhase("Export failed", "Image too large for this browser — try a smaller Chonk size.");
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `chonkit-${Date.now()}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, "image/png");
    } catch (err) {
      setPhase("Export blocked", "The browser refused to export onchain SVGs — switch to Fast mode and rebuild.");
    }
  });

  // ---------------------------------------------------------------- before / after
  // A lighter copy of the original picture, laid over the mosaic by zoom.js.
  function drawOriginal(crop, mw, mh, job = state) {
    const o = el.original; if (!o) return;
    const k = Math.min(1, 2048 / mw);
    o.width = Math.max(1, Math.round(mw * k)); o.height = Math.max(1, Math.round(mh * k));
    const c = o.getContext("2d");
    c.imageSmoothingEnabled = !job.label;
    c.fillStyle = "#fff"; c.fillRect(0, 0, o.width, o.height);
    c.drawImage(job.image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, o.width, o.height);
  }

  // ---------------------------------------------------------------- save to Photos (phones)
  // iPhone sends downloads to Files, and Photos refuses very large PNGs. So on
  // phones "Save to Photos" shares a Photos-sized JPEG (max 4096 px a side)
  // through the share sheet, whose "Save Image" puts it in Photos. If sharing
  // isn't possible, the picture opens full screen to press-and-hold save.
  // Download PNG is hidden on phones because it would only go to Files.
  const PHOTO_MAX = 4096;
  const canShareFiles = (() => {
    try {
      return !!(navigator.canShare && navigator.share &&
        navigator.canShare({ files: [new File([new Blob(["x"])], "t.jpg", { type: "image/jpeg" })] }));
    } catch (_) { return false; }
  })();
  const savePhotos = document.getElementById("savePhotos");
  if (DEVICE.mobile && savePhotos) {
    savePhotos.hidden = false;
    savePhotos.textContent = DEVICE.ios ? "Save to Photos" : "Save image";
    el.dl.hidden = true;
  }
  const pngName = (w, h) => `chonkit-${w}x${h}.png`;

  // Prepared right after each build, because sharing must start straight from a tap.
  function preparePhoto() {
    state.photo = null;
    if (!DEVICE.mobile || !savePhotos) return;
    savePhotos.disabled = true;
    const src = el.canvas;
    const k = Math.min(1, PHOTO_MAX / Math.max(src.width, src.height));
    let out = src;
    if (k < 1) {
      out = document.createElement("canvas");
      out.width = Math.round(src.width * k); out.height = Math.round(src.height * k);
      const c = out.getContext("2d");
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
      c.drawImage(src, 0, 0, out.width, out.height);
    }
    out.toBlob((b) => {
      if (!b) return;
      state.photo = { blob: b, name: `chonkit-${out.width}x${out.height}.jpg` };
      savePhotos.disabled = false;
    }, "image/jpeg", 0.92);
  }

  async function shareFile(blob, name, type) {
    try {
      await navigator.share({ files: [new File([blob], name, { type })] });
      return true;
    } catch (err) {
      return !!(err && err.name === "AbortError");   // closing the sheet isn't a failure
    }
  }
  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  // Fallback: show the picture so it can be pressed and held → Save to Photos.
  function showHoldToSave(blob) {
    const dlg = document.getElementById("holdDialog");
    const img = document.getElementById("holdImg");
    if (!dlg || !img || !dlg.showModal) { downloadBlob(blob, "chonkit.jpg"); return; }
    // Safari's press-and-hold menu has "Save to Photos". Firefox, Chrome, Edge
    // etc. on iPhone only offer "Share…", whose sheet has "Save Image".
    const ua = navigator.userAgent || "";
    const otherIOSBrowser = DEVICE.ios && /FxiOS|CriOS|EdgiOS|OPiOS|DuckDuckGo|GSA\//.test(ua);
    const how = document.getElementById("holdHow");
    if (how) how.innerHTML = otherIOSBrowser
      ? "This browser can't save straight to Photos. Press and hold the picture, tap <strong>Share… → Save to Files</strong>, " +
        "then open it in the <strong>Files</strong> app and tap <strong>Share → Save Image</strong>. " +
        "Or open this site in <strong>Safari</strong>, where you can press and hold → <strong>Save to Photos</strong>."
      : "<strong>Press and hold the picture</strong>, then tap <strong>Save to Photos</strong>.";
    const fr = new FileReader();
    fr.onload = () => { img.src = fr.result; dlg.showModal(); };
    fr.readAsDataURL(blob);
  }
  // iPhone: websites can't save straight into Photos (the share sheet only
  // offers Files), so show the picture to press and hold → Save to Photos.
  // Android and others: the share sheet works, so use it, with the same
  // press-and-hold screen as a fallback.
  if (savePhotos) savePhotos.addEventListener("click", async () => {
    if (!state.photo) return;
    if (!DEVICE.ios && canShareFiles && await shareFile(state.photo.blob, state.photo.name, "image/jpeg")) return;
    showHoldToSave(state.photo.blob);
  });
  const holdShare = document.getElementById("holdShare");
  if (holdShare) {
    holdShare.hidden = !canShareFiles;
    holdShare.addEventListener("click", () => {
      if (state.photo) shareFile(state.photo.blob, state.photo.name, "image/jpeg");
    });
  }

  // ---------------------------------------------------------------- share on X
  // Share on X is a real link to X's post composer. On phones, tapping it opens
  // the X app (if installed) with the post written; websites can't attach a
  // picture to it, so the post links back here and the image is added from Photos.
  function shareText() {
    const placed = state.last.result.length.toLocaleString();
    return state.last.label
      ? `${state.last.label}, rebuilt from ${placed} Chonks 🟨\n\nMade with Chonkit by @jpegsonbase`
      : `I turned my picture into a mosaic of ${placed} Chonks 🟨\n\nMade with Chonkit by @jpegsonbase`;
  }
  function setShareEnabled(on) {
    el.share.setAttribute("aria-disabled", String(!on));
    el.share.tabIndex = on ? 0 : -1;
    if (on && state.last) {
      const url = location.origin + location.pathname;
      el.share.href = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText())}&url=${encodeURIComponent(url)}`;
    } else {
      el.share.removeAttribute("href");
    }
  }
  setShareEnabled(false);
  el.share.addEventListener("click", (e) => {
    if (el.share.getAttribute("aria-disabled") === "true" || !state.last) { e.preventDefault(); return; }
    if (DEVICE.mobile) {
      // Let the link open the X app. Remind them to add the picture.
      setPhase("Opening X…", DEVICE.ios
        ? "Tap Save to Photos first if you haven't, then add the picture to your post from Photos."
        : "Save the image first if you haven't, then add it to your post.", 1);
      return;
    }
    el.dl.click(); // desktop: download the PNG so it's ready to attach
    setPhase("Post opened on X", "Your PNG is downloading. Attach it to the post.", 1);
  });

  // ---------------------------------------------------------------- GIF maker
  // Turns the finished mosaic into a looping GIF (zoom out, or reveal).
  const gifDlg = document.getElementById("gifDialog");
  const gifUi = {
    style: document.getElementById("gifStyle"), note: document.getElementById("gifNote"),
    go: document.getElementById("gifGo"), save: document.getElementById("gifSave"),
    status: document.getElementById("gifStatus"), preview: document.getElementById("gifPreview"),
    img: document.getElementById("gifImg"),
  };
  const GIF_NOTES = {
    zoom: "Starts on a single Chonk, then pulls back to show your whole picture.",
    reveal: "Your picture turns into Chonks, from the middle outwards.",
  };
  let gifStyle = "zoom", gifBlob = null, gifUrl = null, gifBusy = false, gifJob = 0;
  function resetGif() {
    gifBlob = null;
    gifUrl = null;
    gifUi.preview.hidden = true; gifUi.save.hidden = true;
    gifUi.go.textContent = "Make GIF"; gifUi.status.textContent = "";
  }
  if (gifDlg && el.makeGif) {
    el.makeGif.addEventListener("click", () => { if (!state.last) return; resetGif(); gifDlg.showModal(); });
    gifUi.style.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b || gifBusy) return;
      gifStyle = b.dataset.v;
      gifUi.style.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      gifUi.note.textContent = GIF_NOTES[gifStyle];
      resetGif();
    });
    gifUi.go.addEventListener("click", async () => {
      if (gifBusy || !state.last) return;
      gifBusy = state.gifBusy = true; resetGif(); refreshButton();
      gifUi.go.disabled = true; gifUi.go.textContent = "Making…";
      const job = ++gifJob;
      const snap = (src) => { const c = document.createElement("canvas"); c.width = src.width; c.height = src.height; c.getContext("2d").drawImage(src, 0, 0); return c; };
      try {
        const blob = await ChonkGif.makeGif({
          mosaic: snap(el.canvas), original: snap(el.original),
          cols: state.last.cols, rows: state.last.rows, style: gifStyle,
          maxSide: DEVICE.mobile ? 480 : 600,
          onProgress: (p) => { gifUi.status.textContent = `Making your GIF… ${Math.round(p * 100)}%`; },
        });
        if (job !== gifJob) return;                       // dialog was closed / a newer GIF started
        gifBlob = blob;
        // A data: URL (not blob:) so press-and-hold shares the GIF itself, not a link.
        gifUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(gifBlob); });
        gifUi.img.src = gifUrl;
        gifUi.preview.hidden = false;
        const otherIOS = DEVICE.ios && /FxiOS|CriOS|EdgiOS|OPiOS|DuckDuckGo|GSA\//.test(navigator.userAgent || "");
        gifUi.status.innerHTML = otherIOS
          ? `Ready (${(gifBlob.size / 1e6).toFixed(1)} MB). Tap <strong>Share…</strong> below, then <strong>Save to Files</strong>. To save it to Photos, open this site in <strong>Safari</strong>.`
          : DEVICE.ios
          ? `Ready (${(gifBlob.size / 1e6).toFixed(1)} MB). <strong>Press and hold the GIF</strong>, then tap <strong>Save to Photos</strong>. Or tap <strong>Share…</strong> to send it.`
          : `Ready (${(gifBlob.size / 1e6).toFixed(1)} MB).`;
        // iPhone: the button shares the GIF file (share sheet has Save to Files / Messages / X…)
        gifUi.save.hidden = DEVICE.ios && !canShareFiles;
        gifUi.save.textContent = DEVICE.mobile && canShareFiles ? "Share…" : "Download GIF";
        gifUi.go.textContent = "Make again";
      } catch (err) {
        console.error(err);
        gifUi.status.textContent = "Couldn't make the GIF. Try a smaller Detail setting and make the mosaic again.";
        gifUi.go.textContent = "Make GIF";
      } finally {
        gifBusy = state.gifBusy = false; gifUi.go.disabled = false; refreshButton();
      }
    });
    gifUi.save.addEventListener("click", async () => {
      if (!gifBlob) return;
      const name = `chonkit-${gifStyle}.gif`;
      if (DEVICE.mobile && canShareFiles && await shareFile(gifBlob, name, "image/gif")) return;
      downloadBlob(gifBlob, name);
    });
  }

  // ---------------------------------------------------------------- remember settings
  const SETTINGS_KEY = "chonk-settings";
  const SAVED_INPUTS = ["cols", "tile", "variety", "w_color", "w_fp", "w_bright", "w_sat", "w_edge", "p_adapt", "r_mem", "cands", "rpc"];
  function saveSettings() {
    const data = { source: state.source, shape: state.shape, gap: state.gap, pool: state.pool, wallet: el.wallet.value.trim() };
    for (const id of SAVED_INPUTS) { const n = $(id); if (n) data[id] = n.value; }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch (_) {}
  }
  function restoreSettings() {
    let data;
    try { data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch (_) {}
    if (!data) return;
    for (const id of SAVED_INPUTS) {
      const n = $(id);
      if (!n || data[id] == null || data[id] === "") continue;
      if (id === "tile" && +data[id] >= SIZES.length) continue;   // old saves stored pixels
      n.value = data[id];
    }
    if (data.source) el.source.querySelector(`button[data-v="${data.source}"]`)?.click();
    if (data.shape && SHAPES[data.shape]) el.shape.querySelector(`button[data-v="${data.shape}"]`)?.click();
    if (data.gap && GAPS[data.gap]) el.gap.querySelector(`button[data-v="${data.gap}"]`)?.click();
    if (data.wallet) el.wallet.value = data.wallet;
    if (data.pool === "wallet") setPool("wallet");
    varietySettings();
  }
  ["cols", "tile", "variety"].forEach((id) => $(id).addEventListener("change", saveSettings));

  // Reset advanced settings: defaults are the values written in the page.
  const ADV_IDS = ["w_color", "w_fp", "w_bright", "w_sat", "w_edge", "p_adapt", "r_mem", "cands", "rpc"];
  const advDefault = (n) => (n.id === "rpc" ? ChonkChain.DEFAULT_RPC : n.defaultValue);
  const resetAdv = document.getElementById("resetAdv");
  function updateResetAdv() {
    if (resetAdv) resetAdv.hidden = ADV_IDS.every((id) => { const n = $(id); return !n || n.value.trim() === advDefault(n); });
  }
  if (resetAdv) {
    resetAdv.addEventListener("click", () => {
      for (const id of ADV_IDS) { const n = $(id); if (n) n.value = advDefault(n); }
      saveSettings(); updateResetAdv();
    });
    ADV_IDS.forEach((id) => $(id)?.addEventListener("input", updateResetAdv));
  }
  document.querySelectorAll("details input").forEach((n) => n.addEventListener("change", saveSettings));

  // ---------------------------------------------------------------- full-size export
  // Biggest Chonk size the strip export can make here. Prefers whole-number
  // multiples of the saved thumbnail so pixels stay perfectly square.
  function fullSizeTile(cols, rows) {
    const base = state.meta.thumb;
    const fits = (t) => cols * t <= DEVICE.fullSide && rows * t <= DEVICE.fullSide && cols * rows * t * t <= DEVICE.fullArea;
    for (let k = 8; k >= 1; k--) if (fits(base * k)) return base * k;
    return Math.max(4, Math.floor(Math.min(DEVICE.fullSide / cols, DEVICE.fullSide / rows, Math.sqrt(DEVICE.fullArea / (cols * rows)))));
  }

  async function downloadFullSize() {
    if (!state.last || state.busy) return;
    const { result, cols, rows, source, gap } = state.last;
    const tile = fullSizeTile(cols, rows);
    const W = cols * tile, H = rows * tile;
    const abort = new AbortController();
    state.fullAbort = abort;
    const check = () => { if (abort.signal.aborted) throw cancelError(); };
    state.busy = true; refreshButton();
    el.dl.disabled = el.dlFull.disabled = true;
    try {
      // Gather art for every Chonk in the mosaic.
      const { thumb, perAtlasSide } = state.meta;
      const per = perAtlasSide * perAtlasSide;
      const used = [...new Set(result)].filter((i) => i >= 0);
      setPhase("Preparing full size…", `${W.toLocaleString()} × ${H.toLocaleString()} px`, 0);
      const atlasImgs = new Map();
      for (const a of new Set(used.map((i) => Math.floor(i / per)))) {
        check();
        try { atlasImgs.set(a, await loadAtlas(a, BIG())); } catch (_) { /* skip */ }
      }
      let chainImgs = null;
      if (source === "chain") {
        const counts = new Map();
        for (const i of result) if (i >= 0) counts.set(i, (counts.get(i) || 0) + 1);
        const live = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a)).slice(0, ONCHAIN_LIMIT);
        chainImgs = await ChonkChain.getManyChonkImages(live.map((i) => state.meta.ids[i]), {
          rpc: el.rpc.value.trim() || undefined,
          onProgress: (p) => { if (!abort.signal.aborted) setPhase("Fetching Chonks from Base…", `${Math.round(p * 100)}%`, p * 0.1); },
        });
      }
      check();
      const ins = gapInset(gap, tile);
      const drawTile = (ctx, idx, x, y, size) => {
        if (idx < 0) return;
        drawOne(ctx, idx, x, y, size);
        if (ins) {   // half a gap on each edge, matching the on-screen grid
          ctx.fillStyle = GAPS[gap].bg;
          ctx.fillRect(x, y, size, ins); ctx.fillRect(x, y + size - ins, size, ins);
          ctx.fillRect(x, y, ins, size); ctx.fillRect(x + size - ins, y, ins, size);
        }
      };
      const drawOne = (ctx, idx, x, y, size) => {
        const img = chainImgs && chainImgs.get(state.meta.ids[idx]);
        if (img) { ctx.drawImage(img, x, y, size, size); return; }
        const atlas = atlasImgs.get(Math.floor(idx / per));
        if (!atlas) return;
        const slot = idx % per;
        ctx.drawImage(atlas, (slot % perAtlasSide) * thumb, Math.floor(slot / perAtlasSide) * thumb, thumb, thumb, x, y, size, size);
      };

      const t0 = performance.now();
      const blob = await ChonkExport.exportPng({
        cols, rows, tile, drawTile, background: GAPS[gap].bg,
        indexAt: (pos) => result[pos], signal: abort.signal,
        onProgress: (p) => abort.signal.aborted || setPhase("Building full-size PNG…", `${W.toLocaleString()} × ${H.toLocaleString()} px · ${Math.round(p * 100)}%`, 0.1 + p * 0.9),
      });
      if (DEVICE.mobile) {
        // Phones need a fresh tap to save, so ask with a small "ready" pop-up.
        state.fullBlob = blob; state.fullName = pngName(W, H);
        const rd = document.getElementById("readyDialog");
        document.getElementById("readyDims").textContent = `${W.toLocaleString()} × ${H.toLocaleString()} px`;
        if (rd && rd.showModal) rd.showModal(); else downloadBlob(blob, state.fullName);
      } else {
        downloadBlob(blob, pngName(W, H));
      }
      setPhase(DEVICE.mobile ? "Full size ready" : "Full size saved", `${W.toLocaleString()} × ${H.toLocaleString()} px · ${(blob.size / 1e6).toFixed(1)} MB · ${((performance.now() - t0) / 1000).toFixed(0)}s`, 1);
    } catch (err) {
      if (abort.signal.aborted) setPhase("Cancelled", "Full-size download stopped.", 0);
      else { console.error(err); setPhase("Full-size download failed", err.message || String(err)); }
    } finally {
      state.fullAbort = null;
      state.busy = false; refreshButton();
      el.dl.disabled = el.dlFull.disabled = false;
    }
  }
  // Warn before the (possibly slow, large) full-size build starts.
  function confirmFullSize() {
    if (!state.last || state.busy) return;
    const { cols, rows } = state.last;
    const t = fullSizeTile(cols, rows);
    const dlg = document.getElementById("fullDialog");
    document.getElementById("fullDims").textContent =
      `${(cols * t).toLocaleString()} × ${(rows * t).toLocaleString()} px`;
    if (!dlg || typeof dlg.showModal !== "function") {
      if (window.confirm("A full-size image can take a minute or two to build and download. Keep this tab open until the download starts. Continue?")) downloadFullSize();
      return;
    }
    dlg.showModal();
  }
  const fullDlg = document.getElementById("fullDialog");
  if (fullDlg) {
    fullDlg.addEventListener("close", () => { if (fullDlg.returnValue === "go") downloadFullSize(); });
    fullDlg.addEventListener("click", (e) => { if (e.target === fullDlg) fullDlg.close("cancel"); }); // click outside
  }
  if (el.dlFull) el.dlFull.addEventListener("click", confirmFullSize);
  const readyDlg = document.getElementById("readyDialog");
  if (readyDlg) readyDlg.addEventListener("close", async () => {
    const blob = state.fullBlob; state.fullBlob = null;
    if (!blob) return;
    if (readyDlg.returnValue === "file") downloadBlob(blob, state.fullName);
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

  // ---------------------------------------------------------------- trait links
  // Chonks market trait pages: https://www.chonks.xyz/traits/<slug>?category=<n>
  // Category numbers follow the contract's TraitCategory order (Shoes = 7 is confirmed
  // by the market URL; the others follow the same order). Edit here if one is off.
  const TRAIT_CATEGORIES = {
    head: 1, hat: 1,
    hair: 2,
    face: 3,
    accessory: 4, accessories: 4,
    top: 5, tops: 5, shirt: 5,
    bottom: 6, bottoms: 6, pants: 6,
    shoes: 7, shoe: 7, footwear: 7,
  };
  const slugify = (v) => String(v).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  function traitUrl(t) {
    if (!t || !t.trait_type || t.value == null || t.value === "") return null;
    const cat = TRAIT_CATEGORIES[String(t.trait_type).trim().toLowerCase()];
    if (!cat) return null;               // not a tradeable trait (e.g. body, background)
    const slug = slugify(t.value);
    return slug ? `https://www.chonks.xyz/traits/${slug}?category=${cat}` : null;
  }

  let inspectReq = 0, inspectUrl = null;
  async function showChonk(id) {
    id = parseInt(id, 10);
    if (!Number.isFinite(id)) return;
    const req = ++inspectReq;
    el.vInfo.textContent = `Reading Chonk #${id} from Base…`;
    el.vTraits.innerHTML = "";
    el.vArt.innerHTML = "";
    try {
      const meta = await ChonkChain.getChonkMeta(id, el.rpc.value.trim() || undefined);
      if (req !== inspectReq) return;                       // a newer Chonk was asked for
      el.vArt.innerHTML = ""; el.vTraits.innerHTML = "";
      if (inspectUrl) { URL.revokeObjectURL(inspectUrl); inspectUrl = null; }
      const img = new Image();
      img.alt = `Chonk #${id}`;
      img.src = meta.image && !meta.image.trim().startsWith("<")
        ? meta.image
        : (inspectUrl = URL.createObjectURL(new Blob([meta.image || meta.image_data], { type: "image/svg+xml" })));
      el.vArt.appendChild(img);
      el.vInfo.textContent = meta.name || `Chonk #${id}`;
      for (const t of meta.attributes || []) {
        const text = t.trait_type ? `${t.trait_type}: ${t.value}` : String(t.value);
        const url = traitUrl(t);
        const chip = document.createElement(url ? "a" : "span");
        chip.textContent = text;
        if (url) {
          chip.href = url;
          chip.target = "_blank";
          chip.rel = "noopener";
          chip.title = `See ${t.value} on the Chonks market`;
        }
        el.vTraits.appendChild(chip);
      }
    } catch (err) {
      if (req !== inspectReq) return;
      el.vInfo.textContent = /not returned|execution reverted|nonexistent/i.test(err.message || "")
        ? `There's no Chonk #${id}. Check the ID.`
        : `Couldn't load Chonk #${id} from Base right now. Try again in a moment.`;
    }
  }
  el.vGo.addEventListener("click", () => showChonk(el.vId.value));
  el.vId.addEventListener("keydown", (e) => { if (e.key === "Enter") showChonk(el.vId.value); });

  // ---------------------------------------------------------------- Daily Chonk promo
  // Shows Chonk #30000 in today's outfit, read live from Base.
  (function promo() {
    const box = document.getElementById("promoArt");
    if (!box) return;
    const load = () => ChonkChain.getChonkImage(30000, el.rpc.value.trim() || undefined).then((img) => {
      const pic = new Image(); pic.alt = "Daily Chonk #30000 in today's outfit"; pic.src = img.src;
      box.replaceChildren(pic);
    }).catch(() => {});
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); load(); } }, { rootMargin: "200px" });
      io.observe(box);
    } else load();
  })();

  // ---------------------------------------------------------------- theme
  // Follows the device's light/dark setting until someone uses the toggle.
  // Choosing the same mode as the device clears the saved choice again.
  const themeBtn = document.getElementById("themeBtn");
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const root = document.documentElement;
  const currentTheme = () => root.dataset.theme || (darkQuery.matches ? "dark" : "light");
  function syncTheme() {
    const t = currentTheme();
    if (themeBtn) themeBtn.setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode");
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", t === "dark" ? "#0D1024" : "#FAFBFF"));
  }
  if (themeBtn) themeBtn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    const device = darkQuery.matches ? "dark" : "light";
    if (next === device) {
      delete root.dataset.theme;
      try { localStorage.removeItem("chonk-theme"); } catch (_) {}
    } else {
      root.dataset.theme = next;
      try { localStorage.setItem("chonk-theme", next); } catch (_) {}
    }
    syncTheme();
  });
  darkQuery.addEventListener("change", syncTheme);
  syncTheme();

  document.getElementById("dlList")?.remove();
  // Phones start at 30 px, which fits their canvas limit at the default detail.
  if (DEVICE.mobile) { try { if (!localStorage.getItem("chonk-settings")) el.tile.value = 1; } catch (_) { el.tile.value = 1; } }   // old button, in case an old page is cached
  restoreSettings();
  updateResetAdv();
  updateNotes();
  syncCropTools();
  loadDataset();
})();
