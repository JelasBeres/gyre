// Robinhood Chain reads for GYRE: token facts, owner/proxy checks, Pons launch record, holder distribution from
// Transfer logs, and the deployer's launch history. Everything through the public RPC (pons.js gate + retry).
import { ethers } from "ethers";
import * as P from "./pons.js";
const ERC20 = ["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function owner() view returns (address)", "function balanceOf(address) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"];
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const err = (code, message) => Object.assign(new Error(message), { code });
export const isAddr = P.isAddr;
export const explorer = { tx: (h) => `${P.EXPLORER}/tx/${h}`, addr: (a) => `${P.EXPLORER}/address/${a}`, token: (a) => `${P.EXPLORER}/token/${a}` };

export async function tokenFacts(token) {
  const c = new ethers.Contract(token, ERC20, P.provider);
  const code = await P.withRetry(() => P.provider.getCode(token)); if (code === "0x") throw err(404, "No contract at that address on Robinhood Chain.");
  const [name, symbol, decimals, supply] = await Promise.all([P.withRetry(() => c.name()).catch(() => "?"), P.withRetry(() => c.symbol()).catch(() => "?"), P.withRetry(() => c.decimals()).catch(() => 18), P.withRetry(() => c.totalSupply()).catch(() => 0n)]);
  const owner = await P.withRetry(() => c.owner()).catch(() => null);
  const [impl, admin, beacon] = await Promise.all([IMPL_SLOT, ADMIN_SLOT, BEACON_SLOT].map((s) => P.withRetry(() => P.provider.getStorage(token, s)).catch(() => ethers.ZeroHash)));
  const nz = (h) => h && h !== ethers.ZeroHash ? ethers.getAddress("0x" + h.slice(-40)) : null;
  return { token, name, symbol, decimals: Number(decimals), supply: ethers.formatUnits(supply, Number(decimals)), codeBytes: (code.length - 2) / 2, owner: owner && owner !== ethers.ZeroAddress ? owner : null, renounced: !!owner && owner === ethers.ZeroAddress, proxy: !!(nz(impl) || nz(beacon)), implementation: nz(impl), proxyAdmin: nz(admin) };
}
export async function ponsRecord(token) {
  const rec = await P.withRetry(() => P.launched(token)).catch(() => null); if (!rec) return null;
  const c = P.curveAt(rec.curve);
  const [graduated, reserves, feeBps, taxBps] = await Promise.all([P.withRetry(() => c.graduated()).catch(() => null), P.withRetry(() => c.getReserves()).catch(() => null), P.withRetry(() => c.feeBps()).catch(() => null), P.withRetry(() => c.creatorTaxBps()).catch(() => null)]);
  const meta = await P.withRetry(() => P.tokenMeta(token)).catch(() => null);
  return { curve: rec.curve, deployer: rec.deployer, feeRecipient: rec.feeRecipient, pairEth: BigInt(rec.pairToken) === 0n, graduated, quoteReserveEth: reserves ? ethers.formatEther(reserves[0]) : null, tokenReserve: reserves ? ethers.formatUnits(reserves[1], 18) : null, feeBps: feeBps != null ? Number(feeBps) : null, creatorTaxBps: taxBps != null ? Number(taxBps) : null, socials: meta?.socials || null, description: meta?.description || "", logo: meta?.logo || "" };
}
// Holder distribution from Transfer logs (bounded scan; Pons tokens are young). Excludes curve/pool/dead/system.
export async function holders(token, decimals, supply, { fromBlock } = {}) {
  const head = await P.withRetry(() => P.provider.getBlockNumber()); const start = fromBlock || Math.max(0, head - 400_000);
  const iface = new ethers.Interface(ERC20); const topic = iface.getEvent("Transfer").topicHash; const bal = new Map(); let scanned = 0, truncated = false;
  for (let to = head; to > start && scanned < 12; to -= 40_000, scanned++) {
    const logs = await P.withRetry(() => P.provider.getLogs({ address: token, topics: [topic], fromBlock: Math.max(start, to - 39_999), toBlock: to })).catch(() => { truncated = true; return []; });
    for (const l of logs) { const ev = iface.parseLog(l); const f = ev.args.from.toLowerCase(), t = ev.args.to.toLowerCase(), v = ev.args.value; bal.set(t, (bal.get(t) || 0n) + v); bal.set(f, (bal.get(f) || 0n) - v); }
  }
  const S = Number(ethers.formatUnits(supply, decimals)) || 1;
  const rows = [...bal.entries()].filter(([a, v]) => v > 0n && a !== ethers.ZeroAddress.toLowerCase()).map(([a, v]) => ({ owner: a, amount: Number(ethers.formatUnits(v, decimals)) })).sort((a, b) => b.amount - a.amount).slice(0, 25);
  const label = (a, ctx) => a === ctx.curve ? "Pons curve" : a === P.ADDR.dead.toLowerCase() ? "dead (burned)" : P.SYSTEM.has(a) ? "Pons system" : ctx.pool && a === ctx.pool ? "DEX pool" : a === ctx.deployer ? "deployer" : "wallet";
  return (ctx = {}) => { const out = rows.map((r) => { const l = label(r.owner, ctx); return { ...r, pct: +((r.amount / S) * 100).toFixed(2), label: l, pool: l !== "wallet" && l !== "deployer" }; }); const w = out.filter((r) => !r.pool); return { rows: out, top10WalletsPct: +w.slice(0, 10).reduce((a, r) => a + r.pct, 0).toFixed(2), largestWalletPct: +(w[0]?.pct || 0).toFixed(2), poolPct: +out.filter((r) => r.pool).reduce((a, r) => a + r.pct, 0).toFixed(2), deployerPct: +(out.find((r) => r.label === "deployer")?.pct || 0).toFixed(2), partial: truncated || scanned >= 12 }; };
}
// Deployer history: every Pons launch by this wallet (indexed topic), plus its balance and tx count.
export async function deployerHistory(deployer) {
  const head = await P.withRetry(() => P.provider.getBlockNumber());
  const topic = P.TOPIC.launched; const padded = ethers.zeroPadValue(deployer, 32); const launches = [];
  for (let to = head, i = 0; i < 8 && to > P.FIRST_BLOCK; i++, to -= 2_000_000) {
    const logs = await P.withRetry(() => P.provider.getLogs({ address: P.ADDR.factory, topics: [topic, null, null, padded], fromBlock: Math.max(P.FIRST_BLOCK, to - 1_999_999), toBlock: to })).catch(() => []);
    for (const l of logs) { const ev = P.factoryI.parseLog(l); launches.push({ token: ev.args.token, curve: ev.args.curve, block: l.blockNumber }); }
  }
  let graduated = 0; for (const x of launches.slice(0, 10)) { try { if (await P.withRetry(() => P.curveAt(x.curve).graduated())) graduated++; } catch {} }
  const [bal, nonce] = await Promise.all([P.withRetry(() => P.provider.getBalance(deployer)).catch(() => 0n), P.withRetry(() => P.provider.getTransactionCount(deployer)).catch(() => null)]);
  return { launches: launches.length, graduatedOfChecked: graduated, checked: Math.min(10, launches.length), recent: launches.slice(0, 5), ethBalance: ethers.formatEther(bal), txCount: nonce };
}
export async function recentLaunches(blocks = 60_000) {
  const head = await P.withRetry(() => P.provider.getBlockNumber());
  const logs = await P.withRetry(() => P.provider.getLogs({ address: P.ADDR.factory, topics: [P.TOPIC.launched], fromBlock: head - blocks, toBlock: head })).catch(() => []);
  return logs.map((l) => { const ev = P.factoryI.parseLog(l); return { token: ev.args.token, curve: ev.args.curve, deployer: ev.args.deployer, block: l.blockNumber, tx: l.transactionHash }; }).reverse();
}
export async function curveBuysSince(fromBlock) {
  const head = await P.withRetry(() => P.provider.getBlockNumber()); if (fromBlock >= head) return { head, events: [] };
  const buyT = P.curveI.getEvent("CurveBuy").topicHash, sellT = P.curveI.getEvent("CurveSell").topicHash;
  const logs = await P.withRetry(() => P.provider.getLogs({ topics: [[buyT, sellT]], fromBlock: Math.max(fromBlock, head - 5000), toBlock: head })).catch(() => []);
  return { head, events: logs.map((l) => { const ev = P.curveI.parseLog(l); const buy = ev.name === "CurveBuy"; return { curve: l.address, buy, wallet: buy ? ev.args.recipient : ev.args.seller, eth: ethers.formatEther(buy ? ev.args.quoteIn : ev.args.quoteOut), tokens: ethers.formatUnits(buy ? ev.args.tokensOut : ev.args.tokensIn, 18), tx: l.transactionHash, block: l.blockNumber }; }) };
}
export const ethUsd = P.ethUsd;

