// GYRE server: the current-reading trading terminal for Solana and Robinhood Chain. Discover feeds and signals from
// DexScreener plus the chains themselves, an evidence-based scam check and a graded forecast from the analyst,
// non-custodial swap building, wallet tiers for $GYRE, a public track record, the studio and the agent API.
// Secrets live in server/.env and never reach the browser.
import "dotenv/config";
import express from "express";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { Store } from "./lib/store.js";
import { createAccess, keyMatches } from "./lib/access.js";
import { createFacilitator } from "./lib/x402.js";
import * as dex from "./lib/dex.js";
import * as RH from "./lib/rh.js";
import * as SOL from "./lib/sol.js";
import * as swap from "./lib/swap.js";
import * as ai from "./lib/ai.js";
import * as P from "./lib/pons.js";
import { createSignals } from "./lib/signals.js";
import { createBurn } from "./lib/burn.js";
import { createBuy } from "./lib/buy.js";
import { createRecord } from "./lib/record.js";
import { createScan } from "./lib/scan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, "..", "site"), DATA = path.join(here, "data");
const PORT = Number(process.env.PORT || 5520);
const STUDIO_KEY = process.env.STUDIO_KEY || "";
const LINKS = { site: "https://gyre.trade", x: "", xHandle: "" };   // X handle not chosen yet: the site hides X links while these are empty
const SETTINGS_DEFAULT = {
  token: "",                                      // $GYRE contract address on Robinhood Chain (Pons), set from the studio
  tiers: { holderBps: 10, plusBps: 50 },          // 0.1% / 0.5% of supply
  quotas: { freePerDay: 6, holderPerDay: 60, plusPerDay: 300 }, // analyst calls (scan, forecast, ask, brief) per identity per day
  gate: { aiNeedsWallet: true },                  // scam check and forecast need a connected wallet (and the Holder tier once the CA is set)
  banner: { text: "", link: "", on: false },
  treasury: "", proPriceUsd: 0.01,                // paid agent endpoint: price per scan, paid in USDG/USDC/$GYRE via x402
  modules: { swap: true, forecast: true, scan: true, ask: true },
};
const settings = new Store(DATA, "settings.json", SETTINGS_DEFAULT); await settings.load();
const usage = new Store(DATA, "usage.json", { days: {} }); await usage.load();
const watch = new Store(DATA, "watch.json", { lists: {} }); await watch.load();
const access = createAccess({ dir: DATA, settings });
const fac = createFacilitator({ dir: DATA, settings });
const record = createRecord({ dir: DATA, dex }); await record.load(); record.start();
let signals = null;
const universe = dex.createUniverse({ seeds: async () => { const L = await RH.recentLaunches(120_000); const out = []; for (const l of L.slice(0, 40)) { try { const ps = await dex.tokenPairs("robinhood", l.token); if (ps.length) out.push(...ps); else { const c = await RH.curvePair(l.token, signals?.curveStats(l.curve)); if (c && !c.graduated) out.push(c); } } catch {} } return out; } });
signals = createSignals({ universe, record }); signals.start(); universe.start(30_000);
// one resolver for every route: the universe, then DexScreener, then (Robinhood) the Pons curve itself
// $GYRE itself: a synthetic curve pair built from the buy module's cached curve state, so the terminal for the CA never
// depends on the log scan or a rate-limited RPC. Seeded into the universe at start and refreshed every minute.
const tokenPair = async (ms = 3000) => {
  const t = settings.data.token; if (!t) return null;
  let v; try { v = await P.deadline(buy.view(), ms); } catch { return null; } if (!v?.token || !v.curve) return null;
  const st = signals.curveStats(v.curve), usd = v.ethUsd || null, w = (x) => ({ buys: x.buys, sells: x.sells }), vol = (x) => (usd ? x.eth * usd : 0);
  return { chain: "robinhood", pair: t.toLowerCase(), dex: "pons", labels: ["curve", v.graduated ? "graduated" : "bonding"], url: v.pons, base: { address: t, name: v.name, symbol: v.symbol }, quote: { address: null, symbol: "ETH" },
    priceUsd: v.priceUsd ?? null, priceNative: v.priceEth ?? null, change: { m5: null, h1: null, h6: null, h24: null }, txns: { m5: w(st.m5), h1: w(st.h1), h6: w(st.h1), h24: w(st.h1) }, vol: { m5: vol(st.m5), h1: vol(st.h1), h6: vol(st.h1), h24: vol(st.h1) },
    liq: usd ? Number(v.quoteReserve) * usd : null, fdv: v.priceUsd && v.supply ? v.priceUsd * Number(v.supply) : null, mcap: null, createdAt: null, image: null, header: null, websites: [], socials: [], boosts: 0, curve: v.curve, graduated: v.graduated, synthetic: true };
};
const isToken = (chain, pair) => chain === "robinhood" && !!settings.data.token && pair.toLowerCase() === settings.data.token.toLowerCase();
setTimeout(async () => { try { const p = await tokenPair(20_000); if (p) universe.add(p, "token"); } catch {} }, 4000);
setInterval(async () => { try { const p = await tokenPair(10_000); if (p) universe.add(p, "token"); } catch {} }, 60_000).unref();
const pairView = async (chain, pair) => {
  // the universe keys Robinhood pairs lowercase; a checksummed address from the CA bar must still hit the cache
  const u = universe.get(chain, pair) || (chain === "robinhood" ? universe.get(chain, pair.toLowerCase()) : null) || (isToken(chain, pair) ? await tokenPair() : null);
  if (u && !u.synthetic) return u;
  let p = await dex.pair(chain, pair).catch(() => null);
  if (!p) p = (await dex.tokenPairs(chain, pair).catch(() => []))[0] || null;
  // curve-only tokens: read the Pons curve, but never hang on a rate-limited RPC; fall back to the cached synthetic pair
  if (!p && chain === "robinhood" && P.isAddr(pair)) {
    const fresh = (async () => { const rec = await P.withRetry(() => P.launched(pair)); return rec ? RH.curvePair(pair, signals.curveStats(rec.curve)) : null; })();
    // with a cached curve pair, answer from the cache within 1.5 s and let the refresh land in the universe in the background
    if (u) { fresh.then((np) => { if (np) universe.add(np, "visit"); }).catch(() => {}); try { p = await Promise.race([fresh, new Promise((r) => setTimeout(() => r(null), 1500))]); } catch { p = null; } }
    else { try { p = await P.deadline(fresh, 25_000); } catch { p = null; } }
  }
  return p || u || null;
};
const scan = createScan({ record, signals, resolve: pairView });

