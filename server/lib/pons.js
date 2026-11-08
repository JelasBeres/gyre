// Pons v2 on Robinhood Chain: the one place that knows contract addresses, ABIs and how to read them.
// Everything here is read-only. Transactions (sniper, burn, launchpad) live in their own modules.

import { ethers } from "ethers";

export const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID = 4663;
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const FIRST_BLOCK = 27_027_321; // the first TokenLaunched on Pons v2
export const LOG_WINDOW = 10_000_000; // the RPC caps a filtered log query at 10M blocks
export const ADDR = {
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  launchAndBuy: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
  feeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  buybackVault: "0x42df2a798f82289E177311362e8f5ccC45c1219c",
  launchLocker: "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952",
  dead: "0x000000000000000000000000000000000000dEaD",
};

export const ABI = {
  factory: [
    "function launchToken(tuple(string name, string symbol, string logo, string description, tuple(string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt) params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)",
    "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
    "function launchFee() view returns (uint256)",
    "function maxCreatorTaxBps() view returns (uint16)",
    "function launchConfigCount() view returns (uint256)",
    "function getLaunchConfig(uint256 id) view returns (tuple(uint256 supply, uint256 curveFeeBps, uint256 phantomQuote, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, bool enabled))",
    "function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint256 initialLiquidity, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, bool exists))",
    "function canLaunch(address launcher) view returns (bool)",
    "function launchEnabled() view returns (bool)",
    "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
    "event LaunchSwept(address indexed token, uint256 quoteAmount, uint256 tokenAmount)",
    "event PoolGraduated(address indexed token, bytes32 indexed poolId, uint256 tokenId)",
  ],
  curve: [
    "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
    "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)",
    "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
    "function realQuoteReserve() view returns (uint256)",
    "function graduationThreshold() view returns (uint256)",
    "function graduated() view returns (bool)",
    "function readyToGraduate() view returns (bool)",
    "function feeBps() view returns (uint256)",
    "function creatorTaxBps() view returns (uint256)",
    "function currentSnipeTaxBps(address recipient) view returns (uint256)",
    "function creatorTaxBalance() view returns (uint256)",
    "function sweepFees(uint256 minBuybackTokensOut)",
    "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
    "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
    "event CurveCompleted(uint256 sweptQuote, uint256 sweptTokens)",
  ],
  token: [
    "function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, tuple(string twitter, string telegram, string discord, string website, string farcaster) tokenSocials)",
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ],
  escrow: [
    "function balanceOf(address recipient) view returns (uint256)",
    "function claim()",
    "event Claimed(address indexed recipient, uint256 amount)",
  ],
};

export const NETWORK = ethers.Network.from({ name: "robinhood", chainId: CHAIN_ID });
// The public RPC answers 429 with a Retry-After once a client sends more than a few requests a second.
// One shared cooldown: when any request is told to wait, every request waits.
let cooldownUntil = 0;
export const cooldown = () => Math.max(0, cooldownUntil - Date.now());
const req = new ethers.FetchRequest(RPC);
req.retryFunc = async (request, response, attempt) => {
  if (response.statusCode === 429) { const ra = Number(response.headers["retry-after"] || 10); cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.min(120, Math.max(3, ra)) * 1000); return false; }
  return attempt < 2;
};
export const provider = new ethers.JsonRpcProvider(req, NETWORK, { staticNetwork: NETWORK, batchMaxCount: 40, batchStallTime: 30 });

