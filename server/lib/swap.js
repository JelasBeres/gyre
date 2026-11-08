// Non-custodial swaps. GYRE only builds: Solana routes through Jupiter (quote + unsigned transaction), Robinhood
// Chain through the Pons curve (calldata). The visitor's wallet signs and sends; nothing passes through GYRE.
import { ethers } from "ethers";
import * as P from "./pons.js";
import * as SOL from "./sol.js";
const JUP = "https://lite-api.jup.ag/swap/v1";
const err = (code, message) => Object.assign(new Error(message), { code });
export const WSOL = "So11111111111111111111111111111111111111112";
async function jup(path, init) { const r = await fetch(JUP + path, { ...init, headers: { accept: "application/json", "content-type": "application/json", ...(init?.headers || {}) }, signal: AbortSignal.timeout(15_000) }); const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw err(r.status === 429 ? 429 : 400, j.error || `Jupiter ${r.status}`); return j; }
export async function solQuote({ inputMint, outputMint, amount, slippageBps = 100 }) {
  if (!SOL.isMint(inputMint) || !SOL.isMint(outputMint)) throw err(400, "Bad mint address."); const a = BigInt(String(amount || 0)); if (a <= 0n) throw err(400, "Enter an amount.");
  const q = await jup(`/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${a}&slippageBps=${Math.max(10, Math.min(3000, Number(slippageBps) || 100))}&restrictIntermediateTokens=true`);
  return { quote: q, inAmount: q.inAmount, outAmount: q.outAmount, minOut: q.otherAmountThreshold, priceImpactPct: Number(q.priceImpactPct || 0), route: (q.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean) };
}
export async function solBuild({ quote, owner }) {
  if (!SOL.isMint(owner)) throw err(400, "Bad wallet address."); if (!quote?.inputMint) throw err(400, "Quote missing.");
  const j = await jup(`/swap`, { method: "POST", body: JSON.stringify({ quoteResponse: quote, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: false, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } } }) });
  return { transaction: j.swapTransaction, lastValidBlockHeight: j.lastValidBlockHeight };
}
export const solStatus = (sig) => SOL.sigStatus(sig);
// Robinhood: Pons curve. Buy with ETH, sell tokens (needs approve to the curve first).
// The site's own token: quote from the buy module's cached curve state (refreshed every 30 s in the background), so the
// terminal never waits on a rate-limited RPC for $GYRE. Other Pons tokens still read the curve live.
let tokenView = null; export const setTokenView = (fn) => { tokenView = fn; };
async function cachedQuote({ token, side, amount, owner }) {
  const v = await tokenView(); if (!v?.token || v.token.toLowerCase() !== token.toLowerCase() || !v.curve) return null;
  if (v.graduated) return { graduated: true, curve: v.curve, dex: "https://dexscreener.com/robinhood/" + token };
  const q = ethers.parseEther(String(v.quoteReserve)), tr = ethers.parseUnits(String(v.tokenReserve), 18), fee = BigInt(v.feeBps + v.taxBps), hex = "0x" + P.CHAIN_ID.toString(16);
  if (side === "buy") { const wei = ethers.parseEther(String(amount)); const inAfter = wei - (wei * fee) / 10_000n; const out = (tr * inAfter) / (q + inAfter); const min = (out * 97n) / 100n;
    return { graduated: false, curve: v.curve, side: "buy", to: v.curve, value: "0x" + wei.toString(16), data: owner ? P.curveI.encodeFunctionData("buy", [wei, min, owner]) : null, out: ethers.formatUnits(out, 18), minOut: ethers.formatUnits(min, 18), feeBps: Number(fee), snipeTaxBps: 0, chainHex: hex, cached: true }; }
  const amt = ethers.parseUnits(String(amount), 18); const inAfter = amt - (amt * fee) / 10_000n; const outQ = (q * inAfter) / (tr + inAfter); const min = (outQ * 97n) / 100n;
  let allowance = 0n; if (owner) { try { allowance = await P.deadline(P.tokenAt(token).allowance(owner, v.curve), 4000); } catch { allowance = 0n; } }
  return { graduated: false, curve: v.curve, side: "sell", to: v.curve, value: "0x0", data: owner ? P.curveI.encodeFunctionData("sell", [amt, min, owner]) : null, approveData: P.tokenI.encodeFunctionData("approve", [v.curve, amt]), needsApprove: allowance < amt, token, out: ethers.formatEther(outQ), minOut: ethers.formatEther(min), feeBps: Number(fee), chainHex: hex, cached: true };
}
export async function rhQuote(args) {
  if (tokenView) { try { const c = await P.deadline(cachedQuote(args), 6000); if (c) return c; } catch {} }
  try { return await P.deadline(rhQuoteNow(args), 15_000); } catch (e) { if (P.isBusy(e)) throw err(503, P.BUSY); throw e; } }
async function rhQuoteNow({ token, side, amount, owner }) {
  const rec = await P.withRetry(() => P.launched(token)); if (!rec) throw err(400, "Not a Pons token. Graduated or non-Pons tokens trade on their DEX pool.");
  const c = P.curveAt(rec.curve); if (await P.withRetry(() => c.graduated())) return { graduated: true, curve: rec.curve, dex: `https://dexscreener.com/robinhood/${token}` };
  const [res, feeBps, taxBps] = await Promise.all([P.withRetry(() => c.getReserves()), P.withRetry(() => c.feeBps()), P.withRetry(() => c.creatorTaxBps())]);
  const q = res[0], tr = res[1]; const fee = BigInt(feeBps) + BigInt(taxBps);
  if (side === "buy") { const wei = ethers.parseEther(String(amount)); let out; try { out = owner ? await P.gate(() => c.buy.staticCall(wei, 0n, owner, { value: wei, from: owner })) : undefined; } catch {} if (out === undefined) { const inAfter = wei - (wei * fee) / 10_000n; out = (tr * inAfter) / (q + inAfter); } const min = (out * 97n) / 100n; let snipe = 0; if (owner) { try { snipe = Number(await P.gate(() => c.currentSnipeTaxBps(owner))); } catch {} }
    return { graduated: false, curve: rec.curve, side, to: rec.curve, value: "0x" + wei.toString(16), data: owner ? P.curveI.encodeFunctionData("buy", [wei, min, owner]) : null, out: ethers.formatUnits(out, 18), minOut: ethers.formatUnits(min, 18), feeBps: Number(fee), snipeTaxBps: snipe, chainHex: "0x" + P.CHAIN_ID.toString(16) }; }
  const amt = ethers.parseUnits(String(amount), 18); const inAfter = amt - (amt * fee) / 10_000n; const outQ = (q * inAfter) / (tr + inAfter); const min = (outQ * 97n) / 100n;
  const allowance = owner ? await P.withRetry(() => P.tokenAt(token).allowance(owner, rec.curve)).catch(() => 0n) : 0n;
  return { graduated: false, curve: rec.curve, side: "sell", to: rec.curve, value: "0x0", data: owner ? P.curveI.encodeFunctionData("sell", [amt, min, owner]) : null, approveData: P.tokenI.encodeFunctionData("approve", [rec.curve, amt]), needsApprove: allowance < amt, token, out: ethers.formatEther(outQ), minOut: ethers.formatEther(min), feeBps: Number(fee), chainHex: "0x" + P.CHAIN_ID.toString(16) };
}
export async function rhStatus(hash) { const rc = await P.withRetry(() => P.provider.getTransactionReceipt(hash)).catch(() => null); return rc ? { confirmed: true, ok: rc.status === 1, block: rc.blockNumber } : { confirmed: false }; }
