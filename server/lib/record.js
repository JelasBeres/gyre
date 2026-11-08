// The public track record. Every forecast and every verdict GYRE gives is written down with the price at that
// moment; a job later reads the price again and scores it. Nothing is deleted, nothing is edited.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
export function createRecord({ dir, dex }) {
  const FILE = path.join(dir, "record.json"); let db = { forecasts: [], verdicts: [], signals: 0 }, loaded = false, saving = Promise.resolve();
  async function load() { if (loaded) return; try { db = { ...db, ...JSON.parse(await readFile(FILE, "utf8")) }; } catch {} loaded = true; }
  function save() { saving = saving.then(async () => { await mkdir(dir, { recursive: true }); await writeFile(FILE + ".tmp", JSON.stringify(db)); await rename(FILE + ".tmp", FILE); }).catch(() => {}); return saving; }
  const HOURS = { "1h": 1, "4h": 4, "24h": 24 };
  return {
    load,
    async forecast(f) { await load(); const e = { id: Math.random().toString(36).slice(2, 10), at: Date.now(), ...f, resolvedAt: null, priceAtEnd: null, outcome: null }; db.forecasts.push(e); if (db.forecasts.length > 5000) db.forecasts.shift(); await save(); return e; },
    async verdict(v) { await load(); const e = { id: Math.random().toString(36).slice(2, 10), at: Date.now(), ...v }; db.verdicts.push(e); if (db.verdicts.length > 5000) db.verdicts.shift(); await save(); return e; },
    signal() { db.signals++; },
    latestVerdict: (chain, pair) => [...db.verdicts].reverse().find((v) => v.chain === chain && v.pair === pair) || null,
    latestForecast: (chain, pair) => [...db.forecasts].reverse().find((f) => f.chain === chain && f.pair === pair) || null,
    // score forecasts whose horizon has passed: direction right? price inside the range?
    async resolve() {
      await load(); const due = db.forecasts.filter((f) => !f.resolvedAt && Date.now() >= f.at + (HOURS[f.horizon] || 4) * 3600_000).slice(0, 15); let n = 0;
      for (const f of due) { try { const p = await dex.pair(f.chain, f.pair); const price = p?.priceUsd ?? null; f.resolvedAt = Date.now(); f.priceAtEnd = price; if (price != null && f.priceAtStart) { const ch = ((price - f.priceAtStart) / f.priceAtStart) * 100; const dirOk = f.direction === "flat" ? Math.abs(ch) < 5 : f.direction === "up" ? ch > 0 : ch < 0; const inRange = f.rangePct && ch >= f.rangePct[0] && ch <= f.rangePct[1]; f.outcome = { changePct: +ch.toFixed(2), directionHit: dirOk, inRange: !!inRange }; } else f.outcome = { changePct: null, directionHit: null, inRange: null, note: price == null ? "pair gone from the feed" : "no start price" }; n++; } catch {} }
      if (n) await save(); return n;
    },
    stats() {
      const res = db.forecasts.filter((f) => f.outcome && f.outcome.directionHit != null);
      const by = {}; for (const f of res) { const b = (by[f.horizon] ||= { n: 0, dir: 0, range: 0 }); b.n++; if (f.outcome.directionHit) b.dir++; if (f.outcome.inRange) b.range++; }
      const vs = db.verdicts; const byClass = vs.reduce((m, v) => ((m[v.verdict] = (m[v.verdict] || 0) + 1), m), {});
      return { forecasts: db.forecasts.length, resolved: res.length, pending: db.forecasts.filter((f) => !f.resolvedAt).length, directionHitRate: res.length ? +((res.filter((f) => f.outcome.directionHit).length / res.length) * 100).toFixed(1) : null, rangeHitRate: res.length ? +((res.filter((f) => f.outcome.inRange).length / res.length) * 100).toFixed(1) : null, byHorizon: by, verdicts: vs.length, byClass, signals: db.signals };
    },
    recent: (n = 40) => ({ forecasts: [...db.forecasts].slice(-n).reverse(), verdicts: [...db.verdicts].slice(-n).reverse().map((v) => ({ id: v.id, at: v.at, chain: v.chain, pair: v.pair, symbol: v.symbol, score: v.score, verdict: v.verdict, summary: v.summary })) }),
    start() { setInterval(() => this.resolve().catch(() => {}), 10 * 60_000).unref(); },
  };
}