// keep few requests in flight, and none during a cooldown
let inflight = 0; const waiters = [];
export async function gate(fn) { while (cooldown() > 0) await new Promise((r) => setTimeout(r, Math.min(cooldown(), 2000) + 50)); if (inflight >= 2) await new Promise((r) => waiters.push(r)); inflight++; try { return await fn(); } finally { inflight--; const w = waiters.shift(); if (w) w(); } }
// Give any RPC-backed read a hard time limit so a rate-limited public RPC cannot hang a scan or a quote.
export const BUSY = "Robinhood Chain's public RPC is rate-limiting right now; this read was skipped. Try again in a minute.";
export function deadline(promise, ms, message = BUSY) { let t; return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(message), { code: "rpc_busy" })), ms); })]).finally(() => clearTimeout(t)); }
export const isBusy = (e) => e?.code === "rpc_busy" || /429|Too Many|Rate Limit|server response 5\d\d|SERVER_ERROR|timeout/i.test(e?.shortMessage || e?.message || "");
export const rpcMessage = (e, fallback) => (isBusy(e) ? BUSY : (fallback || e?.message || "Read failed."));
export async function withRetry(fn, tries = 5) { let last; for (let i = 0; i < tries; i++) { try { return await gate(fn); } catch (e) { last = e; const m = e.shortMessage || e.message || ""; if (!/retry limit|429|coalesce|timeout|ECONNRESET|fetch failed|limit|Too Many|server response 5\d\d|SERVER_ERROR|bad response/i.test(m)) throw e; await new Promise((r) => setTimeout(r, Math.max(800 * 2 ** i, cooldown()))); } } throw last; }
export const factory = new ethers.Contract(ADDR.factory, ABI.factory, provider);
export const escrow = new ethers.Contract(ADDR.feeEscrow, ABI.escrow, provider);
export const curveI = new ethers.Interface(ABI.curve);
export const tokenI = new ethers.Interface(ABI.token);
export const factoryI = factory.interface;
export const TOPIC = {
  launched: factoryI.getEvent("TokenLaunched").topicHash,
  graduated: factoryI.getEvent("PoolGraduated").topicHash,
  buy: curveI.getEvent("CurveBuy").topicHash,
  sell: curveI.getEvent("CurveSell").topicHash,
  transfer: tokenI.getEvent("Transfer").topicHash,
};
export const curveAt = (a) => new ethers.Contract(a, ABI.curve, provider);
export const tokenAt = (a) => new ethers.Contract(a, ABI.token, provider);
export const short = (a) => (a ? a.slice(0, 5) + "…" + a.slice(-4) : "");
export const low = (a) => String(a || "").toLowerCase();
export const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || "").trim());
export const fmtEth = (wei, d = 4) => +Number(ethers.formatEther(wei)).toFixed(d);
export const SYSTEM = new Set([low(ADDR.factory), low(ADDR.feeEscrow), low(ADDR.buybackVault), low(ADDR.launchLocker), low(ADDR.dead), low(ethers.ZeroAddress), low(ADDR.launchAndBuy)]);

// ---------- logs, in chunks the RPC accepts ----------
const MAX_ADDR = 300; // multi-address log queries fail past ~1000 addresses; stay well under
const LIMIT_ERR = /coalesce|limit|too many|exceed|response size|timeout|10000|-32005|-32000/i;
/** getLogs that survives the RPC's size limits: splits the address list, then the block range, until it fits. */
export async function getLogs({ address, topics, fromBlock, toBlock }, depth = 0) {
  if (Array.isArray(address) && !address.length) return [];
  if (Array.isArray(address) && address.length > MAX_ADDR) {
    const out = [];
    for (let i = 0; i < address.length; i += MAX_ADDR) out.push(...(await getLogs({ address: address.slice(i, i + MAX_ADDR), topics, fromBlock, toBlock }, depth)));
    return out.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  }
  try { return await gate(() => provider.getLogs({ address, topics, fromBlock, toBlock })); }
  catch (e) {
    const msg = e.shortMessage || e.message || ""; const span = toBlock - fromBlock;
    if (/retry limit|429|Too Many/i.test(msg) && depth < 4) { await new Promise((r) => setTimeout(r, Math.max(2000 * (depth + 1), cooldown()))); return getLogs({ address, topics, fromBlock, toBlock }, depth + 1); }
    if (depth > 12 || !LIMIT_ERR.test(msg)) throw e;
    if (span >= 200) { const mid = fromBlock + Math.floor(span / 2); const a = await getLogs({ address, topics, fromBlock, toBlock: mid }, depth + 1); const b = await getLogs({ address, topics, fromBlock: mid + 1, toBlock }, depth + 1); return a.concat(b); }
    if (Array.isArray(address) && address.length > 20) { const h = Math.ceil(address.length / 2); const a = await getLogs({ address: address.slice(0, h), topics, fromBlock, toBlock }, depth + 1); const b = await getLogs({ address: address.slice(h), topics, fromBlock, toBlock }, depth + 1); return a.concat(b).sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index); }
    throw e;
  }
}
/** Windowed log scan over long ranges (10M blocks per call), newest-first when `backwards`. */
export async function scanLogs(filter, from, to, { backwards = false, stopWhen = null } = {}) {
  const out = [];
  if (backwards) { for (let hi = to; hi >= from; hi -= LOG_WINDOW) { const lo = Math.max(from, hi - LOG_WINDOW + 1); const part = await getLogs({ ...filter, fromBlock: lo, toBlock: hi }); out.unshift(...part); if (stopWhen && stopWhen(out)) break; } }
  else { for (let lo = from; lo <= to; lo += LOG_WINDOW) { const hi = Math.min(to, lo + LOG_WINDOW - 1); out.push(...(await getLogs({ ...filter, fromBlock: lo, toBlock: hi }))); if (stopWhen && stopWhen(out)) break; } }
  return out;
}

