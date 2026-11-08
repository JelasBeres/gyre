// GYRE's own x402 facilitator. Two settlement methods, the same two Autonomo uses on Robinhood Chain:
//   · exact / EIP-3009 for dollar stablecoins (USDG on Robinhood Chain, USDC on Base): one signature, no approval, no gas for the payer
//   · exact / Permit2 for plain ERC-20s like $GYRE: one-time approval of Permit2, then one signature per call
// The payer signs; GYRE's relayer wallet submits the transfer and pays the gas; the tokens move straight from the
// payer to the API owner (payTo). GYRE never holds the funds. Verification is done here, in code, against the chain.
import { ethers } from "ethers";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { provider as rhProvider, RPC as RH_RPC, ADDR, ABI, ethUsd, withRetry } from "./pons.js";

export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // canonical Permit2, deployed on Robinhood Chain and Base
export const NETWORKS = {
  "eip155:4663": { chainId: 4663, name: "robinhood", rpc: RH_RPC, explorer: "https://robinhoodchain.blockscout.com/tx/" },
  "eip155:8453": { chainId: 8453, name: "base", rpc: process.env.BASE_RPC_URL || "https://mainnet.base.org", explorer: "https://basescan.org/tx/" },
};
export const STABLES = {
  "eip155:4663": { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, name: "Global Dollar", version: "1" },
  "eip155:8453": { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, name: "USD Coin", version: "2" },
};
export const HOME = "eip155:4663";
const providers = { "eip155:4663": rhProvider };
export const prov = (net) => (providers[net] ||= new ethers.JsonRpcProvider(NETWORKS[net].rpc, NETWORKS[net].chainId, { staticNetwork: true }));
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const EIP3009 = [...ERC20, "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)", "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)"];
const PERMIT2_ABI = ["function permitWitnessTransferFrom(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount) transferDetails,address owner,bytes32 witness,string witnessTypeString,bytes signature)", "function nonceBitmap(address,uint256) view returns (uint256)"];
export const TYPES_3009 = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
export const TYPES_P2 = { PermitWitnessTransferFrom: [{ name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "witness", type: "Witness" }], TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], Witness: [{ name: "to", type: "address" }, { name: "validAfter", type: "uint256" }, { name: "extra", type: "bytes32" }] };
export const WITNESS_TYPE_STRING = "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter,bytes32 extra)";
export const domain3009 = (net, asset, name, version) => ({ name, version, chainId: NETWORKS[net].chainId, verifyingContract: asset });
export const domainP2 = (net) => ({ name: "Permit2", chainId: NETWORKS[net].chainId, verifyingContract: PERMIT2 });
export const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
export const unb64 = (s) => JSON.parse(Buffer.from(String(s || ""), "base64").toString("utf8"));
const low = (a) => String(a || "").toLowerCase();
const err = (code, message) => Object.assign(new Error(message), { code });
const now = () => Math.floor(Date.now() / 1000);

// price of a Pons token in USD, from its curve's reserves and the ETH price (cached a minute)
let priceCache = { at: 0, token: "", usd: null };
export async function tokenUsd(token) {
  if (!token) return null;
  if (priceCache.token === low(token) && Date.now() - priceCache.at < 60_000) return priceCache.usd;
  try {
    const fac = new ethers.Contract(ADDR.factory, ABI.factory, rhProvider); const rec = await fac.getLaunchedToken(token); if (!rec.exists) return null;
    const curve = new ethers.Contract(rec.curve, ABI.curve, rhProvider); const [q, t] = await curve.getReserves(); const eth = await ethUsd();
    const usd = t > 0n && eth ? (Number(q) / Number(t)) * eth : null;
    priceCache = { at: Date.now(), token: low(token), usd }; return usd;
  } catch { return priceCache.token === low(token) ? priceCache.usd : null; }
}