const app = express(); app.disable("x-powered-by"); app.set("trust proxy", "loopback"); app.use(express.json({ limit: "256kb" }));
// ---------- helpers ----------
const cookies = (req) => Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=").map((x) => { try { return decodeURIComponent(x); } catch { return x; } })).filter((c) => c[0]));
const sidOf = (req) => cookies(req).gyre_session || "";
const anonOf = (req, res) => { let a = cookies(req).gyre_anon; if (!/^[0-9a-f]{24}$/.test(a || "")) { a = randomBytes(12).toString("hex"); res.append("Set-Cookie", `gyre_anon=${a}; Path=/; Max-Age=${86400 * 180}; SameSite=Lax; HttpOnly${req.secure ? "; Secure" : ""}`); } return a; };
const meOf = async (req) => { const code = req.headers["x-gyre-code"]; if (!code) return access.me(sidOf(req)); try { const c = await access.checkCode(code, req.headers["x-gyre-device"]); return { wallet: c.wallet, short: c.wallet.startsWith("owner:") ? c.wallet : P.short(c.wallet), tier: c.tier, open: false, cli: true }; } catch { return { wallet: null, tier: "free", open: !settings.data.token }; } };
const ownerOf = async (req, res) => { const me = await meOf(req); return { me, key: me.wallet || "anon:" + anonOf(req, res) }; };
const fail = (res, e) => { const code = typeof e?.code === "number" && e.code >= 400 && e.code < 600 ? e.code : 500; res.status(code).json({ error: code === 500 ? "Something broke on our side." : e.message }); if (code === 500) console.error(e); };
const isStudio = (req) => keyMatches(req.headers["x-studio-key"], STUDIO_KEY);
const sse = (res) => { res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" }); res.write(":ok\n\n"); return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
const day = () => new Date().toISOString().slice(0, 10);
function take(key, kind, max) { const d = (usage.data.days[day()] ||= {}); const k = `${kind}|${key}`; const n = d[k] || 0; if (n >= max) return false; d[k] = n + 1; for (const old of Object.keys(usage.data.days)) if (old < day()) delete usage.data.days[old]; usage.save(); return true; }
const quotaFor = (me) => { const q = settings.data.quotas; return me.tier === "plus" || me.tier === "owner" ? q.plusPerDay : me.tier === "holder" ? q.holderPerDay : q.freePerDay; };
const usedToday = (key) => (usage.data.days[day()] || {})[`analyst|${key}`] || 0;
const chainOk = (c) => dex.supported(c);
const validPair = (chain, pair) => chain === "solana" ? SOL.isMint(pair) : /^0x[0-9a-fA-F]{40,64}$/.test(pair);
// Analyst gate: key present, module on, wallet rule, tier rule, quota.
async function analystGate(req, res, { needWallet = settings.data.gate.aiNeedsWallet } = {}) {
  if (!ai.ready()) { res.status(503).json({ error: "The analyst is not configured on this server yet." }); return null; }
  const { me, key } = await ownerOf(req, res);
  if (needWallet && !me.wallet) { res.status(401).json({ error: "wallet_required", message: "Connect a wallet to use the analyst. One signature, no transaction." }); return null; }
  if (needWallet && settings.data.token && !me.open && !access.allows(me, "holder")) { res.status(403).json({ error: "tier_required", message: `This wallet holds ${Number(me.have || 0).toLocaleString("en-US")} $GYRE. The analyst needs the Holder tier (${Number(me.needHolder || 0).toLocaleString("en-US")} $GYRE).` }); return null; }
  const max = quotaFor(me); if (!take(key, "analyst", max)) { res.status(429).json({ error: "quota", message: me.wallet ? `Daily limit reached (${max} analyst calls). Resets at 00:00 UTC.` : `${max} analyst calls a day without a wallet. Connect one for more.` }); return null; }
  return me;
}
const siteStats = () => ({ universe: universe.size(), signals: signals.stats(), record: record.stats(), dex: dex.stats() });

// ---------- public ----------
const burn = createBurn({ dir: DATA, token: () => settings.data.token });
const buy = createBuy({ token: () => settings.data.token });
swap.setTokenView(() => buy.view());
app.get("/api/token", async (req, res) => { try { res.json(await buy.view()); } catch (e) { fail(res, e); } });
app.get("/api/token/quote", async (req, res) => { try { res.json(await buy.quote({ eth: req.query.eth, from: req.query.from })); } catch (e) { fail(res, e); } });
app.get("/api/health", (req, res) => res.json({ ok: true, ai: ai.ready(), model: "GYRE", ...universe.size(), signalsLastHour: signals.stats().lastHour }));
app.get("/api/site", async (req, res) => res.json({ burns: await burn.publicView(), proPriceUsd: settings.data.proPriceUsd, links: LINKS, token: settings.data.token || null, symbol: "GYRE", tiers: settings.data.tiers, quotas: settings.data.quotas, gate: settings.data.gate, modules: settings.data.modules, banner: settings.data.banner, chains: dex.CHAINS, stats: siteStats(), ai: ai.ready(), pons: settings.data.token ? `https://ponsfamily.com/launchpad/${settings.data.token}` : null }));
app.get("/api/discover", (req, res) => {
  const chain = String(req.query.chain || ""); const tab = String(req.query.tab || "trending"); const minLiq = Math.max(0, Number(req.query.minLiq) || 0); const q = String(req.query.q || "").slice(0, 80); const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 50)); const page = Math.max(1, Number(req.query.page) || 1);
  const list = chain && chainOk(chain) ? universe.list(chain) : [...universe.list("solana"), ...universe.list("robinhood")];
  let L = dex.feeds(list, { tab, minLiq, q });
  if (req.query.maxAgeMin) L = L.filter((p) => p.createdAt && Date.now() - p.createdAt < Number(req.query.maxAgeMin) * 60_000);
  if (req.query.minVolH1) L = L.filter((p) => (p.vol.h1 || 0) >= Number(req.query.minVolH1));
  if (req.query.minBuyShare) L = L.filter((p) => (dex.pressure(p) ?? 0) >= Number(req.query.minBuyShare));
  const total = L.length; L = L.slice((page - 1) * limit, page * limit).map((p) => ({ ...p, buyShare: dex.pressure(p), verdict: record.latestVerdict(p.chain, p.pair) ? { score: record.latestVerdict(p.chain, p.pair).score, verdict: record.latestVerdict(p.chain, p.pair).verdict } : null }));
  res.json({ pairs: L, total, page, pages: Math.max(1, Math.ceil(total / limit)), tab, chain: chain || null, universe: universe.size() });
});
app.get("/api/search", async (req, res) => { const q = String(req.query.q || "").trim().slice(0, 80); if (!q) return res.json({ pairs: [] }); const local = dex.feeds([...universe.list("solana"), ...universe.list("robinhood")], { q }).slice(0, 10); let remote = []; if (local.length < 5) { try { remote = (await dex.search(q)).slice(0, 15); for (const p of remote) universe.add(p, "search"); } catch {} } const seen = new Set(); res.json({ pairs: [...local, ...remote].filter((p) => !seen.has(dex.key(p)) && seen.add(dex.key(p))).slice(0, 15) }); });
app.get("/api/pair/:chain/:pair", async (req, res) => { const { chain, pair } = req.params; if (!chainOk(chain) || !validPair(chain, pair)) return res.status(400).json({ error: "Bad chain or pair address." }); try { const p = await pairView(chain, pair); if (!p) return res.status(404).json({ error: `No trading pair at that address on ${dex.CHAINS[chain].name}.` }); universe.add(p, "visit"); res.json({ pair: { ...p, buyShare: dex.pressure(p), buyShareH1: dex.pressure(p, "h1") }, signals: signals.forPair(chain, p.pair), verdict: record.latestVerdict(chain, p.pair), forecast: record.latestForecast(chain, p.pair), chain: dex.CHAINS[chain] }); } catch (e) { fail(res, e); } });
app.get("/api/alerts", (req, res) => res.json({ alerts: signals.recent({ chain: chainOk(String(req.query.chain)) ? String(req.query.chain) : null, kinds: req.query.kinds ? String(req.query.kinds).split(",") : null, limit: Math.min(200, Number(req.query.limit) || 60) }) }));
app.get("/api/stream", (req, res) => { const send = sse(res); const chain = chainOk(String(req.query.chain)) ? String(req.query.chain) : null; const off = signals.subscribe((a) => { if (!chain || a.chain === chain) send("alert", a); }); const hb = setInterval(() => res.write(":hb\n\n"), 20_000); req.on("close", () => { off(); clearInterval(hb); }); });
app.get("/api/record", (req, res) => res.json({ stats: record.stats(), ...record.recent(40) }));

