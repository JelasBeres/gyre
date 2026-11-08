// Who is talking to GYRE, and what their wallet allows.
// A wallet signs one message in the browser; the server verifies it, opens a session (cookie) and reads the
// wallet's $GYRE balance from the chain to pick a tier: free, holder (≥ holderBps of supply) or plus (≥ plusBps).
// The same wallet can claim one CLI access code (bound to the first device that uses it). Balances are re-read
// every 10 minutes, so selling the token closes the tier. Until the token address is set, everything is open.
import { ethers } from "ethers";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { provider, isAddr, low, short } from "./pons.js";

const ERC20 = ["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)"];
const MSG = /^GYRE access\nWallet: (0x[0-9a-fA-F]{40})\nIssued: (\d{13})$/;
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const err = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });
const hash = (s) => createHash("sha256").update(String(s).trim().toUpperCase()).digest("hex");
export const TIER_RANK = { free: 0, holder: 1, plus: 2, owner: 3 };

export function createAccess({ dir, settings }) {
  const FILE = path.join(dir, "access.json");
  let db = { sessions: {}, codes: {}, wallets: {}, prefs: {} }, loaded = false, saving = Promise.resolve();
  const token = () => (settings.data.token || "").trim();
  async function load() { if (loaded) return; try { db = { ...db, ...JSON.parse(await readFile(FILE, "utf8")) }; } catch {} loaded = true; }
  function save() { saving = saving.then(async () => { await mkdir(dir, { recursive: true }); await writeFile(FILE + ".tmp", JSON.stringify(db), { mode: 0o600 }); await rename(FILE + ".tmp", FILE); }).catch(() => {}); return saving; }
  const newCode = () => { const b = randomBytes(20); let s = ""; for (const x of b) s += B32[x & 31]; return "GYRE-" + s.match(/.{5}/g).join("-"); };

  // ---------- balance → tier, cached 10 minutes ----------
  const cache = new Map();
  async function holding(wallet) {
    const t = token(); if (!t) return { tier: "free", open: true, have: "0", needHolder: "0", needPlus: "0" };
    const hit = cache.get(wallet); if (hit && Date.now() - hit.at < 600_000) return hit;
    const c = new ethers.Contract(t, ERC20, provider);
    let bal, supply, dec;
    try { [bal, supply, dec] = await Promise.all([c.balanceOf(wallet), c.totalSupply(), c.decimals()]); }
    catch { if (hit) return hit; throw err(503, "Couldn't read the chain right now. Try again in a minute."); }
    const { holderBps = 10, plusBps = 50 } = settings.data.tiers || {};
    const needH = (supply * BigInt(holderBps)) / 10000n, needP = (supply * BigInt(plusBps)) / 10000n;
    const r = { at: Date.now(), tier: bal > 0n && bal >= needP ? "plus" : bal > 0n && bal >= needH ? "holder" : "free", open: false, have: ethers.formatUnits(bal, dec), needHolder: ethers.formatUnits(needH, dec), needPlus: ethers.formatUnits(needP, dec) };
    cache.set(wallet, r); return r;
  }

  return {
    info() { const t = token(); return { live: !!t, token: t || null, symbol: "GYRE", tiers: settings.data.tiers, pons: t ? `https://ponsfamily.com/launchpad/${t}` : null }; },
    challenge(wallet) { if (!isAddr(wallet)) throw err(400, "Not a wallet address."); return `GYRE access\nWallet: ${ethers.getAddress(wallet)}\nIssued: ${Date.now()}`; },

    /** verify a signed challenge and open a session; returns { sid, wallet, tier } */
    async signIn({ message, signature }) {
      await load();
      const m = String(message || "").match(MSG); if (!m) throw err(400, "Bad message.");
      if (Math.abs(Date.now() - +m[2]) > 600_000) throw err(400, "That signature is too old. Sign again.");
      let signer; try { signer = ethers.verifyMessage(message, String(signature || "")); } catch { signer = ""; }
      const wallet = low(m[1]); if (low(signer) !== wallet) throw err(401, "The signature doesn't match the wallet.");
      const sid = randomBytes(24).toString("hex");
      db.sessions[hash(sid)] = { wallet, at: Date.now(), seen: Date.now() };
      for (const [k, s] of Object.entries(db.sessions)) if (Date.now() - s.seen > 60 * 86_400_000) delete db.sessions[k];
      await save();
      return { sid, ...(await this.me(sid)) };
    },
    async me(sid) {
      await load();
      const s = sid && db.sessions[hash(sid)];
      if (!s) return { wallet: null, tier: "free", open: !token() };
      s.seen = Date.now();
      const h = await holding(s.wallet).catch(() => ({ tier: "free", open: false, have: "?" }));
      return { wallet: s.wallet, short: short(s.wallet), tier: h.tier, open: h.open, have: h.have, needHolder: h.needHolder, needPlus: h.needPlus };
    },
    async signOut(sid) { await load(); delete db.sessions[hash(sid)]; await save(); },
    /** rank check used by routes: owner key beats everything */
    allows(me, tier) { if (me.open) return true; return (TIER_RANK[me.tier] || 0) >= (TIER_RANK[tier] || 0); },

    // ---------- per-wallet (or per-session) preferences ----------
    prefs(key) { return db.prefs[key] || null; },
    async setPrefs(key, v) { await load(); db.prefs[key] = { ...(db.prefs[key] || {}), ...v }; await save(); return db.prefs[key]; },

    // ---------- CLI codes ----------
    async claimCode(sid) {
      await load();
      const me = await this.me(sid); if (!me.wallet) throw err(401, "Connect your wallet on the site first.");
      if (!me.open && TIER_RANK[me.tier] < 1) throw err(403, `This wallet holds ${Number(me.have).toLocaleString("en-US")} $GYRE. The CLI needs the Holder tier (${Number(me.needHolder).toLocaleString("en-US")}).`);
      const old = db.wallets[me.wallet]; if (old) delete db.codes[old];
      const code = newCode(); db.codes[hash(code)] = { wallet: me.wallet, at: Date.now() }; db.wallets[me.wallet] = hash(code); await save();
      return { code, wallet: me.wallet, replaced: !!old };
    },
    async checkCode(code, device) {
      await load();
      const e = code && db.codes[hash(code)];
      if (!e) throw err(401, "Unknown access code. Get one from the panel (Settings → CLI), then run: gyre login <code>");
      if (e.owner) return { wallet: e.wallet, tier: "owner", owner: true };
      if (!/^[0-9a-f]{32,64}$/.test(String(device || ""))) throw err(400, "Please update the CLI: npm i -g gyre-cli@latest");
      const d = hash(device);
      if (e.device && e.device !== d) throw err(403, "This code is already used on another device. Get a new code from the panel to move it.");
      const h = await holding(e.wallet);
      if (!h.open && TIER_RANK[h.tier] < 1) throw err(403, `The wallet behind this code (${short(e.wallet)}) no longer holds enough $GYRE.`);
      if (!e.device) { e.device = d; e.boundAt = Date.now(); await save(); }
      return { wallet: e.wallet, tier: h.open ? "holder" : h.tier };
    },
    async ownerCode(label) {
      await load();
      const name = "owner:" + String(label || "team").replace(/[^\w.-]/g, "").slice(0, 32);
      const old = db.wallets[name]; if (old) delete db.codes[old];
      const code = newCode(); db.codes[hash(code)] = { wallet: name, owner: true, at: Date.now() }; db.wallets[name] = hash(code); await save();
      return { code, wallet: name };
    },
    stats() { return { sessions: Object.keys(db.sessions).length, codes: Object.keys(db.codes).length }; },
  };
}

/** constant-time compare for the studio key */
export function keyMatches(given, want) { const a = Buffer.from(String(given || "")), b = Buffer.from(String(want || "")); return b.length >= 16 && a.length === b.length && timingSafeEqual(a, b); }