export function createFacilitator({ dir, settings }) {
  const KEY_FILE = path.join(dir, "relayer.json");
  const secret = () => { const k = process.env.GYRE_SECRET || ""; if (k.length < 32) throw err(500, "GYRE_SECRET (32+ characters) is missing in server/.env."); return createHash("sha256").update(k).digest(); };
  const seal = (txt) => { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", secret(), iv), d = Buffer.concat([c.update(txt, "utf8"), c.final()]); return [iv, c.getAuthTag(), d].map((b) => b.toString("base64")).join("."); };
  const unseal = (s) => { const [iv, tag, d] = s.split(".").map((x) => Buffer.from(x, "base64")), c = createDecipheriv("aes-256-gcm", secret(), iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString("utf8"); };
  let saved = null, loaded = false;
  async function load() { if (loaded) return; try { saved = JSON.parse(await readFile(KEY_FILE, "utf8")); } catch {} if (!saved && process.env.X402_RELAYER_KEY) { try { saved = { address: new ethers.Wallet(process.env.X402_RELAYER_KEY).address, env: true }; } catch {} } loaded = true; }
  const relayerKey = () => (saved?.env ? process.env.X402_RELAYER_KEY : saved ? unseal(saved.key) : null);
  const relayer = (net) => { const k = relayerKey(); return k ? new ethers.Wallet(k, prov(net)) : null; };
  const remote = () => String(settings.data.facilitatorUrl || process.env.X402_FACILITATOR_URL || "").replace(/\/$/, "");
  const canSettle = (net) => !!saved || (!!remote() && net !== HOME); // our relayer covers every network; a remote facilitator covers what it supports (not Robinhood Chain)

  // ---------- what a paid route accepts ----------
  async function accepts({ priceUsd, payTo, token }) {
    await load();
    const out = [], usd = Math.max(0.0001, Number(priceUsd) || 0);
    const st = STABLES[HOME]; if (canSettle(HOME)) out.push({ scheme: "exact", network: HOME, amount: String(Math.round(usd * 10 ** st.decimals)), asset: st.address, payTo, maxTimeoutSeconds: 300, extra: { name: st.name, version: st.version } });
    if (token && canSettle(HOME)) { const p = await tokenUsd(token); if (p && p > 0) out.push({ scheme: "exact", network: HOME, amount: ethers.parseUnits((usd / p).toFixed(18), 18).toString(), asset: token, payTo, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "permit2", spender: saved?.address || null, witnessTypeString: WITNESS_TYPE_STRING, symbol: "NUCLEO", usdPerToken: p } }); }
    const bs = STABLES["eip155:8453"]; if (canSettle("eip155:8453")) out.push({ scheme: "exact", network: "eip155:8453", amount: String(Math.round(usd * 10 ** bs.decimals)), asset: bs.address, payTo, maxTimeoutSeconds: 300, extra: { name: bs.name, version: bs.version } });
    return out;
  }
  function required(res, { accepts: acc, resource, description, error = "Payment required" }) {
    const body = { x402Version: 2, error, resource: { url: resource, description: description || "", mimeType: "application/json" }, accepts: acc };
    res.status(402); res.setHeader("PAYMENT-REQUIRED", b64(body)); res.setHeader("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE"); res.json(body);
  }
  function decode(req) {
    const h = req.headers["payment-signature"] || req.headers["x-payment"]; if (!h) return null;
    try { const p = unb64(h); return p && typeof p === "object" ? p : null; } catch { return null; }
  }
  const pick = (payload, acc) => { const a = payload.accepted || payload; return acc.find((r) => r.network === a.network && low(r.asset) === low(a.asset) && (!a.scheme || a.scheme === r.scheme)) || null; };

  // ---------- verify: signature, window, amount, recipient, on-chain balance / nonce / allowance ----------
  async function verify(payload, acc) {
    await load();
    const req = pick(payload, acc); if (!req) return { ok: false, error: "The payment does not match any accepted option (network or asset)." };
    const net = req.network, p = payload.payload || {};
    try {
      if (req.extra?.assetTransferMethod === "permit2") {
        const a = p.permit2Authorization; if (!a || !p.signature) return { ok: false, error: "Missing permit2Authorization or signature." };
        if (low(a.permitted?.token) !== low(req.asset)) return { ok: false, error: "The permit is for another token." };
        if (BigInt(a.permitted.amount) < BigInt(req.amount)) return { ok: false, error: "The permitted amount is below the price." };
        if (low(a.spender) !== low(saved?.address)) return { ok: false, error: "The permit's spender is not the GYRE relayer." };
        if (low(a.witness?.to) !== low(req.payTo)) return { ok: false, error: "The permit's recipient is not the API owner." };
        if (Number(a.deadline) <= now() + 5) return { ok: false, error: "The permit has expired." };
        if (Number(a.witness.validAfter || 0) > now()) return { ok: false, error: "The permit is not valid yet." };
        const digest = ethers.TypedDataEncoder.hash(domainP2(net), TYPES_P2, { permitted: a.permitted, spender: a.spender, nonce: a.nonce, deadline: a.deadline, witness: a.witness });
        if (low(ethers.recoverAddress(digest, p.signature)) !== low(a.from)) return { ok: false, error: "The signature does not match the payer." };
        const p2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, prov(net)), erc = new ethers.Contract(req.asset, ERC20, prov(net)), nonce = BigInt(a.nonce);
        const [bitmap, bal, allow] = await withRetry(() => Promise.all([p2.nonceBitmap(a.from, nonce >> 8n), erc.balanceOf(a.from), erc.allowance(a.from, PERMIT2)]), 4);
        if ((bitmap >> (nonce & 255n)) & 1n) return { ok: false, error: "That permit nonce was already used." };
        if (bal < BigInt(req.amount)) return { ok: false, error: "The payer's token balance is below the price." };
        if (allow < BigInt(req.amount)) return { ok: false, error: "The payer has not approved Permit2 for this token yet." };
        return { ok: true, requirement: req, payer: ethers.getAddress(a.from), method: "permit2" };
      }
      const a = p.authorization; if (!a || !p.signature) return { ok: false, error: "Missing authorization or signature." };
      if (low(a.to) !== low(req.payTo)) return { ok: false, error: "The authorization's recipient is not the API owner." };
      if (BigInt(a.value) < BigInt(req.amount)) return { ok: false, error: "The authorized value is below the price." };
      const t = now(); if (Number(a.validAfter) > t) return { ok: false, error: "The authorization is not valid yet." }; if (Number(a.validBefore) <= t + 5) return { ok: false, error: "The authorization has expired." };
      const digest = ethers.TypedDataEncoder.hash(domain3009(net, req.asset, req.extra.name, req.extra.version), TYPES_3009, a);
      if (low(ethers.recoverAddress(digest, p.signature)) !== low(a.from)) return { ok: false, error: "The signature does not match the payer." };
      const c = new ethers.Contract(req.asset, EIP3009, prov(net));
      const [used, bal] = await withRetry(() => Promise.all([c.authorizationState(a.from, a.nonce), c.balanceOf(a.from)]), 4);
      if (used) return { ok: false, error: "That authorization nonce was already used." };
      if (bal < BigInt(req.amount)) return { ok: false, error: "The payer's balance is below the price." };
      return { ok: true, requirement: req, payer: ethers.getAddress(a.from), method: "eip3009" };
    } catch (e) { return { ok: false, error: "Could not verify the payment: " + (e.shortMessage || e.message).slice(0, 120) }; }
  }

  // ---------- settle: the relayer submits the transfer, or a remote facilitator does ----------
  async function settle(payload, req) {
    await load();
    const net = req.network, p = payload.payload || {};
    if (!saved && remote() && net !== HOME) return settleRemote(payload, req);
    const w = relayer(net); if (!w) return { success: false, errorReason: "No relayer wallet is configured on this server.", network: net };
    try {
      let tx;
      if (req.extra?.assetTransferMethod === "permit2") {
        const a = p.permit2Authorization; const p2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, w);
        const witness = ethers.TypedDataEncoder.hashStruct("Witness", { Witness: TYPES_P2.Witness }, a.witness);
        tx = await p2.permitWitnessTransferFrom({ permitted: a.permitted, nonce: a.nonce, deadline: a.deadline }, { to: req.payTo, requestedAmount: req.amount }, a.from, witness, WITNESS_TYPE_STRING, p.signature);
      } else {
        const a = p.authorization; const sig = ethers.Signature.from(p.signature); const c = new ethers.Contract(req.asset, EIP3009, w);
        tx = await c.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig.v, sig.r, sig.s);
      }
      const rc = await tx.wait(); if (rc.status !== 1) return { success: false, errorReason: "The transfer reverted.", transaction: tx.hash, network: net };
      return { success: true, transaction: tx.hash, network: net, payer: (p.authorization || p.permit2Authorization).from, explorer: NETWORKS[net].explorer + tx.hash };
    } catch (e) { return { success: false, errorReason: (e.shortMessage || e.reason || e.message || "settlement failed").slice(0, 160), network: net }; }
  }
  async function settleRemote(payload, req) {
    try {
      const r = await fetch(remote() + "/settle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: req }) });
      const j = await r.json().catch(() => ({})); if (!r.ok || !j.success) return { success: false, errorReason: j.errorReason || j.error || `facilitator answered ${r.status}`, network: req.network };
      return { success: true, transaction: j.transaction, network: j.network || req.network, payer: j.payer, explorer: (NETWORKS[req.network]?.explorer || "") + (j.transaction || "") };
    } catch (e) { return { success: false, errorReason: "The remote facilitator is unreachable.", network: req.network }; }
  }
  const responseHeader = (r) => b64({ success: !!r.success, transaction: r.transaction || null, network: r.network, payer: r.payer || null, errorReason: r.errorReason || undefined });

  // ---------- facilitator admin ----------
  async function setRelayerKey(raw) { await load(); const k = String(raw || "").trim(); if (!k) { saved = null; await mkdir(dir, { recursive: true }); await writeFile(KEY_FILE + ".tmp", "null", { mode: 0o600 }); await rename(KEY_FILE + ".tmp", KEY_FILE); return; } let w; try { w = new ethers.Wallet(k.startsWith("0x") ? k : "0x" + k); } catch { throw err(400, "That is not a valid private key."); } saved = { address: w.address, key: seal(w.privateKey), at: Date.now() }; await mkdir(dir, { recursive: true }); await writeFile(KEY_FILE + ".tmp", JSON.stringify(saved), { mode: 0o600 }); await rename(KEY_FILE + ".tmp", KEY_FILE); }
  async function info() { await load(); const v = { address: saved?.address || null, fromEnv: !!saved?.env, remote: remote() || null, networks: {}, secretOk: (process.env.GYRE_SECRET || "").length >= 32 }; for (const net of Object.keys(NETWORKS)) { v.networks[net] = { name: NETWORKS[net].name, settles: canSettle(net), gas: null }; if (saved) { try { v.networks[net].gas = ethers.formatEther(await prov(net).getBalance(saved.address)); } catch {} } } return v; }
  const supported = () => ({ kinds: Object.keys(NETWORKS).filter(canSettle).flatMap((net) => [{ x402Version: 2, scheme: "exact", network: net }, ...(net === HOME ? [{ x402Version: 2, scheme: "exact", network: net, extra: { assetTransferMethod: "permit2" } }] : [])]) });
  return { accepts, required, decode, verify, settle, responseHeader, setRelayerKey, info, supported, seal, unseal, relayerAddress: () => saved?.address || null };
}