// ---------- the analyst ----------
app.get("/api/pair/:chain/:pair/brief", async (req, res) => { const { chain, pair } = req.params; if (!chainOk(chain) || !validPair(chain, pair)) return res.status(400).json({ error: "Bad pair." }); if (!(await analystGate(req, res, { needWallet: false }))) return; const send = sse(res); try { const p = await pairView(chain, pair); if (!p) { send("error", { message: "Pair not found." }); return res.end(); } for await (const d of ai.brief({ pair: { chain, symbol: p.base.symbol, dex: p.dex, priceUsd: p.priceUsd, liqUsd: p.liq, vol: p.vol, txns: p.txns, change: p.change, ageMinutes: p.createdAt ? Math.round((Date.now() - p.createdAt) / 60_000) : null, buyShare5m: dex.pressure(p) }, signals: signals.forPair(chain, p.pair, 6).map((a) => a.title) })) send("delta", d); send("done", {}); } catch (e) { send("error", { message: ai.describeError(e) }); } res.end(); });
app.get("/api/scan/:chain/:pair", async (req, res) => { const { chain, pair } = req.params; if (!chainOk(chain) || !validPair(chain, pair)) return res.status(400).json({ error: "Bad pair." }); if (settings.data.modules.scan === false) return res.status(404).json({ error: "The scam check is off right now." }); if (!(await analystGate(req, res))) return; const send = sse(res); try { for await (const [ev, data] of scan.run(chain, pair)) send(ev, data); } catch (e) { send("error", { message: e.message }); } send("done", {}); res.end(); });
app.post("/api/forecast/:chain/:pair", async (req, res) => { const { chain, pair } = req.params; if (!chainOk(chain) || !validPair(chain, pair)) return res.status(400).json({ error: "Bad pair." }); if (settings.data.modules.forecast === false) return res.status(404).json({ error: "Forecasts are off right now." }); const horizon = ["1h", "4h", "24h"].includes(req.body?.horizon) ? req.body.horizon : "4h"; try { const p = await pairView(chain, pair); if (!p) return res.status(404).json({ error: "Pair not found." }); const last = record.latestForecast(chain, p.pair); if (last && !last.resolvedAt && last.horizon === horizon && Date.now() - last.at < 30 * 60_000) return res.json({ forecast: last, cached: true }); if (!(await analystGate(req, res))) return; const facts = { horizon, pair: { chain, symbol: p.base.symbol, dex: p.dex, priceUsd: p.priceUsd, liqUsd: p.liq, fdv: p.fdv, vol: p.vol, txns: p.txns, change: p.change, ageMinutes: p.createdAt ? Math.round((Date.now() - p.createdAt) / 60_000) : null, buyShare5m: dex.pressure(p), buyShare1h: dex.pressure(p, "h1"), boosts: p.boosts }, signals: signals.forPair(chain, p.pair, 10).map((a) => ({ kind: a.kind, title: a.title, minutesAgo: Math.round((Date.now() - a.at) / 60_000) })), lastVerdict: record.latestVerdict(chain, p.pair) ? { score: record.latestVerdict(chain, p.pair).score, verdict: record.latestVerdict(chain, p.pair).verdict } : null }; const f = await ai.forecast(facts); const saved = await record.forecast({ chain, pair: p.pair, symbol: p.base.symbol, horizon, direction: f.direction, rangePct: f.rangePct, confidence: f.confidence, drivers: f.drivers, invalidation: f.invalidation, summary: f.summary, priceAtStart: p.priceUsd }); res.json({ forecast: saved }); } catch (e) { if (e?.status) return res.status(502).json({ error: ai.describeError(e) }); fail(res, e); } });
app.post("/api/chat", async (req, res) => {
  if (!ai.ready()) return res.status(503).json({ error: "The assistant is not configured on this server yet." });
  const raw = Array.isArray(req.body?.messages) ? req.body.messages : []; const msgs = raw.slice(-12).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 1200) })).filter((m) => m.content);
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.status(400).json({ error: "Say something first." });
  const { me, key } = await ownerOf(req, res); const max = Number(process.env.GYRE_CHAT_PER_DAY || 60);
  if (!take(key, "chat", max)) return res.status(429).json({ error: "quota", message: `The assistant answers ${max} messages a day per visitor. Back tomorrow.` });
  const st = siteStats(); const page = String(req.body?.page || "").slice(0, 200);
  const facts = { page, visitor: { wallet: me.wallet ? me.short : null, tier: me.tier, open: me.open }, token: settings.data.token || "not launched yet", tiers: settings.data.tiers, quotas: settings.data.quotas, gate: settings.data.gate, modules: settings.data.modules, stats: { pairs: st.universe, signalsLastHour: st.signals.lastHour, record: st.record }, latestAlerts: signals.recent({ limit: 5 }).map((x) => `${x.title}: ${x.symbol} · ${x.detail}`), links: LINKS, utc: new Date().toISOString() };
  const send = sse(res); try { for await (const d of ai.chat(msgs, facts)) send("delta", d); send("done", {}); } catch (e) { send("error", { message: ai.describeError(e) }); } res.end();
});
app.post("/api/ask", async (req, res) => { if (settings.data.modules.ask === false) return res.status(404).json({ error: "Ask is off right now." }); const q = String(req.body?.q || "").trim().slice(0, 400); if (!q) return res.status(400).json({ error: "Ask something." }); if (!(await analystGate(req, res, { needWallet: false }))) return; try { const f = await ai.askFilters(q, Object.keys(dex.CHAINS)); const list = f.chain ? universe.list(f.chain) : [...universe.list("solana"), ...universe.list("robinhood")]; let L = dex.feeds(list, { tab: f.tab, minLiq: f.minLiq, q: f.q || "" }); if (f.maxAgeMin) L = L.filter((p) => p.createdAt && Date.now() - p.createdAt < f.maxAgeMin * 60_000); if (f.minVolH1) L = L.filter((p) => (p.vol.h1 || 0) >= f.minVolH1); if (f.minBuyShare) L = L.filter((p) => (dex.pressure(p) ?? 0) >= f.minBuyShare); res.json({ filters: f, pairs: L.slice(0, f.limit).map((p) => ({ ...p, buyShare: dex.pressure(p) })), total: L.length, note: f.renouncedOnly ? "Authority and ownership are checked per pair in the scam check; the list is not pre-filtered on them." : null }); } catch (e) { if (e?.status) return res.status(502).json({ error: ai.describeError(e) }); fail(res, e); } });

