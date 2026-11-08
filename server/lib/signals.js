// The signal engine. Every 30 s the universe is re-read; the diff between two reads becomes alerts that say exactly
// what moved and by how much. On Robinhood Chain the Pons curve events give exact per-wallet buys and sells, so
// whale alerts there name the wallet and the hash. Alerts are kept in a ring buffer and pushed over SSE.
import * as RH from "./rh.js";
import { tokenPairs as dexTokenPairs } from "./dex.js";
import { ethers } from "ethers";
export function createSignals({ universe, record }) {
  const ring = []; const subs = new Set(); let rhBlock = 0; const seenPairs = new Set(); const last = new Map();
  const cool = (p, kind, ms = 180_000) => { const k = `${p.chain}:${p.pair}:${kind}`; const t = last.get(k) || 0; if (Date.now() - t < ms) return false; last.set(k, Date.now()); return true; };
  const push = (a) => { a.id = `${a.at}-${Math.random().toString(36).slice(2, 7)}`; ring.push(a); if (ring.length > 400) ring.shift(); for (const s of subs) { try { s(a); } catch {} } record?.signal?.(a); };
  const money = (v) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`);
  const base = (p) => ({ at: Date.now(), chain: p.chain, pair: p.pair, symbol: p.base.symbol, name: p.base.name, priceUsd: p.priceUsd, liq: p.liq, image: p.image });
  function diff(prev, p) {
    if (!prev) { if (!seenPairs.has(p.pair) && p.createdAt && Date.now() - p.createdAt < 30 * 60_000) push({ ...base(p), kind: "new_pair", severity: "info", title: "New pair", detail: `${p.base.symbol}/${p.quote.symbol} on ${p.dex}, ${p.liq ? money(p.liq) + " liquidity" : "liquidity unknown"}, ${Math.round((Date.now() - p.createdAt) / 60_000)} min old.` }); seenPairs.add(p.pair); return; }
    seenPairs.add(p.pair);
    const db = Math.max(0, p.txns.h1.buys - prev.txns.h1.buys), ds = Math.max(0, p.txns.h1.sells - prev.txns.h1.sells), liq = p.liq || 0;
    const flow = Math.max(0, (p.vol.h1 || 0) - (prev.vol.h1 || 0)); // volume added since the last read (h1 window moves slower, fewer false drops)
    if (liq > 2000 && flow >= Math.max(1500, liq * 0.04) && db >= 3 && db > ds * 2 && cool(p, "buy_surge")) push({ ...base(p), kind: "buy_surge", severity: flow >= liq * 0.12 ? "high" : "mid", title: "Buy surge", detail: `${money(flow)} traded in the last 30 s, ${db} buys vs ${ds} sells. That is ${((flow / liq) * 100).toFixed(1)}% of the pool.` });
    else if (liq > 2000 && flow >= Math.max(1500, liq * 0.04) && ds >= 3 && ds > db * 2 && cool(p, "sell_surge")) push({ ...base(p), kind: "sell_surge", severity: flow >= liq * 0.12 ? "high" : "mid", title: "Sell surge", detail: `${money(flow)} traded in the last 30 s, ${ds} sells vs ${db} buys. ${((flow / liq) * 100).toFixed(1)}% of the pool.` });
    if (prev.liq && liq && liq < prev.liq * 0.8 && prev.liq > 5000 && cool(p, "liq_drop")) push({ ...base(p), kind: "liq_drop", severity: liq < prev.liq * 0.5 ? "high" : "mid", title: "Liquidity dropped", detail: `${money(prev.liq)} → ${money(liq)} (${(((liq - prev.liq) / prev.liq) * 100).toFixed(0)}%) within 30 s.` });
    if (prev.liq && liq && liq > prev.liq * 1.5 && liq > 5000 && cool(p, "liq_add")) push({ ...base(p), kind: "liq_add", severity: "info", title: "Liquidity added", detail: `${money(prev.liq)} → ${money(liq)}.` });
    if (prev.priceUsd && p.priceUsd && liq > 2000) { const ch = ((p.priceUsd - prev.priceUsd) / prev.priceUsd) * 100; if (Math.abs(ch) >= 12 && cool(p, ch > 0 ? "pump" : "dump")) push({ ...base(p), kind: ch > 0 ? "pump" : "dump", severity: Math.abs(ch) >= 30 ? "high" : "mid", title: ch > 0 ? `+${ch.toFixed(0)}% in 30 s` : `${ch.toFixed(0)}% in 30 s`, detail: `${p.priceUsd < 0.01 ? p.priceUsd.toPrecision(3) : p.priceUsd.toFixed(4)} USD now, ${(p.txns.m5.buys + p.txns.m5.sells)} trades in the 5-minute window.` }); }
    if ((p.boosts || 0) > (prev.boosts || 0)) push({ ...base(p), kind: "boost", severity: "info", title: "Boosted on DexScreener", detail: `${p.boosts} active boosts. Paid attention, not organic flow.` });
  }
  universe.onUpdate(diff);
  const curves = new Map(); // curve → [{at, buy, eth, wallet, tx}]
  const curveToken = new Map(); let launchesAt = 0; // curve → { token, deployer }
  async function refreshLaunches() { if (Date.now() - launchesAt < 5 * 60_000) return; launchesAt = Date.now(); try { for (const l of await RH.recentLaunches(120_000)) curveToken.set(l.curve.toLowerCase(), { token: l.token, deployer: l.deployer }); } catch {} }
  async function pairForCurve(curve) { const k = curve.toLowerCase(); let p = universe.list("robinhood").find((x) => x.curve?.toLowerCase() === k || x.pair?.toLowerCase() === k); if (p) return p; const rec = curveToken.get(k); if (!rec) return null; try { const ps = await dexTokenPairs(rec.token); if (ps.length) { for (const x of ps) universe.add(x, "curve"); return ps[0]; } p = await RH.curvePair(rec.token, curveStats(curve)); if (p) universe.add(p, "curve"); return p; } catch { return null; } }
  const curveStats = (curve) => { const L = (curves.get(curve.toLowerCase()) || []).filter((e) => Date.now() - e.at < 3600_000); const w = (ms) => L.filter((e) => Date.now() - e.at < ms); const sum = (A) => A.reduce((a, e) => a + e.eth, 0); return { m5: { buys: w(300_000).filter((e) => e.buy).length, sells: w(300_000).filter((e) => !e.buy).length, eth: sum(w(300_000)) }, h1: { buys: L.filter((e) => e.buy).length, sells: L.filter((e) => !e.buy).length, eth: sum(L) } }; };
  // Robinhood: exact curve events (whale buys/sells on Pons) and fresh launches
  async function rhTick() {
    try {
      const { head, events } = await RH.curveBuysSince(rhBlock || 0); if (!rhBlock) { rhBlock = head; return; } rhBlock = head;
      await refreshLaunches(); const usd = await RH.ethUsd().catch(() => null);
      for (const e of events) { const k = e.curve.toLowerCase(); const L = curves.get(k) || []; L.push({ at: Date.now(), buy: e.buy, eth: Number(e.eth), wallet: e.wallet, tx: e.tx }); curves.set(k, L.filter((x) => Date.now() - x.at < 3600_000)); }
      for (const e of events) { const eth = Number(e.eth); if (eth < 0.03) continue; const p = await pairForCurve(e.curve); push({ at: Date.now(), chain: "robinhood", pair: p?.pair || curveToken.get(e.curve.toLowerCase())?.token?.toLowerCase() || null, curve: e.curve, symbol: p?.base.symbol || "curve token", name: p?.base.name || null, priceUsd: p?.priceUsd || null, liq: p?.liq || null, image: p?.image || null, kind: e.buy ? "whale_buy" : "whale_sell", severity: eth >= 0.3 ? "high" : "mid", title: e.buy ? "Whale buy on the curve" : "Whale sell on the curve", detail: `${eth.toFixed(3)} ETH${usd ? ` (~$${Math.round(eth * usd)})` : ""} by ${ethers.getAddress(e.wallet).slice(0, 6)}…${e.wallet.slice(-4)}, ${Number(e.tokens).toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens.`, wallet: e.wallet, tx: e.tx }); }
    } catch (e) { /* RPC hiccup: next tick */ }
  }
  return {
    recent: ({ chain, kinds, limit = 60 } = {}) => ring.filter((a) => (!chain || a.chain === chain) && (!kinds || kinds.includes(a.kind))).slice(-limit).reverse(),
    forPair: (chain, pair, limit = 30) => ring.filter((a) => a.chain === chain && (a.pair === pair || a.curve?.toLowerCase() === pair?.toLowerCase())).slice(-limit).reverse(),
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    curveStats,
    stats: () => { const h = Date.now() - 3600_000; const last = ring.filter((a) => a.at > h); return { lastHour: last.length, byKind: last.reduce((m, a) => ((m[a.kind] = (m[a.kind] || 0) + 1), m), {}), total: ring.length }; },
    start() { rhTick(); setInterval(rhTick, 30_000).unref(); },
  };
}
