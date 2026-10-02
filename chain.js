/*
 * Reads Chonk artwork straight from the Chonks contract on Base.
 * tokenURI(id) -> data:application/json;base64,{ "image": "data:image/svg+xml;base64,..." }
 * No API keys, no backend: plain JSON-RPC eth_call from the browser.
 */
(function (root) {
  "use strict";

  const CHONKS_CONTRACT = "0x07152bfde079b5319e5308c43fb1dbc9c76cb4f9";
  const DEFAULT_RPC = "https://mainnet.base.org";
  const TOKEN_URI = "0xc87b56dd"; // tokenURI(uint256)

  const imageCache = new Map(); // id -> Promise<HTMLImageElement>

  function hexToBytes(hex) {
    if (hex.startsWith("0x")) hex = hex.slice(2);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function readUint(bytes, offset) {
    let v = 0;
    for (let i = offset + 24; i < offset + 32; i++) v = v * 256 + bytes[i];
    return v;
  }
  function decodeAbiString(hex) {
    const b = hexToBytes(hex);
    const off = readUint(b, 0);
    const len = readUint(b, off);
    return new TextDecoder().decode(b.subarray(off + 32, off + 32 + len));
  }
  function b64ToText(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function dataUriToText(uri) {
    const comma = uri.indexOf(",");
    const head = uri.slice(0, comma), body = uri.slice(comma + 1);
    return head.includes(";base64") ? b64ToText(body) : decodeURIComponent(body);
  }
  function encodeCall(id) {
    return TOKEN_URI + BigInt(id).toString(16).padStart(64, "0");
  }

  /** Batched JSON-RPC eth_call for several token ids. Returns Map id -> metadata JSON. */
  async function fetchTokenURIs(ids, rpc) {
    const body = ids.map((id, i) => ({
      jsonrpc: "2.0", id: i, method: "eth_call",
      params: [{ to: CHONKS_CONTRACT, data: encodeCall(id) }, "latest"],
    }));
    const res = await fetch(rpc || DEFAULT_RPC, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    let replies = await res.json();
    if (!Array.isArray(replies)) replies = [replies];
    const out = new Map();
    for (const r of replies) {
      if (!r || r.error || !r.result || r.result === "0x") continue;
      const uri = decodeAbiString(r.result);
      const json = uri.trim().startsWith("{") ? uri : dataUriToText(uri);
      out.set(ids[r.id], JSON.parse(json));
    }
    return out;
  }

  function imageFromMetadata(meta) {
    return new Promise((resolve, reject) => {
      let src = meta.image || meta.image_data;
      if (!src) return reject(new Error("no image in metadata"));
      if (src.trim().startsWith("<svg")) {
        src = URL.createObjectURL(new Blob([src], { type: "image/svg+xml" }));
      }
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image failed to decode"));
      img.src = src;
    });
  }

  /** Single Chonk, cached. */
  function getChonkImage(id, rpc) {
    if (!imageCache.has(id)) {
      const p = fetchTokenURIs([id], rpc).then((m) => {
        if (!m.has(id)) throw new Error(`Chonk #${id} not returned by RPC`);
        return imageFromMetadata(m.get(id));
      });
      p.catch(() => imageCache.delete(id));
      imageCache.set(id, p);
    }
    return imageCache.get(id);
  }

  async function getChonkMeta(id, rpc) {
    const m = await fetchTokenURIs([id], rpc);
    if (!m.has(id)) throw new Error(`Chonk #${id} not returned by RPC`);
    return m.get(id);
  }

  /**
   * Fetch many Chonks with batching + limited concurrency.
   * Returns Map id -> HTMLImageElement (failures are simply missing).
   */
  async function getManyChonkImages(ids, { rpc, batch = 8, parallel = 4, onProgress } = {}) {
    const result = new Map();
    const todo = [];
    for (const id of ids) {
      if (imageCache.has(id)) {
        try { result.set(id, await imageCache.get(id)); } catch (_) { /* refetch below */ todo.push(id); }
      } else todo.push(id);
    }
    let done = ids.length - todo.length;
    const chunks = [];
    for (let i = 0; i < todo.length; i += batch) chunks.push(todo.slice(i, i + batch));

    async function runChunk(chunk, attempt = 0) {
      try {
        const metas = await fetchTokenURIs(chunk, rpc);
        await Promise.all(chunk.map(async (id) => {
          if (!metas.has(id)) return;
          try {
            const img = await imageFromMetadata(metas.get(id));
            imageCache.set(id, Promise.resolve(img));
            result.set(id, img);
          } catch (_) { /* skip */ }
        }));
      } catch (err) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          return runChunk(chunk, attempt + 1);
        }
      }
      done += chunk.length;
      if (onProgress) onProgress(done / ids.length);
    }

    let next = 0;
    await Promise.all(Array.from({ length: parallel }, async () => {
      while (next < chunks.length) await runChunk(chunks[next++]);
    }));
    return result;
  }

  root.ChonkChain = { CHONKS_CONTRACT, DEFAULT_RPC, getChonkImage, getChonkMeta, getManyChonkImages, decodeAbiString };
})(window);