// ---------- swaps (build only; the wallet signs) ----------
app.get("/api/swap/sol/quote", async (req, res) => { if (settings.data.modules.swap === false) return res.status(404).json({ error: "Swaps are off." }); try { res.json(await swap.solQuote({ inputMint: String(req.query.inputMint || swap.WSOL), outputMint: String(req.query.outputMint || ""), amount: String(req.query.amount || "0"), slippageBps: req.query.slippageBps })); } catch (e) { fail(res, e); } });
app.post("/api/swap/sol/build", async (req, res) => { try { res.json(await swap.solBuild({ quote: req.body?.quote, owner: String(req.body?.owner || "") })); } catch (e) { fail(res, e); } });
app.get("/api/swap/sol/status", async (req, res) => { try { res.json(await swap.solStatus(String(req.query.sig || ""))); } catch (e) { fail(res, e); } });
app.get("/api/swap/rh/quote", async (req, res) => { if (settings.data.modules.swap === false) return res.status(404).json({ error: "Swaps are off." }); try { const token = String(req.query.token || ""); if (!P.isAddr(token)) return res.status(400).json({ error: "Bad token address." }); res.json(await swap.rhQuote({ token, side: req.query.side === "sell" ? "sell" : "buy", amount: String(req.query.amount || "0"), owner: P.isAddr(String(req.query.owner || "")) ? ethers.getAddress(String(req.query.owner)) : null })); } catch (e) { fail(res, e); } });
app.get("/api/swap/rh/status", async (req, res) => { try { res.json(await swap.rhStatus(String(req.query.hash || ""))); } catch (e) { fail(res, e); } });

