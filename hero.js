// Homepage hero: a framed "Chonk made of Chonks" with a Look closer window.
// Move the mouse over the picture (or tap it, or use the arrow keys) and the
// window shows that spot up close, so you can see the individual Chonks.
// A seasonal script can swap the artwork by setting window.CHONKIT_HERO_ART first.
(() => {
  const ART = window.CHONKIT_HERO_ART || [
    { src: "img/hero/chonk-15064.webp", big: "img/hero/chonk-15064-big.webp", w: 1024, h: 1024,
      title: "Chonk #15064", line: "4,096 Chonks, 274 different", focus: [0.4, 0.43] },
    { src: "img/hero/chonk-75190.webp", big: "img/hero/chonk-75190-big.webp", w: 1024, h: 1024,
      title: "Chonk #75190", line: "4,096 Chonks, 1,084 different", focus: [0.42, 0.43] },
    { src: "img/hero/chonk-1.webp", big: "img/hero/chonk-1-big.webp", w: 1024, h: 1024,
      title: "Chonk #1", line: "4,096 Chonks, 341 different", focus: [0.42, 0.46] },
  ];
  const ZOOM = 4;   // how much closer the window looks than the picture

  const $ = (id) => document.getElementById(id);
  const canvas = $("heroCanvas"), pic = $("heroPic"), lens = $("heroLens"), view = $("heroZoom");
  if (!canvas || !pic || !view) return;

  const art = ART[Math.floor(Math.random() * ART.length)];
  pic.width = art.w; pic.height = art.h;
  pic.alt = art.alt || `${art.title}, rebuilt from Chonks`;
  pic.src = art.src;
  canvas.style.aspectRatio = `${art.w} / ${art.h}`;
  $("heroTitle").textContent = art.title;
  $("heroLine").textContent = art.line;
  const hint = $("heroHint");
  if (hint) hint.textContent = matchMedia("(hover: hover)").matches
    ? "Move over the picture to look closer" : "Tap the picture to look closer";

  view.style.backgroundImage = `url("${art.src}")`;
  let bigLoaded = false;
  function loadBig() {
    if (bigLoaded || !art.big) return;
    bigLoaded = true;
    const im = new Image();
    im.onload = () => { view.style.backgroundImage = `url("${art.big}"), url("${art.src}")`; };
    im.src = art.big;
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
  addEventListener("load", () => setTimeout(loadBig, 1500), { once: true });

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
    const gap = on("gap"), src = on("source");
    const parts = [
      document.getElementById("varOut")?.textContent.trim() + " variety",
      gap === "None" ? "no gaps" : gap,
      src === "Fast" ? "saved art" : src,
    ].filter(Boolean);
    sum.textContent = parts.map((p, i) => i ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1)).join(", ");
  }
  ["variety", "gap", "source"].forEach((id) => {
    const n = document.getElementById(id);
    n?.addEventListener("input", () => setTimeout(update));
    n?.addEventListener("click", () => setTimeout(update));
  });
  update();
  setTimeout(update, 500);   // after saved settings are restored
})();
