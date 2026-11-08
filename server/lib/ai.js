// GYRE's voice. The server gathers facts (chain reads, DexScreener numbers, signals); the model weighs them and
// explains. It never invents a number: every figure it may use is in the prompt, and the system prompt says so.
import Anthropic from "@anthropic-ai/sdk";
const MODEL = process.env.GYRE_MODEL || "claude-opus-5-5";
let client = null; const getClient = () => (client ||= new Anthropic());
export const ready = () => Boolean(process.env.ANTHROPIC_API_KEY);
const VOICE = `You are GYRE, the current-reading analyst of a multi-chain trading terminal (Solana and Robinhood Chain). You read on-chain evidence and market flow for one pair at a time.
Rules you never break:
- Use only the facts given in the message. Never invent an address, a holder percentage, a price, a volume or an event. If a fact is missing, say it is missing and treat it as unknown, not as safe.
- You are a verdict engine, not a cheerleader. Say what the evidence shows, what it does not show, and what would change your mind.
- No financial advice, no "buy" or "sell" instructions, no hype, no emojis. Short, concrete sentences. First person is fine.
- You are GYRE and nothing else. Never mention the model, company or technology behind you.
- Answer in the language the user writes in; default to English.
- When asked for JSON, answer with JSON only: no prose before or after, no markdown fences.`;
function stream(params) { return getClient().beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }); }
async function text(params) { const s = stream(params); let out = ""; for await (const ev of s) if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") out += ev.delta.text; const f = await s.finalMessage(); if (f.stop_reason === "refusal") throw Object.assign(new Error("GYRE declined to answer that."), { code: 400 }); return out; }
const json = (s) => { const m = String(s).match(/\{[\s\S]*\}/); if (!m) throw new Error("No JSON in the answer."); return JSON.parse(m[0]); };
export const describeError = (e) => (e?.status === 429 ? "GYRE is busy right now. Try again in a minute." : e?.status === 401 ? "The analyst is not configured on this server." : e?.code === 400 ? e.message : "The analyst could not answer. Try again.");

// Evidence → verdict. facts: { chain, pair, token, market, authorities/ownership, holders, launcher, signals }
export async function verdict(facts) {
  const out = await text({ model: MODEL, max_tokens: 1800, output_config: { effort: "low" }, system: VOICE, messages: [{ role: "user", content: `Weigh this evidence about one token and give a scam/risk verdict.
Scoring: 0 = every check is clean and the market data is healthy, 100 = multiple hard red flags (live mint or freeze authority with concentrated holders, owner with upgradeable proxy, liquidity pulled, launcher with a trail of dead launches). Missing facts raise uncertainty, not safety.
Classes: "clear" (score ≤ 25), "caution" (26–60), "danger" (> 60).
Answer with JSON only: {"score": number, "verdict": "clear"|"caution"|"danger", "confidence": "low"|"medium"|"high", "summary": "two or three sentences, plain", "flags": [{"label": "short", "severity": "info"|"mid"|"high", "evidence": "the fact in plain words with its number, never raw JSON or field names"}], "clean": ["checks that came back clean, short"], "changeMind": "one sentence: what evidence would move the score most", "missing": ["facts that were not available"]}
Facts:
${JSON.stringify(facts)}` }] });
  const j = json(out); j.score = Math.max(0, Math.min(100, Math.round(Number(j.score) || 0))); j.verdict = j.score <= 25 ? "clear" : j.score <= 60 ? "caution" : "danger"; j.flags = Array.isArray(j.flags) ? j.flags.slice(0, 8) : []; j.clean = Array.isArray(j.clean) ? j.clean.slice(0, 8) : []; j.missing = Array.isArray(j.missing) ? j.missing.slice(0, 6) : []; return j;
}
// Market snapshot + signals → a scored forecast with an explicit invalidation. Logged and graded later.
export async function forecast(facts) {
  const out = await text({ model: MODEL, max_tokens: 1200, output_config: { effort: "low" }, system: VOICE, messages: [{ role: "user", content: `Give a ${facts.horizon} forecast for this pair from the flow data only. This forecast is recorded publicly and graded against the real price later, so be calibrated: when the data is thin, say "flat" with low confidence and a wide range.
Answer with JSON only: {"direction": "up"|"down"|"flat", "rangePct": [low, high] (expected % change bounds over the horizon, e.g. [-15, 25]), "confidence": "low"|"medium"|"high", "drivers": ["two to four short facts from the data that drive the call"], "invalidation": "one sentence: what would prove this wrong early", "summary": "two sentences, plain"}
Facts:
${JSON.stringify(facts)}` }] });
  const j = json(out); j.direction = ["up", "down", "flat"].includes(j.direction) ? j.direction : "flat"; j.rangePct = Array.isArray(j.rangePct) && j.rangePct.length === 2 ? j.rangePct.map((x) => +Number(x).toFixed(1)) : [-10, 10]; j.drivers = Array.isArray(j.drivers) ? j.drivers.slice(0, 4) : []; return j;
}
// Natural language → discover filters.
export async function askFilters(q, chains) {
  const out = await text({ model: MODEL, max_tokens: 500, output_config: { effort: "low" }, system: VOICE, messages: [{ role: "user", content: `Turn this request into discover filters. Chains available: ${chains.join(", ")}. Tabs: trending, new, gainers, volume, curve. Fields: chain (or null for all), tab, minLiq (USD), maxAgeMin (minutes since pair creation, or null), minVolH1 (USD or null), minBuyShare (0..1 share of buys in the 5m window, or null), renouncedOnly (true if the user asks for no mint/freeze authority or renounced ownership), q (a symbol/name/address to search, or null), limit (≤ 50).
Request: "${String(q).slice(0, 400)}"
Answer with JSON only, plus "reading": one sentence restating what you will show.` }] });
  const j = json(out); return { chain: chains.includes(j.chain) ? j.chain : null, tab: ["trending", "new", "gainers", "volume", "curve"].includes(j.tab) ? j.tab : "trending", minLiq: Math.max(0, Number(j.minLiq) || 0), maxAgeMin: j.maxAgeMin ? Number(j.maxAgeMin) : null, minVolH1: j.minVolH1 ? Number(j.minVolH1) : null, minBuyShare: j.minBuyShare ? Math.min(1, Number(j.minBuyShare)) : null, renouncedOnly: !!j.renouncedOnly, q: j.q ? String(j.q).slice(0, 60) : null, limit: Math.min(50, Math.max(5, Number(j.limit) || 25)), reading: String(j.reading || "").slice(0, 200) };
}
// Two-sentence read of a pair for the terminal header, streamed.
export async function* brief(facts) {
  const s = stream({ model: MODEL, max_tokens: 400, output_config: { effort: "low" }, system: VOICE, messages: [{ role: "user", content: `In two or three plain sentences, read this pair for a trader: what the flow shows right now (buys vs sells, volume vs liquidity, age) and the one thing to check before touching it. Plain text, no list.\n${JSON.stringify(facts)}` }] });
  for await (const ev of s) if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
}
// Studio: draft a post from live facts.
export async function* draft(kind, facts) {
  const s = stream({ model: MODEL, max_tokens: 900, output_config: { effort: "low" }, system: VOICE, messages: [{ role: "user", content: `Write a ${kind} for GYRE's X account from these live facts only, in English, under 260 characters unless kind is "thread" (then 4 to 6 posts separated by a blank line). Plain text, no hashtags, no emojis.\n${JSON.stringify(facts)}` }] });
  for await (const ev of s) if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
}

// Site assistant: answers questions about GYRE and the market from the live facts handed to it, in the visitor's language.
const GUIDE = `You are GYRE's assistant on gyre.trade. Keep the GYRE voice: calm, concrete, short. Help visitors use the terminal and understand what they see.
What the site does, page by page:
- /discover: feeds (Trending, New pairs, Gainers 1h, Volume, Curve) for Solana and Robinhood Chain, re-read every 30 seconds from DexScreener and the chain; a live signal column (whale buys and sells on Pons curves with wallet and hash, buy and sell surges, liquidity moves, pumps and dumps, new pairs, boosts).
- /t/<chain>/<pair>: one pair: chart, a short brief, the scam check (market snapshot, mint and freeze authority or ownership and proxy slots, holder concentration with pools separated from wallets, launcher or deployer history, recent signals, then a verdict with a 0 to 100 score; each fact carries its explorer link), a forecast (direction, range, confidence, graded in public when its horizon ends), watchlist, and swaps (Jupiter on Solana, the Pons curve on Robinhood Chain) signed by the visitor's own wallet. GYRE never holds funds.
- /ask: a plain-language question becomes a visible filter over the live universe.
- /record: every forecast with its grade and every verdict, nothing can be edited or deleted.
- /dashboard: watchlist, wallet tier, $GYRE contract when live, the buyback and burn log.
- /docs: the free agent API (/api/v1/discover, /alerts, /record) and the paid scan through x402.
Access: scam check and forecast need a connected wallet (one signature, no transaction). Free, Holder and Holder+ tiers have daily analyst quotas; tiers are read from the $GYRE balance on Robinhood Chain once the token is live. Until the contract is set, every tier is open.
Rules: use only the facts in this conversation; never invent prices, addresses, percentages or events; never give buy or sell instructions or price targets; if asked whether a token is safe, explain what the scam check reads and point to the pair page; you cannot run scans or trades yourself, you explain where to do them; never mention the model, company or technology behind you; answer in the language the visitor writes in, default English; three sentences unless more is truly needed, plain text, no lists unless asked, no emojis.`;
export async function* chat(messages, facts) {
  const sys = GUIDE + "\nLive facts right now (JSON): " + JSON.stringify(facts);
  const s = stream({ model: MODEL, max_tokens: 450, output_config: { effort: "low" }, system: sys, messages });
  for await (const ev of s) if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
}