export const parseLaunch = (l) => { const d = factoryI.parseLog(l); return { token: low(d.args.token), curve: low(d.args.curve), deployer: low(d.args.deployer), pairToken: low(d.args.pairToken), block: l.blockNumber, tx: l.transactionHash }; };
export const parseTrade = (l) => { const d = curveI.parseLog(l); if (!d) return null; const buy = d.name === "CurveBuy"; return { kind: buy ? "buy" : "sell", curve: low(l.address), who: low(buy ? d.args.buyer : d.args.seller), to: low(d.args.recipient), eth: buy ? d.args.quoteIn : d.args.quoteOut, tokens: buy ? d.args.tokensOut : d.args.tokensIn, tax: d.args.tax, block: l.blockNumber, tx: l.transactionHash, index: l.index }; };
export const parseTransfer = (l) => { const d = tokenI.parseLog(l); if (!d) return null; return { token: low(l.address), from: low(d.args.from), to: low(d.args.to), value: d.args.value, block: l.blockNumber, index: l.index }; };

// ---------- reads ----------
export async function launched(token) { const r = await factory.getLaunchedToken(token); return r.exists ? { token: low(r.token), curve: low(r.curve), deployer: low(r.deployer), feeRecipient: low(r.creatorFeeRecipient), pairToken: low(r.pairToken), graduationThreshold: r.graduationThreshold, creatorTaxBps: Number(r.creatorTaxBps), buybackEnabled: r.buybackEnabled, phase: Number(r.phase) } : null; }
export async function tokenMeta(token) {
  const t = tokenAt(token);
  const [name, symbol, supply, info] = await Promise.all([t.name(), t.symbol(), t.totalSupply(), t.getTokenInfo().catch(() => null)]);
  const s = info ? info[3] : null;
  const socials = s ? { twitter: s[0] || "", telegram: s[1] || "", discord: s[2] || "", website: s[3] || "", farcaster: s[4] || "" } : {};
  return { name: String(name).slice(0, 48), symbol: String(symbol).slice(0, 16), supply, logo: info ? String(info[1]).slice(0, 300) : "", description: info ? String(info[2]).slice(0, 400) : "", socials, socialsCount: Object.values(socials).filter((v) => v && /\S/.test(v)).length };
}
export async function curveState(curve, { snipe = true } = {}) {
  const c = curveAt(curve);
  const [rq, gt, grad, tax, fee, snipeBps] = await Promise.all([c.realQuoteReserve(), c.graduationThreshold(), c.graduated(), c.creatorTaxBps(), c.feeBps(), snipe ? c.currentSnipeTaxBps(ethers.ZeroAddress).catch(() => 0n) : 0n]);
  return { eth: fmtEth(rq, 5), threshold: fmtEth(gt, 4), curvePct: gt > 0n ? Math.min(100, +((Number(rq) / Number(gt)) * 100).toFixed(1)) : 0, graduated: grad, creatorTax: Number(tax) / 100, feeBps: Number(fee), snipeTax: Number(snipeBps) / 100 };
}
/** Launches by one deployer over the whole history (8 windowed calls, so cache the result). */
export async function deployerLaunches(deployer, head) { return (await scanLogs({ address: ADDR.factory, topics: [TOPIC.launched, null, null, ethers.zeroPadValue(deployer, 32)] }, FIRST_BLOCK, head)).map(parseLaunch); }
/** The TokenLaunched log for one token: scans backwards from head and stops at the first hit. */
export async function findLaunch(token, head) { const l = await scanLogs({ address: ADDR.factory, topics: [TOPIC.launched, ethers.zeroPadValue(token, 32)] }, FIRST_BLOCK, head, { backwards: true, stopWhen: (o) => o.length > 0 }); return l.length ? parseLaunch(l[0]) : null; }
export async function feesClaimed(recipient, head) { const logs = await scanLogs({ address: ADDR.feeEscrow, topics: [escrow.interface.getEvent("Claimed").topicHash, ethers.zeroPadValue(recipient, 32)] }, FIRST_BLOCK, head); let sum = 0n; for (const l of logs) sum += escrow.interface.parseLog(l).args.amount; return fmtEth(sum, 4); }

let ethUsdCache = { at: 0, v: 0 };
export async function ethUsd() {
  if (Date.now() - ethUsdCache.at < 120_000 && ethUsdCache.v) return ethUsdCache.v;
  try { const j = await (await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(6000) })).json(); const v = Number(j.data.amount); if (v > 0) { ethUsdCache = { at: Date.now(), v }; return v; } } catch {}
  try { const j = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { signal: AbortSignal.timeout(6000) })).json(); const v = Number(j.ethereum.usd); if (v > 0) { ethUsdCache = { at: Date.now(), v }; return v; } } catch {}
  return ethUsdCache.v || 0;
}
export const blockTime = 0.1; // seconds per block on Robinhood Chain (measured)
export const blocksAgo = (seconds) => Math.round(seconds / blockTime);
