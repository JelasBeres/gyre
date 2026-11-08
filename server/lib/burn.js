// Buyback & burn, run by hand from /studio. The owner saves a SEPARATE burn wallet's key once; it is encrypted
// at rest with GYRE_SECRET from .env and never leaves the server. The only thing this code does with it is buy
// $GYRE on its Pons curve with the dead address as recipient, so every token bought is burned in the same
// transaction. Capped per run and per day. The public log feeds the landing page.
import { ethers } from "ethers";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { provider, ADDR, ABI, ethUsd } from "./pons.js";

const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
const err = (code, message) => Object.assign(new Error(message), { code });

export function createBurn({ dir, token }) {
  const KEY_FILE = path.join(dir, "burn-wallet.json"), LOG_FILE = path.join(dir, "burn-log.json");
  const maxUsd = () => Number(process.env.BURN_MAX_USD || 100), dayUsd = () => Number(process.env.BURN_DAY_USD || 300);
  const secret = () => { const k = process.env.GYRE_SECRET || ""; if (k.length < 32) throw err(500, "GYRE_SECRET (32+ characters) is missing in server/.env."); return createHash("sha256").update(k).digest(); };
  const seal = (txt) => { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", secret(), iv), d = Buffer.concat([c.update(txt, "utf8"), c.final()]); return [iv, c.getAuthTag(), d].map((b) => b.toString("base64")).join("."); };
  const unseal = (s) => { const [iv, tag, d] = s.split(".").map((x) => Buffer.from(x, "base64")), c = createDecipheriv("aes-256-gcm", secret(), iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString("utf8"); };
  async function save(file, v) { await mkdir(dir, { recursive: true }); await writeFile(file + ".tmp", JSON.stringify(v, null, 1), { mode: 0o600 }); await rename(file + ".tmp", file); }
  let saved = null, log = [], loaded = false, busy = false;
  async function load() { if (loaded) return; try { saved = JSON.parse(await readFile(KEY_FILE, "utf8")); } catch {} try { log = JSON.parse(await readFile(LOG_FILE, "utf8")) || []; } catch {} loaded = true; }
  // The dead-address balance is read in the background and served from memory, so /api/site never waits on the RPC.
  let bc = { at: 0, for: "", v: null, p: null };
  async function readBurned(t) { const c = new ethers.Contract(t, ERC20, provider); const v = ethers.formatUnits(await c.balanceOf(ADDR.dead), await c.decimals()); bc = { ...bc, at: Date.now(), for: t, v }; return v; }
  async function burned() {
    const t = token(); if (!t) return null;
    const fresh = bc.for === t && Date.now() - bc.at < 60_000;
    if (!fresh && !bc.p) bc.p = readBurned(t).catch(() => null).finally(() => { bc.p = null; });
    if (bc.for === t && bc.v != null) return bc.v;
    return Promise.race([bc.p || Promise.resolve(null), new Promise((r) => setTimeout(() => r(null), 1500))]);
  }

  return {
    async publicView() { await load(); return { token: token() || null, burned: await burned(), count: log.length, usd: +log.reduce((a, x) => a + x.usd, 0).toFixed(2), eth: +log.reduce((a, x) => a + Number(x.eth), 0).toFixed(5), recent: log.slice(-8).reverse().map(({ at, usd, eth, tokens, tx }) => ({ at, usd, eth, tokens, tx })) }; },
    async view() {
      await load();
      const v = { address: saved?.address || null, maxUsd: maxUsd(), dayUsd: dayUsd(), token: token() || null, log: log.slice(-20).reverse(), secretOk: (process.env.GYRE_SECRET || "").length >= 32 };
      v.today = +log.filter((x) => Date.now() - x.at < 86_400_000).reduce((a, x) => a + x.usd, 0).toFixed(2);
      if (v.address) { try { v.eth = ethers.formatEther(await provider.getBalance(v.address)); } catch {} }
      try { v.ethUsd = await ethUsd(); } catch {}
      v.burned = await burned();
      return v;
    },
    async setKey(raw) {
      await load();
      const k = String(raw || "").trim();
      if (!k) { saved = null; await save(KEY_FILE, null); return; }
      let w; try { w = new ethers.Wallet(k.startsWith("0x") ? k : "0x" + k); } catch { throw err(400, "That is not a valid private key."); }
      saved = { address: w.address, key: seal(w.privateKey), at: Date.now() }; await save(KEY_FILE, saved);
    },
    async run(usdIn) {
      await load();
      const usd = Number(usdIn);
      if (!(usd > 0)) throw err(400, "Enter an amount in dollars.");
      if (usd > maxUsd()) throw err(400, `One burn is capped at $${maxUsd()} (BURN_MAX_USD).`);
      const today = log.filter((x) => Date.now() - x.at < 86_400_000).reduce((a, x) => a + x.usd, 0);
      if (today + usd > dayUsd()) throw err(400, `Daily cap is $${dayUsd()}; $${today.toFixed(2)} already burned in the last 24 h.`);
      if (!saved) throw err(400, "Save the burn wallet key first.");
      const t = token(); if (!t) throw err(400, "Set the $GYRE contract address first.");
      if (busy) throw err(409, "A burn is already running.");
      busy = true;
      try {
        const wallet = new ethers.Wallet(unseal(saved.key), provider);
        const fac = new ethers.Contract(ADDR.factory, ABI.factory, provider);
        const rec = await fac.getLaunchedToken(t);
        if (!rec.exists) throw err(400, "That address is not a Pons token.");
        if (BigInt(rec.pairToken) !== 0n) throw err(400, "The token does not trade against ETH on its curve.");
        const curve = new ethers.Contract(rec.curve, ABI.curve, wallet);
        if (await curve.graduated()) throw err(400, "The token has graduated to the DEX; curve buybacks are closed.");
        if ((await curve.currentSnipeTaxBps(ADDR.dead)) > 0n) throw err(400, "Snipe tax is still on. Try again in a few minutes.");
        const price = await ethUsd(); if (!price) throw err(503, "Could not read the ETH price. Try again.");
        const wei = ethers.parseEther((usd / price).toFixed(18));
        const bal = await provider.getBalance(wallet.address);
        if (bal < wei + ethers.parseEther("0.0003")) throw err(400, `The burn wallet has ${ethers.formatEther(bal)} ETH; it needs ${ethers.formatEther(wei)} ETH plus gas.`);
        const erc = new ethers.Contract(t, ERC20, provider), before = await erc.balanceOf(ADDR.dead);
        const quote = await curve.buy.staticCall(wei, 0n, ADDR.dead, { value: wei });
        const tx = await curve.buy(wei, (quote * 97n) / 100n, ADDR.dead, { value: wei });
        const rc = await tx.wait();
        if (rc.status !== 1) throw err(502, "The buy reverted.");
        const got = (await erc.balanceOf(ADDR.dead)) - before;
        const entry = { at: Date.now(), usd, eth: ethers.formatEther(wei), ethUsd: price, tokens: ethers.formatUnits(got > 0n ? got : quote, 18), tx: tx.hash };
        log.push(entry); await save(LOG_FILE, log);
        return entry;
      } finally { busy = false; }
    },
  };
}