// ---------- watchlist (server side, per wallet or anon cookie) ----------
app.get("/api/watch", async (req, res) => { const { key } = await ownerOf(req, res); const ids = watch.data.lists[key] || []; const pairs = []; for (const id of ids) { const [chain, pair] = id.split(":"); const p = universe.get(chain, pair) || (await dex.pair(chain, pair).catch(() => null)); if (p) pairs.push({ ...p, buyShare: dex.pressure(p) }); } res.json({ ids, pairs }); });
app.post("/api/watch", async (req, res) => { const { key } = await ownerOf(req, res); const { chain, pair, action } = req.body || {}; if (!chainOk(chain) || !validPair(chain, String(pair || ""))) return res.status(400).json({ error: "Bad pair." }); const id = `${chain}:${pair}`; const L = (watch.data.lists[key] ||= []); if (action === "remove") watch.data.lists[key] = L.filter((x) => x !== id); else if (!L.includes(id)) { if (L.length >= 60) return res.status(400).json({ error: "Watchlist is full (60)." }); L.push(id); } watch.save(); res.json({ ids: watch.data.lists[key] }); });

// ---------- access ----------
app.get("/api/access/info", (req, res) => res.json(access.info()));
app.get("/api/access/me", async (req, res) => { const { me, key } = await ownerOf(req, res); res.json({ ...me, quota: quotaFor(me), used: usedToday(key), gate: settings.data.gate }); });
app.post("/api/access/challenge", (req, res) => { try { res.json({ message: access.challenge(req.body?.wallet) }); } catch (e) { fail(res, e); } });
app.post("/api/access/signin", async (req, res) => { try { const r = await access.signIn(req.body || {}); res.append("Set-Cookie", `gyre_session=${r.sid}; Path=/; Max-Age=${86400 * 60}; SameSite=Lax; HttpOnly${req.secure ? "; Secure" : ""}`); const { sid, ...me } = r; res.json({ ...me, quota: quotaFor(me) }); } catch (e) { fail(res, e); } });
app.post("/api/access/signout", async (req, res) => { await access.signOut(sidOf(req)); res.append("Set-Cookie", "gyre_session=; Path=/; Max-Age=0"); res.json({ ok: true }); });
app.post("/api/access/code", async (req, res) => { try { res.json(await access.claimCode(sidOf(req))); } catch (e) { fail(res, e); } });

