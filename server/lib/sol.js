// Solana reads for GYRE: mint authorities, token program and extensions, largest holders with pool detection, and
// the launcher's funding trail. Public RPC by default; set SOLANA_RPC (Helius/Alchemy free tier) for higher limits.
const RPC = () => process.env.SOLANA_RPC || "https://solana-rpc.publicnode.com";
const RPC_IDX = () => process.env.SOLANA_RPC || process.env.SOLANA_RPC_INDEXED || "https://api.mainnet-beta.solana.com";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", SYSTEM = "11111111111111111111111111111111";
const KNOWN = { "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1": "Raydium AMM authority", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "Pump AMM", "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun bonding curve", "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CLMM", "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora DLMM", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca Whirlpool", "1nc1nerator11111111111111111111111111111111": "incinerator (burn)" };
const err = (code, message) => Object.assign(new Error(message), { code });
let seq = 0; const cache = new Map();
export async function rpc(method, params, { indexed = false, ttl = 0 } = {}) {
  const k = method + JSON.stringify(params); const hit = cache.get(k); if (ttl && hit && Date.now() - hit.at < ttl) return hit.v;
  const r = await fetch(indexed ? RPC_IDX() : RPC(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }), signal: AbortSignal.timeout(15_000) });
  const j = await r.json().catch(() => ({})); if (j.error) throw err(j.error.code === 429 || /Too many/i.test(j.error.message || "") ? 429 : 502, `Solana RPC: ${j.error.message || j.error.code}`);
  if (ttl) cache.set(k, { at: Date.now(), v: j.result }); return j.result;
}
export const isMint = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ""));
export const explorer = { tx: (s) => `https://solscan.io/tx/${s}`, addr: (a) => `https://solscan.io/account/${a}`, token: (a) => `https://solscan.io/token/${a}` };

export async function mintInfo(mint) {
  const acc = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }], { ttl: 60_000 }); const v = acc?.value; if (!v) throw err(404, "No account at that address on Solana.");
  const info = v.data?.parsed?.info; if (v.data?.parsed?.type !== "mint" || !info) throw err(400, "That address is not a token mint.");
  const program = v.owner === TOKEN22 ? "token-2022" : v.owner === TOKEN ? "spl-token" : v.owner;
  const ext = (info.extensions || []).map((e) => e.extension); const fee = (info.extensions || []).find((e) => e.extension === "transferFeeConfig")?.state?.newerTransferFee;
  return { mint, program, decimals: info.decimals, supply: info.supply, mintAuthority: info.mintAuthority || null, freezeAuthority: info.freezeAuthority || null, extensions: ext, transferFeeBps: fee ? Number(fee.transferFeeBasisPoints) : 0, permanentDelegate: ext.includes("permanentDelegate"), nonTransferable: ext.includes("nonTransferable") };
}
export async function largestHolders(mint, supply, decimals) {
  const r = await rpc("getTokenLargestAccounts", [mint], { indexed: true, ttl: 120_000 }); const list = (r?.value || []).slice(0, 20);
  const accs = await rpc("getMultipleAccounts", [list.map((a) => a.address), { encoding: "jsonParsed" }], { ttl: 120_000 });
  const owners = (accs?.value || []).map((a) => a?.data?.parsed?.info?.owner || null);
  const ownerAccs = await rpc("getMultipleAccounts", [owners.filter(Boolean), { encoding: "base64", dataSlice: { offset: 0, length: 0 } }], { ttl: 120_000 });
  const ownerMeta = {}; owners.filter(Boolean).forEach((o, i) => { const a = ownerAccs?.value?.[i]; ownerMeta[o] = { exists: !!a, programOwned: !!a && a.owner !== SYSTEM, executable: !!a?.executable }; });
  const S = Number(supply) / 10 ** decimals;
  const rows = list.map((a, i) => { const o = owners[i]; const amt = Number(a.uiAmount ?? Number(a.amount) / 10 ** decimals); const m = ownerMeta[o] || {}; const label = KNOWN[o] || (m.programOwned ? "pool / program-owned" : "wallet"); return { account: a.address, owner: o, amount: amt, pct: S ? (amt / S) * 100 : null, label, pool: label !== "wallet" }; });
  const wallets = rows.filter((r) => !r.pool); const top10 = wallets.slice(0, 10).reduce((a, r) => a + (r.pct || 0), 0);
  return { rows, top10WalletsPct: +top10.toFixed(2), largestWalletPct: +(wallets[0]?.pct || 0).toFixed(2), poolPct: +rows.filter((r) => r.pool).reduce((a, r) => a + (r.pct || 0), 0).toFixed(2) };
}
// Who funded the launcher: first signatures of the deployer/creator, the SOL source of its first inbound transfer.
export async function fundingTrail(address, depth = 2) {
  const trail = []; let cur = address;
  for (let i = 0; i < depth && cur; i++) {
    const sigs = await rpc("getSignaturesForAddress", [cur, { limit: 1000 }], { indexed: true, ttl: 300_000 }).catch(() => null); if (!sigs?.length) { trail.push({ address: cur, txCount: 0 }); break; }
    const oldest = sigs[sigs.length - 1]; const tx = await rpc("getTransaction", [oldest.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], { indexed: true, ttl: 300_000 }).catch(() => null);
    let funder = null; for (const ix of tx?.transaction?.message?.instructions || []) { const p = ix.parsed; if (p?.type === "transfer" && p.info?.destination === cur) { funder = p.info.source; break; } }
    trail.push({ address: cur, txCount: sigs.length >= 1000 ? "1000+" : sigs.length, firstSeen: oldest.blockTime ? new Date(oldest.blockTime * 1000).toISOString() : null, firstTx: oldest.signature, fundedBy: funder, fundedByLabel: funder ? KNOWN[funder] || null : null });
    cur = funder && funder !== cur ? funder : null;
  }
  return trail;
}
export async function balance(owner) { const r = await rpc("getBalance", [owner]); return (r?.value || 0) / 1e9; }
export async function tokenBalance(owner, mint) { const r = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]); return (r?.value || []).reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0); }
export async function sigStatus(sig) { const r = await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]); const s = r?.value?.[0]; return s ? { confirmed: !!s.confirmationStatus, status: s.confirmationStatus, err: s.err || null } : { confirmed: false, status: null, err: null }; }
