/*
 * Chonkit – your mosaic gallery, kept in this browser (IndexedDB).
 * Shared by the mosaic maker (index.html) and the 3D gallery (gallery.html).
 * Each entry: { id, created, title, tiles, w, h, blob (JPEG) }
 */
(function (root) {
  "use strict";
  const DB = "chonkit-gallery", STORE = "mosaics", VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      let idb = null; try { idb = root.indexedDB; } catch (_) {}
      if (!idb) return reject(new Error("This browser can't store a gallery."));
      const req = idb.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = () => { const db = req.result; db.onclose = () => { dbp = null; }; db.onversionchange = () => { db.close(); dbp = null; }; resolve(db); };
      req.onerror = () => reject(req.error || new Error("Couldn't open the gallery."));
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      let t;
      try { t = db.transaction(STORE, mode); } catch (e) { dbp = null; reject(e); return; }   // connection went stale: reopen next time
      const s = t.objectStore(STORE);
      let out; const r = fn(s);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = t.onabort = () => reject(t.error || new Error("Gallery storage failed."));
    }));
  }

  /** Save a canvas to the gallery as a JPEG (longest side <= maxSide). Returns the new id. */
  async function addCanvas(canvas, { title = "Untitled", tiles = 0, maxSide = 2048, quality = 0.9 } = {}) {
    const k = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const w = Math.max(1, Math.round(canvas.width * k)), h = Math.max(1, Math.round(canvas.height * k));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.drawImage(canvas, 0, 0, w, h);
    const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't save the picture."))), "image/jpeg", quality));
    return tx("readwrite", (s) => s.add({ created: Date.now(), title, tiles, w, h, blob }));
  }
  /** All mosaics, newest first. */
  async function list() {
    const all = (await tx("readonly", (s) => s.getAll())) || [];
    return all.sort((a, b) => b.created - a.created);
  }
  const remove = (id) => tx("readwrite", (s) => s.delete(id));
  const count = () => tx("readonly", (s) => s.count());

  let ok = false; try { ok = !!root.indexedDB; } catch (_) {}
  root.ChonkitGallery = { addCanvas, list, remove, count, supported: ok };
})(window);
