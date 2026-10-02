/*
 * Zoom + pan for the finished mosaic.
 * Scroll / pinch to zoom, drag to move, double-click to zoom in,
 * keyboard + − 0 when the art is focused, and a full-screen button.
 */
(() => {
  "use strict";

  const vp = document.getElementById("viewport");
  const canvas = document.getElementById("mosaic");
  const level = document.getElementById("zoomLevel");
  const wall = document.querySelector(".wall");
  if (!vp || !canvas) return;

  const MAX = 6;               // 6 screen pixels per mosaic pixel
  let s = 1, x = 0, y = 0, fit = 1, atFit = true;

  function apply() {
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    // Smooth when shrunk, crisp pixels when enlarged.
    canvas.style.imageRendering = s >= 1 ? "pixelated" : "auto";
    level.textContent = `${Math.round(s / fit * 100)}%`;
  }

  function clamp() {
    const vw = vp.clientWidth, vh = vp.clientHeight;
    const w = canvas.width * s, h = canvas.height * s;
    x = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, x));
    y = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, y));
  }

  function zoomAt(next, px, py) {
    next = Math.min(Math.max(next, fit), Math.max(MAX, fit));
    // keep the point under (px, py) still
    x = px - (px - x) * (next / s);
    y = py - (py - y) * (next / s);
    s = next;
    atFit = s <= fit * 1.001;
    clamp(); apply();
  }
  const zoomCentre = (factor) => zoomAt(s * factor, vp.clientWidth / 2, vp.clientHeight / 2);

  function reset() {
    vp.hidden = false;
    const cols = canvas.width, rows = canvas.height;
    vp.style.aspectRatio = `${cols} / ${rows}`;
    requestAnimationFrame(() => {
      fit = Math.min(vp.clientWidth / cols, vp.clientHeight / rows);
      s = fit; atFit = true; clamp(); apply();
    });
  }

  // ---- wheel
  vp.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    zoomAt(s * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // ---- drag + pinch
  const pts = new Map();
  let moved = 0, pinch = null;
  vp.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".zoombar")) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s };
    }
    vp.classList.add("grabbing");
  });
  window.addEventListener("pointermove", (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const r = vp.getBoundingClientRect();
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(pinch.s * d / pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      moved += 10;
    } else if (pts.size === 1) {
      moved += Math.abs(dx) + Math.abs(dy);
      x += dx; y += dy; clamp(); apply();
    }
  });
  const end = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) vp.classList.remove("grabbing");
  };
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  // A drag shouldn't count as clicking a Chonk.
  vp.addEventListener("click", (e) => { if (moved > 5) { e.stopPropagation(); moved = 0; } }, true);

  vp.addEventListener("dblclick", (e) => {
    if (e.target.closest(".zoombar")) return;
    const r = vp.getBoundingClientRect();
    zoomAt(s * 2, e.clientX - r.left, e.clientY - r.top);
  });

  vp.addEventListener("keydown", (e) => {
    if (e.key === "+" || e.key === "=") { zoomCentre(1.4); e.preventDefault(); }
    else if (e.key === "-" || e.key === "_") { zoomCentre(1 / 1.4); e.preventDefault(); }
    else if (e.key === "0") { reset(); e.preventDefault(); }
  });

  // ---- buttons
  document.getElementById("zoomIn").addEventListener("click", () => zoomCentre(1.5));
  document.getElementById("zoomOut").addEventListener("click", () => zoomCentre(1 / 1.5));
  document.getElementById("zoomFit").addEventListener("click", reset);
  const fsBtn = document.getElementById("zoomFull");
  if (!document.fullscreenEnabled) fsBtn.hidden = true;
  fsBtn.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wall.requestFullscreen?.();
  });
  document.addEventListener("fullscreenchange", () => {
    fsBtn.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
    reset();
  });
  // Keep the current zoom when the window changes size (e.g. phone toolbars).
  window.addEventListener("resize", () => {
    if (vp.hidden) return;
    fit = Math.min(vp.clientWidth / canvas.width, vp.clientHeight / canvas.height);
    if (atFit || s < fit) s = fit;
    clamp(); apply();
  });

  window.MosaicZoom = { reset };
})();
