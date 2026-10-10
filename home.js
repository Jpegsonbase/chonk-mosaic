// Homepage hero: a framed "Chonk made of Chonks" with a Look closer window.
// Move the mouse over the picture (or tap it, or use the arrow keys) and the
// window shows that spot up close, so you can see the individual Chonks.
// A seasonal script can swap the artwork by setting window.CHONKIT_HERO_ART first.
(() => {
  const ART = window.CHONKIT_HERO_ART || [
    { src: "img/hero/chonk-15064.webp", sm: "img/hero/chonk-15064-640.webp", mid: "img/hero/chonk-15064-mid.webp", big: "img/hero/chonk-15064-big.webp", w: 1024, h: 1024,
      title: "Chonk #15064", line: "4,096 Chonks, 274 different", focus: [0.4, 0.43], across: 64, down: 64, unique: 274, file: "chonk-15064.png" },
    { src: "img/hero/chonk-13.webp", sm: "img/hero/chonk-13-640.webp", mid: "img/hero/chonk-13-mid.webp", big: "img/hero/chonk-13-big.webp", w: 1024, h: 1024,
      title: "Chonk #13", line: "4,096 Chonks, 435 different", focus: [0.42, 0.32], across: 64, down: 64, unique: 435, file: "chonk-13.png" },
    { src: "img/hero/chonk-1.webp", sm: "img/hero/chonk-1-640.webp", mid: "img/hero/chonk-1-mid.webp", big: "img/hero/chonk-1-big.webp", w: 1024, h: 1024,
      title: "Chonk #1", line: "4,096 Chonks, 341 different", focus: [0.42, 0.46], across: 64, down: 64, unique: 341, file: "chonk-1.png" },
  ];
  const ZOOM = 4;   // how much closer the window looks than the picture

  const $ = (id) => document.getElementById(id);
  const canvas = $("heroCanvas"), pic = $("heroPic"), lens = $("heroLens"), view = $("heroZoom");
  if (!canvas || !pic || !view) return;

  const art = ART[Math.floor(Math.random() * ART.length)];
  pic.width = art.w; pic.height = art.h;
  pic.alt = art.alt || `${art.title}, rebuilt from Chonks`;
  if (art.sm) {
    pic.srcset = `${art.sm} ${art.smW || 640}w, ${art.src} ${art.w}w`;
    pic.sizes = "(max-width: 900px) 90vw, 45vw";
  }
  pic.src = art.src;
  canvas.style.aspectRatio = `${art.w} / ${art.h}`;
  $("heroTitle").textContent = art.title;
  $("heroLine").textContent = art.line;
  const hint = $("heroHint");
  if (hint) hint.textContent = matchMedia("(hover: hover)").matches
    ? "Move over the picture to look closer" : "Tap the picture to look closer";

  // Phones get a lighter close-up picture (about half the size).
  const small = matchMedia("(max-width: 700px)").matches;
  const touch = matchMedia("(hover: none)").matches;
  const closeUp = (small && art.mid) || art.big;
  const shown = () => pic.currentSrc || art.src;
  view.style.backgroundImage = `url("${art.src}")`;
  pic.addEventListener("load", () => { if (!bigLoaded) view.style.backgroundImage = `url("${shown()}")`; });
  let bigLoaded = false;
  function loadBig() {
    if (bigLoaded || !closeUp) return;
    bigLoaded = true;
    const im = new Image();
    im.onload = () => { view.style.backgroundImage = `url("${closeUp}"), url("${shown()}")`; };
    im.src = closeUp;
  }

  let fx = art.focus ? art.focus[0] : 0.5, fy = art.focus ? art.focus[1] : 0.5;
  function draw() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const vw = view.clientWidth, vh = view.clientHeight;
    if (!cw || !vw) return;
    // Lens on the picture: the part the window is showing.
    const lw = vw / ZOOM, lh = vh / ZOOM;
    const lx = Math.min(Math.max(fx * cw - lw / 2, 0), cw - lw);
    const ly = Math.min(Math.max(fy * ch - lh / 2, 0), ch - lh);
    if (lens) { lens.style.width = lw + "px"; lens.style.height = lh + "px"; lens.style.transform = `translate(${lx}px, ${ly}px)`; }
    // Window: the same spot, ZOOM times bigger.
    const bw = cw * ZOOM, bh = ch * ZOOM;
    view.style.backgroundSize = `${bw}px ${bh}px`;
    view.style.backgroundPosition = `${-lx * ZOOM}px ${-ly * ZOOM}px`;
  }
  function aim(e) {
    const r = canvas.getBoundingClientRect();
    fx = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    fy = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1);
    loadBig(); draw();
  }
  canvas.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || e.buttons) aim(e); });
  canvas.addEventListener("pointerdown", aim);
  canvas.addEventListener("pointerenter", loadBig);
  canvas.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.03;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    fx = Math.min(Math.max(fx + d[0], 0), 1); fy = Math.min(Math.max(fy + d[1], 0), 1);
    loadBig(); draw();
  });
  addEventListener("resize", draw);
  if (pic.complete) draw(); else pic.addEventListener("load", draw);
  // Fetch the sharp close-up once the page has settled.
  addEventListener("load", () => setTimeout(loadBig, touch ? 2500 : 1500), { once: true });

  // Script console: types out the real matching code from mosaic-core.js,
  // then replays how the framed picture was built.
  const dlg = $("termDialog"), out = $("termOut"), skip = $("termSkip");
  if (dlg && out && $("termOpen")) {
    const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const KW = /\b(function|const|let|for|if|continue|break|return|new|of|else)\b/g;
    const paint = (line) => {
      const i = line.indexOf("//");
      const code = i >= 0 ? line.slice(0, i) : line, note = i >= 0 ? line.slice(i) : "";
      return esc(code).replace(KW, '<span class="k">$1</span>').replace(/\b(\d+(\.\d+)?)\b/g, '<span class="n">$1</span>')
        + (note ? `<span class="c">${esc(note)}</span>` : "");
    };
    let source = null, run = 0, skipping = false;
    async function getSource() {
      if (source) return source;
      try {
        const txt = await (await fetch("mosaic-core.js")).text();
        const a = txt.indexOf("  function buildMosaic"), b = txt.indexOf("\n  }\n", a);
        source = txt.slice(a, b + 4).split("\n").map((l) => l.replace(/^  /, ""));
      } catch (_) { source = ["// Couldn't load the script. Check your connection and try again."]; }
      return source;
    }
    const still = () => skipping || matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wait = (ms) => new Promise((r) => setTimeout(r, still() ? 0 : ms));
    const add = (html) => { out.insertAdjacentHTML("beforeend", html); out.scrollTop = out.scrollHeight; };
    async function type(text, id) {
      const span = document.createElement("span"); out.appendChild(span);
      for (let i = 0; i < text.length; i++) {
        if (id !== run) return;
        span.textContent += text[i];
        if (!still()) await wait(28);
      }
    }
    const fmt = (n) => n.toLocaleString("en-GB");
    async function play() {
      const id = ++run; skipping = false; skip.hidden = false; out.innerHTML = "";
      const lines = await getSource();
      add('<span class="p">$ </span>'); await type("cat mosaic-core.js", id); add("\n");
      for (let i = 0; i < lines.length; i++) {
        if (id !== run) return;
        add(paint(lines[i]) + "\n");
        if (i % 3 === 2) await wait(16);
      }
      const across = art.across || 64, down = art.down || 64, file = art.file || "picture.png";
      add('\n<span class="p">$ </span>'); await type(`chonkit build ${file} --across ${across}`, id); add("\n");
      await wait(350); add("  loading the Chonks collection ... "); await wait(500); add('<span class="ok">done</span>\n');
      add(`  reading ${esc(art.title)}: ${across} × ${down} squares\n`);
      add("  placing Chonks from the centre out\n  ");
      const bar = document.createElement("span"); out.appendChild(bar);
      for (let k = 0; k <= 24; k++) {
        if (id !== run) return;
        bar.textContent = "[" + "#".repeat(k) + ".".repeat(24 - k) + "] " + Math.round((k / 24) * 100) + "%";
        await wait(70);
      }
      add("\n");
      const tiles = across * down;
      add(`  <span class="ok">done</span>: ${fmt(tiles)} Chonks placed` + (art.unique ? `, ${fmt(art.unique)} different` : "") + "\n\n");
      add('<span class="p">$ </span><span class="cur"></span>');
      skip.hidden = true;
    }
    $("termOpen").addEventListener("click", () => { dlg.showModal(); play(); out.focus(); });
    $("termClose").addEventListener("click", () => dlg.close());
    skip.addEventListener("click", () => { skipping = true; });
    dlg.addEventListener("close", () => { run++; });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }

  // "Try an example" in the hero: run the maker's example and jump to it.
  $("heroTry")?.addEventListener("click", () => {
    $("tryExample")?.click();
    $("studio")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
})();

