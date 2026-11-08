// DexScreener client for GYRE. Public API, no key. Every number on the site comes from here or from the chain.
// Cache per URL (60 s, matches their cache-control), in-flight dedupe, and a small pair universe per chain that is
// refreshed in 30-address batches so the discover feeds and the signal engine see fresh 5-minute windows.
const BASE = "https://api.dexscreener.com";
export const CHAINS = { solana: { id: "solana", name: "Solana", native: "SOL", explorerTx: "https://solscan.io/tx/", explorerAddr: "https://solscan.io/account/", explorerToken: "https://solscan.io/token/" },
  robinhood: { id: "robinhood", name: "Robinhood Chain", native: "ETH", explorerTx: "https://robinhoodchain.blockscout.com/tx/", explorerAddr: "https://robinhoodchain.blockscout.com/address/", explorerToken: "https://robinhoodchain.blockscout.com/token/" } };
const UA = { "user-agent": "GYRE/1.0 (+https://gyre.trade)", accept: "application/json" };
const cache = new Map(), inflight = new Map();
let calls = 0, errors = 0;
export async function get(path, ttl = 60_000) {
  const url = BASE + path, hit = cache.get(url); if (hit && Date.now() - hit.at < ttl) return hit.v;
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => { calls++; const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12_000) }); if (!r.ok) { errors++; throw Object.assign(new Error(`DexScreener ${r.status}`), { code: r.status === 429 ? 429 : 502 }); } const v = await r.json(); cache.set(url, { at: Date.now(), v }); if (cache.size > 2000) cache.delete(cache.keys().next().value); return v; })().finally(() => inflight.delete(url));
  inflight.set(url, p); return p;
}
export const norm = (p) => p && ({ chain: p.chainId, pair: p.pairAddress, dex: p.dexId, labels: p.labels || [], url: p.url, base: { address: p.baseToken?.address, name: p.baseToken?.name, symbol: p.baseToken?.symbol }, quote: { address: p.quoteToken?.address, symbol: p.quoteToken?.symbol },
  priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null, priceNative: p.priceNative != null ? Number(p.priceNative) : null, change: { m5: p.priceChange?.m5 ?? null, h1: p.priceChange?.h1 ?? null, h6: p.priceChange?.h6 ?? null, h24: p.priceChange?.h24 ?? null },
  txns: { m5: p.txns?.m5 || { buys: 0, sells: 0 }, h1: p.txns?.h1 || { buys: 0, sells: 0 }, h6: p.txns?.h6 || { buys: 0, sells: 0 }, h24: p.txns?.h24 || { buys: 0, sells: 0 } }, vol: { m5: p.volume?.m5 ?? 0, h1: p.volume?.h1 ?? 0, h6: p.volume?.h6 ?? 0, h24: p.volume?.h24 ?? 0 },
  liq: p.liquidity?.usd ?? null, fdv: p.fdv ?? null, mcap: p.marketCap ?? null, createdAt: p.pairCreatedAt || null, image: p.info?.imageUrl || null, header: p.info?.header || null, websites: (p.info?.websites || []).map((w) => w.url).slice(0, 3), socials: (p.info?.socials || []).map((s) => ({ type: s.type, url: s.url })).slice(0, 4), boosts: p.boosts?.active || 0 });
export const key = (p) => `${p.chain}:${p.pair}`;
export const supported = (c) => !!CHAINS[c];

export async function search(q) { const j = await get(`/latest/dex/search?q=${encodeURIComponent(q)}`); return (j.pairs || []).map(norm).filter((p) => supported(p.chain)); }
export async function pairs(chain, addrs) { const out = []; for (let i = 0; i < addrs.length; i += 30) { const j = await get(`/latest/dex/pairs/${chain}/${addrs.slice(i, i + 30).join(",")}`, 25_000); for (const p of j.pairs || []) out.push(norm(p)); } return out; }
export async function pair(chain, addr) { const r = await pairs(chain, [addr]); return r[0] || null; }
export async function tokenPairs(chain, token) { try { const j = await get(`/token-pairs/v1/${chain}/${token}`); if (Array.isArray(j) && j.length) return j.map(norm); } catch {} return (await search(token)).filter((p) => p.chain === chain && (p.base.address?.toLowerCase() === token.toLowerCase())); }
export async function profiles() { try { return (await get(`/token-profiles/latest/v1`, 90_000)).filter((t) => supported(t.chainId)); } catch { return []; } }
export async function boosts() { try { const [a, b] = await Promise.all([get(`/token-boosts/latest/v1`, 90_000), get(`/token-boosts/top/v1`, 90_000)]); return [...a, ...b].filter((t) => supported(t.chainId)); } catch { return []; } }
export const stats = () => ({ calls, errors, cached: cache.size });