// ---------- agent API v1 (free reads) + paid scan through x402 ----------
app.get("/api/v1/discover", (req, res) => { const chain = chainOk(String(req.query.chain)) ? String(req.query.chain) : null; const L = dex.feeds(chain ? universe.list(chain) : [...universe.list("solana"), ...universe.list("robinhood")], { tab: String(req.query.tab || "trending"), minLiq: Number(req.query.minLiq) || 0 }).slice(0, Math.min(100, Number(req.query.limit) || 25)); res.json({ data: L, source: "dexscreener + chain reads", at: new Date().toISOString() }); });
app.get("/api/v1/alerts", (req, res) => res.json({ data: signals.recent({ chain: chainOk(String(req.query.chain)) ? String(req.query.chain) : null, limit: 100 }) }));
app.get("/api/v1/record", (req, res) => res.json({ data: record.stats() }));
app.get("/api/v1/pro/scan/:chain/:pair", async (req, res) => {
  res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "Content-Type, Accept, PAYMENT-SIGNATURE, X-PAYMENT"); res.setHeader("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
  const { chain, pair } = req.params; if (!chainOk(chain) || !validPair(chain, pair)) return res.status(400).json({ error: "Bad pair." });
  const treasury = settings.data.treasury; if (!treasury) return res.status(503).json({ error: "paid_tier_unavailable", message: "The paid scan is not switched on yet: no treasury wallet is set in the studio." });
  if (!ai.ready()) return res.status(503).json({ error: "analyst_unavailable" });
  const resource = `${req.protocol}://${req.get("host")}/api/v1/pro/scan/${chain}/${pair}`; const acc = await fac.accepts({ priceUsd: settings.data.proPriceUsd, payTo: treasury, token: settings.data.token || null });
  if (!acc.length) return res.status(503).json({ error: "paid_tier_unavailable", message: "No relayer wallet on the server yet." });
  const desc = "GYRE scam check: on-chain evidence steps plus the analyst's scored verdict for one pair.";
  const payload = fac.decode(req); if (!payload) return fac.required(res, { accepts: acc, resource, description: desc });
  const v = await fac.verify(payload, acc); if (!v.ok) return fac.required(res, { accepts: acc, resource, description: desc, error: v.error });
  const s = await fac.settle(payload, v.requirement); if (!s.success) return fac.required(res, { accepts: acc, resource, description: desc, error: "Settlement failed: " + (s.errorReason || "unknown") });
  const steps = []; let verdict = null, error = null; for await (const [ev, data] of scan.run(chain, pair)) { if (ev === "step") steps.push(data); else if (ev === "verdict") verdict = data; else if (ev === "error") error = data.message; }
  res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, transaction: s.transaction, network: s.network, payer: s.payer })).toString("base64"));
  res.json({ data: { steps, verdict, error }, paid: { tx: s.transaction, network: s.network } });
});
app.get("/facilitator/supported", (req, res) => res.json(fac.supported()));