// "Style options" summary: show the current choices while the section is folded.
(() => {
  const sum = document.getElementById("styleSum");
  if (!sum) return;
  const on = (id) => document.querySelector(`#${id} button.on`)?.textContent.trim();
  function update() {
    const gap = on("gap"), pool = on("pool");
    const parts = [
      document.getElementById("varOut")?.textContent.trim() + " variety",
      gap === "None" ? "no gaps" : gap,
      pool,
    ].filter(Boolean);
    const soft = (p) => p.replace(/^(\w)(\w*)/, (m, a, b) => a.toLowerCase() + b);   // "From a wallet" -> "from a wallet", keeps "Chonks"
    sum.textContent = parts.map((p, i) => i ? soft(p) : p[0].toUpperCase() + p.slice(1)).join(", ");
  }
  ["variety", "gap", "pool"].forEach((id) => {
    const n = document.getElementById(id);
    n?.addEventListener("input", () => setTimeout(update));
    n?.addEventListener("click", () => setTimeout(update));
  });
  update();
  setTimeout(update, 500);   // after saved settings are restored
})();

// Empty wall: the Chonk face. When it scrolls into view its squares flip over
// in a wave and turn into real Chonks of the same colours, then flip back
// after 6 seconds, and again every 30 seconds while it stays on screen.
(() => {
  const face = document.getElementById("emptyFace");
  if (!face) return;
  const cells = [...face.children].filter((b) => !b.classList.contains("o"));
  const COLS = 11, EVERY = 30000, SHOW = 6000;
  const cols = [...face.children].map((b, i) => i % COLS);
  const rowsOf = [...face.children].map((b, i) => Math.floor(i / COLS));
  const order = [...face.children].map((b, i) => (b.classList.contains("o") ? -1 : cols[i] + rowsOf[i]));
  cells.forEach((b, k) => {
    b.style.backgroundPosition = `${(k % COLS) * 10}% ${Math.floor(k / COLS) * (100 / 6)}%`;
  });
  let ready = false;
  const sprite = new Image();
  sprite.onload = () => { ready = true; };
  sprite.src = "img/face-chonks.webp";

  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let showing = false, busy = false;
  function flip(toChonks) {
    busy = true;
    const kids = [...face.children];
    let left = cells.length;
    kids.forEach((b, i) => {
      if (order[i] < 0) return;
      const delay = order[i] * 55;
      if (still) { setTimeout(() => { b.classList.toggle("chonk", toChonks); if (--left === 0) busy = false; }, delay); return; }
      const half = { duration: 160, delay, easing: "ease-in", fill: "forwards" };
      b.animate([{ transform: "perspective(200px) rotateY(0deg)" }, { transform: "perspective(200px) rotateY(90deg)" }], half).onfinish = () => {
        b.classList.toggle("chonk", toChonks);
        b.animate([{ transform: "perspective(200px) rotateY(-90deg)" }, { transform: "perspective(200px) rotateY(0deg)" }],
          { duration: 200, easing: "ease-out", fill: "forwards" }).onfinish = () => { if (--left === 0) busy = false; };
      };
    });
    showing = toChonks;
  }
  // Flip as soon as the face scrolls into view, show the Chonks for 6 seconds,
  // flip back, then again every 30 seconds while it stays on screen.
  let onScreen = false, lastFlip = 0;
  function go() {
    if (!ready || busy || showing || !onScreen || document.hidden || !face.offsetParent) return;
    lastFlip = Date.now();
    flip(true);
    setTimeout(() => { if (showing) flip(false); }, SHOW);
  }
  new IntersectionObserver(([e]) => {
    const was = onScreen;
    onScreen = e.isIntersecting && e.intersectionRatio >= 0.6;
    if (onScreen && !was && Date.now() - lastFlip > SHOW + 4000) go();
  }, { threshold: [0, 0.6] }).observe(face);
  sprite.addEventListener("load", () => { if (onScreen && !lastFlip) go(); });
  setInterval(() => { if (Date.now() - lastFlip >= EVERY - 500) go(); }, 1000);
  // Tap or click the face to flip it straight away.
  face.addEventListener("click", () => {
    if (!ready || busy) return;
    lastFlip = Date.now();
    flip(!showing);
  });
  window.__chonkFaceFlip = flip;   // for testing
})();
