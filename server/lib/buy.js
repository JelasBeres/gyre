// Buy $GYRE from the site. Read-only on the server: it reads the Pons curve (reserves, fees, graduation),
// quotes a buy and encodes the calldata; the visitor's own wallet signs and pays. GYRE never holds funds.
import { ethers } from "ethers";
import * as P from "./pons.js";

const err = (code, message) => Object.assign(new Error(message), { code });

export function createBuy({ token }) {
  // Static facts per token (curve, fee, meta) are read once; reserves and graduation refresh every 30 s in the
  // background so /api/token answers from memory. On an RPC hiccup the last good view is served.
  let fixed = { for: "", v: null }, live = { at: 0, for: "", v: null }, warming = null;
  const timed = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("rpc timeout")), ms))]);
  async function fixedOf(t) {
    if (fixed.for === t && fixed.v) return fixed.v;
    const rec = await P.withRetry(() => P.launched(t)); if (!rec) throw err(400, "The configured address is not a Pons token.");
    const c = P.curveAt(rec.curve);
    const [feeBps, taxBps, meta] = await Promise.all([P.withRetry(() => c.feeBps()), P.withRetry(() => c.creatorTaxBps()), P.withRetry(() => P.tokenMeta(t)).catch(() => null)]);
    fixed = { for: t, v: { curve: rec.curve, pairEth: BigInt(rec.pairToken) === 0n, feeBps: Number(feeBps), taxBps: Number(taxBps), name: meta?.name || "GYRE", symbol: meta?.symbol || "GYRE", supply: meta ? ethers.formatUnits(meta.supply, 18) : null } };
    return fixed.v;
  }
  async function refresh(t) {
    const f = await fixedOf(t), c = P.curveAt(f.curve);
    const [res, graduated, usd] = await Promise.all([P.withRetry(() => c.getReserves()), P.withRetry(() => c.graduated()), P.ethUsd().catch(() => null)]);
    const q = res[0], tr = res[1];
    const priceEth = tr > 0n ? Number(ethers.formatEther(q)) / Number(ethers.formatUnits(tr, 18)) : null;
    const v = { token: t, ...f, graduated, quoteReserve: ethers.formatEther(q), tokenReserve: ethers.formatUnits(tr, 18), priceEth, priceUsd: priceEth && usd ? priceEth * usd : null, ethUsd: usd,
      chainId: P.CHAIN_ID, chainHex: "0x" + P.CHAIN_ID.toString(16), rpc: P.RPC, explorer: P.EXPLORER, pons: `https://ponsfamily.com/launchpad/${t}`, at: new Date().toISOString() };
    live = { at: Date.now(), for: t, v }; return v;
  }
  async function view() {
    const t = (token() || "").trim(); if (!t) return { token: null };
    if (live.for === t && live.v && Date.now() - live.at < 30_000) return live.v;
    if (!warming) warming = refresh(t).finally(() => { warming = null; });
    if (live.for === t && live.v) { warming.catch(() => {}); return live.v; } // stale is fine while the refresh runs
    try { return await warming; } catch (e) { if (live.for === t && live.v) return live.v; throw e; }
  }
  setInterval(() => { const t = (token() || "").trim(); if (t) view().catch(() => {}); }, 30_000).unref();
  async function quote({ eth, from }) {
    const v = await view(); if (!v.token) throw err(400, "$GYRE has not launched yet.");
    if (v.graduated) throw err(400, "$GYRE has graduated to the DEX. Buy it there.");
    if (!v.pairEth) throw err(400, "This curve does not trade against ETH.");
    let wei; try { wei = ethers.parseEther(String(eth || "").trim()); } catch { throw err(400, "Enter an amount in ETH."); }
    if (wei <= 0n) throw err(400, "Enter an amount in ETH.");
    const c = P.curveAt(v.curve), to = ethers.isAddress(from) ? ethers.getAddress(from) : null;
    let out, exact = false;
    if (to) { try { out = await timed(P.gate(() => c.buy.staticCall(wei, 0n, to, { value: wei, from: to })), 6000); exact = true; } catch {} }
    if (out === undefined) { const q = ethers.parseEther(v.quoteReserve), tr = ethers.parseUnits(v.tokenReserve, 18); const inAfter = wei - (wei * BigInt(v.feeBps + v.taxBps)) / 10_000n; out = (tr * inAfter) / (q + inAfter); }
    let snipeTaxBps = 0; if (to) { try { snipeTaxBps = Number(await timed(P.gate(() => c.currentSnipeTaxBps(to)), 6000)); } catch {} }
    const min = (out * 97n) / 100n;
    return { to: v.curve, chainId: v.chainId, chainHex: v.chainHex, value: "0x" + wei.toString(16), eth: ethers.formatEther(wei), usd: v.ethUsd ? Number(ethers.formatEther(wei)) * v.ethUsd : null,
      data: to ? P.curveI.encodeFunctionData("buy", [wei, min, to]) : null, recipient: to, tokensOut: ethers.formatUnits(out, 18), minOut: ethers.formatUnits(min, 18), exact, snipeTaxBps, feeBps: v.feeBps, taxBps: v.taxBps, priceUsd: v.priceUsd };
  }
  return { view, quote };
}