// ---------- the universe: pairs we keep fresh per chain ----------
export function createUniverse({ seeds }) {
  const U = { solana: new Map(), robinhood: new Map() }; // key → { p, seen, src:Set }
  let lastSweep = 0, sweeping = false, listeners = new Set();
  const add = (p, src) => { if (!p?.pair || !supported(p.chain)) return; const m = U[p.chain]; const e = m.get(p.pair); if (e) { e.p = p; e.seen = Date.now(); if (src) e.src.add(src); } else m.set(p.pair, { p, seen: Date.now(), first: Date.now(), src: new Set(src ? [src] : []) }); };
  async function discoverSeeds() {
    const found = [];
    const [prof, bst] = await Promise.all([profiles(), boosts()]);
    const byChain = {}; for (const t of [...prof, ...bst]) (byChain[t.chainId] ||= new Set()).add(t.tokenAddress);
    for (const [chain, toks] of Object.entries(byChain)) { const list = [...toks].slice(0, 40); for (const t of list) { try { for (const p of await tokenPairs(chain, t)) { add(p, "profile"); found.push(p); } } catch {} } }
    for (const q of ["robinhood", "SOL", "pump", "USDC", "WETH"]) { try { for (const p of await search(q)) { add(p, "search"); found.push(p); } } catch {} }
    if (seeds) { try { for (const p of await seeds()) { add(p, "chain"); found.push(p); } } catch {} }
    return found.length;
  }
  async function sweep() {
    if (sweeping) return; sweeping = true;
    try {
      if (Date.now() - lastSweep > 10 * 60_000) { await discoverSeeds(); lastSweep = Date.now(); }
      for (const chain of Object.keys(U)) {
        const m = U[chain]; for (const [k, e] of m) if (Date.now() - e.seen > 6 * 3600_000 && (e.p.liq || 0) < 1000) m.delete(k);
        const addrs = [...m.values()].sort((a, b) => (b.p.vol.h1 || 0) - (a.p.vol.h1 || 0)).slice(0, 240).map((e) => e.p.pair);
        const prev = new Map(addrs.map((a) => [a, m.get(a)?.p]));
        const fresh = await pairs(chain, addrs).catch(() => []);
        for (const p of fresh) { add(p); for (const fn of listeners) { try { fn(prev.get(p.pair) || null, p); } catch {} } }
      }
    } finally { sweeping = false; }
  }
  return {
    add, sweep, list: (chain) => [...(U[chain] || new Map()).values()].map((e) => e.p), get: (chain, addr) => U[chain]?.get(addr)?.p || null, size: () => Object.fromEntries(Object.entries(U).map(([c, m]) => [c, m.size])),
    onUpdate: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    start(ms = 30_000) { sweep().catch(() => {}); setInterval(() => sweep().catch((e) => console.error("sweep:", e.message)), ms).unref(); },
  };
}

// ---------- discover feeds ----------
const age = (p) => (p.createdAt ? (Date.now() - p.createdAt) / 60_000 : null); // minutes
export function feeds(list, { tab = "trending", minLiq = 0, q = "" } = {}) {
  let L = list.filter((p) => (p.liq || 0) >= minLiq);
  if (q) { const s = q.toLowerCase(); L = L.filter((p) => p.base.symbol?.toLowerCase().includes(s) || p.base.name?.toLowerCase().includes(s) || p.base.address?.toLowerCase() === s || p.pair.toLowerCase() === s); }
  const score = (p) => { const l = Math.max(p.liq || 0, 1); const flow = (p.vol.m5 || 0) * 12 + (p.vol.h1 || 0); const tx = (p.txns.m5.buys + p.txns.m5.sells) * 6 + (p.txns.h1.buys + p.txns.h1.sells); return Math.log1p(flow) * 2 + Math.log1p(tx) + Math.min(3, flow / l) + (p.boosts ? 0.5 : 0); };
  if (tab === "new") L = L.filter((p) => age(p) != null && age(p) < 24 * 60).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  else if (tab === "gainers") L = L.filter((p) => (p.vol.h1 || 0) > 500).sort((a, b) => (b.change.h1 || -1e9) - (a.change.h1 || -1e9));
  else if (tab === "volume") L = L.sort((a, b) => (b.vol.h24 || 0) - (a.vol.h24 || 0));
  else if (tab === "curve") L = L.filter((p) => p.dex === "pumpfun" || p.dex === "pumpswap" || p.labels.includes("curve") || p.dex === "pons").sort((a, b) => (b.vol.h1 || 0) - (a.vol.h1 || 0));
  else L = L.sort((a, b) => score(b) - score(a));
  // one row per token: keep the deepest pool of each base token, in the tab's order
  const seen = new Map(); const out = []; for (const p of L) { const k = `${p.chain}:${(p.base.address || p.pair).toLowerCase()}`; const i = seen.get(k); if (i == null) { seen.set(k, out.length); out.push(p); } else if ((p.liq || 0) > (out[i].liq || 0)) out[i] = { ...p, pools: (out[i].pools || 1) + 1 }; else out[i].pools = (out[i].pools || 1) + 1; }
  return out;
}
export const pressure = (p, w = "m5") => { const b = p.txns[w].buys, s = p.txns[w].sells; return b + s ? b / (b + s) : null; };
