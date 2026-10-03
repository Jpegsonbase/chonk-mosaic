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
  const WALLET_OF_OWNER = "0x438b6300"; // walletOfOwner(address) -> uint256[]

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

  /** All Chonk IDs held by a wallet (0x… address). */
  async function getWalletChonks(address, rpc) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("That doesn't look like a wallet address (0x followed by 40 characters).");
    const res = await fetch(rpc || DEFAULT_RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: CHONKS_CONTRACT, data: WALLET_OF_OWNER + address.slice(2).toLowerCase().padStart(64, "0") }, "latest"] }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const reply = await res.json();
    if (reply.error) throw new Error(reply.error.message || "RPC error");
    const b = hexToBytes(reply.result || "0x");
    if (b.length < 64) return [];
    const off = readUint(b, 0), len = readUint(b, off);
    const ids = [];
    for (let i = 0; i < len; i++) ids.push(readUint(b, off + 32 + i * 32));
    return ids;
  }

  // ---- ENS (.eth) and Basenames (.base.eth)
  // viem is loaded only when someone types a name, so normal visits stay light.
  const VIEM = "https://esm.sh/viem@2.57.2";
  const MAINNET_RPCS = ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://cloudflare-eth.com"];
  const BASENAME_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD"; // Basenames L2 resolver on Base
  let viemLoad = null;
  const loadViem = () => (viemLoad ||= Promise.all([import(VIEM), import(`${VIEM}/chains`), import(`${VIEM}/ens`)])
    .catch((e) => { viemLoad = null; throw e; }));

  /** Turn "name.eth" / "name.base.eth" into a 0x address, or null if it isn't set. */
  async function resolveName(name, baseRpc) {
    let viem, chains, ens;
    try { [viem, chains, ens] = await loadViem(); }
    catch (_) { throw new Error("Couldn't load the name lookup. Check your connection, or paste the 0x address instead."); }
    let norm;
    try { norm = ens.normalize(name.trim()); }
    catch (_) { throw new Error(`"${name}" isn't a valid name.`); }

    // 1. ENS on Ethereum (also covers names that point elsewhere via offchain resolvers).
    try {
      const l1 = viem.createPublicClient({ chain: chains.mainnet, transport: viem.fallback(MAINNET_RPCS.map((u) => viem.http(u))) });
      const addr = await l1.getEnsAddress({ name: norm });
      if (addr) return addr;
    } catch (_) { /* try Base below */ }

    // 2. Basenames, read directly on Base.
    if (norm.endsWith(".base.eth")) {
      try {
        const l2 = viem.createPublicClient({ chain: chains.base, transport: viem.http(baseRpc || DEFAULT_RPC) });
        const addr = await l2.readContract({
          address: BASENAME_RESOLVER,
          abi: [{ name: "addr", type: "function", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "address" }] }],
          functionName: "addr",
          args: [ens.namehash(norm)],
        });
        if (addr && !/^0x0{40}$/i.test(addr)) return addr;
      } catch (_) { /* fall through */ }
    }
    return null;
  }

  /** How many Chonks exist, read from the contract (totalSupply). */
  async function getTotalSupply(rpc) {
    const res = await fetch(rpc || DEFAULT_RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CHONKS_CONTRACT, data: "0x18160ddd" }, "latest"] }),
    });
    const reply = await res.json();
    if (!reply.result || reply.result === "0x") throw new Error("no totalSupply");
    return readUint(hexToBytes(reply.result), 0);
  }

  root.ChonkChain = { CHONKS_CONTRACT, DEFAULT_RPC, getChonkImage, getChonkMeta, getManyChonkImages, getWalletChonks, resolveName, getTotalSupply, decodeAbiString };
})(window);
