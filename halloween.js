// Halloween extras. Loaded on the mosaic maker, Studio and ASCII pages.
//
// Switches itself off at midnight on 1 November (visitor's own time): the
// Halloween stylesheet is disabled and the pumpkin and bats are skipped, so
// the normal look comes back without anyone editing the site.
// Add ?halloween=on or ?halloween=off to the address to preview either look.
(() => {
  const ENDS = new Date(2026, 10, 1);   // 1 November 2026, 00:00
  let on = new Date() < ENDS;
  try {
    const q = new URLSearchParams(location.search).get("halloween");
    if (q === "on") on = true;
    if (q === "off") on = false;
  } catch (_) {}
  window.CHONKIT_HALLOWEEN = on;
  if (!on) {
    document.querySelectorAll('link[href*="theme-halloween"]').forEach((l) => { l.disabled = true; });
  }
})();

// The framed hero shows the jack-o'-lantern mosaic (read by home.js).
if (window.CHONKIT_HALLOWEEN) window.CHONKIT_HERO_ART = [{
  src: "img/halloween-hero.webp", sm: "img/halloween-hero-800.webp", smW: 800, mid: "img/halloween-hero-mid.webp", big: "img/halloween-hero-big.webp", w: 1280, h: 960,
  title: "Jack-o'-lantern", line: "4,800 Chonks on canvas",
  alt: "A jack-o'-lantern under a crescent moon, rebuilt from Chonks", focus: [0.5, 0.62],
  across: 80, down: 60, file: "pumpkin.png",
}];

// A flock of bats flies across the screen once when the page loads.
// Purely decorative: never blocks clicks, skipped when the visitor prefers reduced motion.
(() => {
  if (!window.CHONKIT_HALLOWEEN) return;
  try {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch (_) {}

  const WING = "M0 0C-1.5-2.6-4.6-4.4-8.6-4.2C-10.4-4.1-11.6-3.3-12-2.2C-10.4-2.6-9.2-1.6-9-0.2C-7.8-1.2-6.2-.9-5.6.6C-4.6-.4-3.2-.1-2.6 1.2C-1.8.6-.8.6 0 1Z";
  const BAT = `<svg viewBox="-12.5 -6 25 11" aria-hidden="true" focusable="false">
    <g class="bat-wing"><path d="${WING}"/></g>
    <g transform="scale(-1,1)"><g class="bat-wing"><path d="${WING}"/></g></g>
    <path d="M-1.3-2.4L-1.1-3.9L-.4-2.8H.4L1.1-3.9L1.3-2.4C1.9-1.4 1.8 1.6 0 3C-1.8 1.6-1.9-1.4-1.3-2.4Z"/>
  </svg>`;

  function fly() {
    if (!document.getElementById("heroCanvas")) return;   // the bats only fly on the mosaic maker
    const W = innerWidth, H = innerHeight;
    const layer = document.createElement("div");
    layer.className = "bat-layer";
    document.body.appendChild(layer);

    const count = W < 600 ? 6 : 9;
    let left = count;
    for (let i = 0; i < count; i++) {
      const bat = document.createElement("div");
      bat.className = "bat";
      bat.innerHTML = BAT;
      const size = (W < 600 ? 26 : 34) + Math.random() * (W < 600 ? 22 : 34);
      bat.style.width = size + "px";
      bat.style.setProperty("--flap", (0.16 + Math.random() * 0.08).toFixed(2) + "s");
      layer.appendChild(bat);

      // Start below the bottom-left area, finish past the top-right, with a lazy wobble.
      const x0 = -size + Math.random() * W * 0.55;
      const y0 = H + size + Math.random() * H * 0.2;
      const x1 = x0 + W * (0.55 + Math.random() * 0.5);
      const y1 = -size * 2 - Math.random() * H * 0.15;
      const steps = 6, frames = [];
      const wob = 20 + Math.random() * 40, phase = Math.random() * Math.PI * 2;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = x0 + (x1 - x0) * t + Math.sin(phase + t * 7) * wob;
        const y = y0 + (y1 - y0) * t + Math.cos(phase + t * 9) * wob * 0.6;
        const tilt = Math.sin(phase + t * 7) * 12;
        frames.push({ transform: `translate(${x}px, ${y}px) rotate(${tilt}deg)`, opacity: t > 0.9 ? 0 : 1 });
      }
      const anim = bat.animate(frames, {
        duration: 2400 + Math.random() * 1400,
        delay: Math.random() * 700,
        easing: "cubic-bezier(.35,.1,.6,.9)",
        fill: "both",
      });
      anim.onfinish = anim.oncancel = () => { bat.remove(); if (--left === 0) layer.remove(); };
    }
  }

  const start = () => setTimeout(fly, 400);
  if (document.readyState !== "loading") start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