// ---------- studio ----------
app.use("/api/studio", (req, res, next) => (isStudio(req) ? next() : res.status(401).json({ error: "Studio key required." })));
const studioState = async () => ({ settings: settings.data, burn: await burn.view(), access: access.stats(), usage: usage.data.days[day()] || {}, stats: siteStats(), pay: await fac.info(), ai: ai.ready(), env: { solanaRpc: !!process.env.SOLANA_RPC } });
app.get("/api/studio/state", async (req, res) => res.json(await studioState()));
app.post("/api/studio/token", async (req, res) => { try { const t = String(req.body?.token || "").trim(); if (t && !ethers.isAddress(t)) return res.status(400).json({ error: "That is not a contract address." }); if (t) { let rec; try { rec = await P.deadline(P.withRetry(() => P.launched(t)), 25_000); } catch (e) { return res.status(503).json({ error: P.rpcMessage(e, "Could not read the Pons factory right now. Try again in a minute.") }); } if (!rec) return res.status(400).json({ error: "That address is not a Pons token on Robinhood Chain." }); } settings.data.token = t ? ethers.getAddress(t) : ""; await settings.save(); res.json(await studioState()); } catch (e) { fail(res, e); } });
app.post("/api/studio/settings", async (req, res) => { try { const b = req.body || {}; if (b.tiers) settings.data.tiers = { holderBps: Math.max(1, Math.min(1000, Number(b.tiers.holderBps) || 10)), plusBps: Math.max(1, Math.min(2000, Number(b.tiers.plusBps) || 50)) }; if (b.quotas) settings.data.quotas = { freePerDay: Math.max(0, Number(b.quotas.freePerDay) || 0), holderPerDay: Math.max(0, Number(b.quotas.holderPerDay) || 0), plusPerDay: Math.max(0, Number(b.quotas.plusPerDay) || 0) }; if (b.gate) settings.data.gate = { aiNeedsWallet: b.gate.aiNeedsWallet !== false }; if (b.banner) settings.data.banner = { text: String(b.banner.text || "").slice(0, 160), link: String(b.banner.link || "").slice(0, 300), on: !!b.banner.on }; if (b.modules) for (const k of Object.keys(settings.data.modules)) if (k in b.modules) settings.data.modules[k] = !!b.modules[k]; if ("treasury" in b) { const t = String(b.treasury || "").trim(); if (t && !ethers.isAddress(t)) return res.status(400).json({ error: "Treasury is not an address." }); settings.data.treasury = t ? ethers.getAddress(t) : ""; } if ("proPriceUsd" in b) settings.data.proPriceUsd = Math.max(0.0001, Math.min(100, Number(b.proPriceUsd) || 0.01)); await settings.save(); res.json(await studioState()); } catch (e) { fail(res, e); } });
app.post("/api/studio/burn", async (req, res) => { try { const b = req.body || {}; if ("privateKey" in b) await burn.setKey(b.privateKey); else if (b.usd !== undefined) { const done = await burn.run(b.usd); return res.json({ ...(await studioState()), done }); } res.json(await studioState()); } catch (e) { if (typeof e.code === "number") return fail(res, e); res.status(502).json({ error: e.shortMessage || e.message || "The burn failed." }); } });
app.post("/api/studio/relayer", async (req, res) => { try { await fac.setRelayerKey(req.body?.privateKey); res.json(await studioState()); } catch (e) { fail(res, e); } });
app.post("/api/studio/code", async (req, res) => { try { res.json(await access.ownerCode(req.body?.label)); } catch (e) { fail(res, e); } });
app.post("/api/studio/draft", async (req, res) => { if (!ai.ready()) return res.status(503).json({ error: "No analyst key." }); const send = sse(res); try { const st = siteStats(); const facts = { ticker: "$GYRE", ca: settings.data.token || "(not launched yet)", site: "gyre.trade", chains: ["Solana", "Robinhood Chain"], pairsTracked: st.universe, signalsLastHour: st.signals.lastHour, record: st.record, topAlerts: signals.recent({ limit: 5 }).map((a) => `${a.title}: ${a.symbol} · ${a.detail}`), extra: String(req.body?.extra || "").slice(0, 400) }; for await (const d of ai.draft(String(req.body?.kind || "post"), facts)) send("delta", d); send("done", {}); } catch (e) { send("error", { message: ai.describeError(e) }); } res.end(); });

// ---------- site ----------
app.use(express.static(SITE, { extensions: ["html"], index: "index.html", maxAge: process.env.NODE_ENV === "production" ? "5m" : 0 }));
for (const [route, file] of [["/discover", "discover.html"], ["/t/:chain/:pair", "terminal.html"], ["/ask", "ask.html"], ["/record", "record.html"], ["/dashboard", "dashboard.html"], ["/docs", "docs.html"], ["/studio", "studio.html"]]) app.get(route, (req, res) => res.sendFile(path.join(SITE, file)));
app.use((req, res) => res.status(404).sendFile(path.join(SITE, "404.html")));
app.listen(PORT, () => { console.log(`GYRE on http://localhost:${PORT}  (discover: /discover · studio: /studio)`); console.log(ai.ready() ? "Analyst: ready" : "Analyst: no ANTHROPIC_API_KEY in server/.env"); });