// A pair-shaped view of a token that is still on its Pons curve and not on DexScreener yet. Price and liquidity
// come from the curve reserves; volume and trade counts come from the exact curve events the signal engine saw.
export async function curvePair(token, stats) {
  const rec = await ponsRecord(token); if (!rec || !rec.pairEth) return null;
  const tf = await tokenFacts(token).catch(() => null); const usd = await P.ethUsd().catch(() => null);
  const q = Number(rec.quoteReserveEth || 0), tr = Number(rec.tokenReserve || 0); const priceEth = tr > 0 ? q / tr : null;
  const st = stats || { m5: { buys: 0, sells: 0, eth: 0 }, h1: { buys: 0, sells: 0, eth: 0 } };
  return { chain: "robinhood", pair: token.toLowerCase(), dex: "pons", labels: ["curve", rec.graduated ? "graduated" : "bonding"], url: `https://ponsfamily.com/launchpad/${token}`, base: { address: token, name: tf?.name || rec.description?.slice(0, 32) || "Pons token", symbol: tf?.symbol || "?" }, quote: { address: null, symbol: "ETH" },
    priceUsd: priceEth != null && usd ? priceEth * usd : null, priceNative: priceEth, change: { m5: null, h1: null, h6: null, h24: null }, txns: { m5: { buys: st.m5.buys, sells: st.m5.sells }, h1: { buys: st.h1.buys, sells: st.h1.sells }, h6: { buys: st.h1.buys, sells: st.h1.sells }, h24: { buys: st.h1.buys, sells: st.h1.sells } },
    vol: { m5: usd ? st.m5.eth * usd : 0, h1: usd ? st.h1.eth * usd : 0, h6: usd ? st.h1.eth * usd : 0, h24: usd ? st.h1.eth * usd : 0 }, liq: usd ? q * usd : null, fdv: priceEth != null && usd && tf ? priceEth * usd * Number(tf.supply) : null, mcap: null, createdAt: null, image: rec.logo || null, header: null, websites: rec.socials?.website ? [rec.socials.website] : [], socials: rec.socials ? Object.entries(rec.socials).filter(([k, v]) => v && k !== "website").map(([type, url]) => ({ type, url })) : [], boosts: 0, curve: rec.curve, graduated: rec.graduated, synthetic: true };
}
