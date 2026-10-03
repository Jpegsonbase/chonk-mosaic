/* Runs the matcher off the main thread so the page stays responsive. */
importScripts("mosaic-core.js?v=33");

let dataset = null;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      dataset = MosaicCore.decodeFeatures(msg.buffer, msg.meta);
      self.postMessage({ type: "loaded", count: dataset.n });
    } else if (msg.type === "build") {
      const t0 = performance.now();
      const result = MosaicCore.buildMosaic(
        dataset, msg.rgba, msg.cols, msg.rows, msg.D, msg.settings,
        (p) => self.postMessage({ type: "progress", value: p }),
        msg.allowed || null
      );
      self.postMessage({ type: "done", result, ms: performance.now() - t0 }, [result.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message || err) });
  }
};
