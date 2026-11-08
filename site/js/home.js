// Landing: the dive. Five scroll chapters over the turning line; live numbers and alerts are real, and an alert makes the line flare.
(() => {
  const { $, $$, esc, fmt, ago, api } = N; document.documentElement.classList.add("home");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById("again")?.addEventListener("click", (e) => { e.preventDefault(); scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" }); });
  document.addEventListener("gyre:site", (e) => { const s = e.detail; const u = s.stats.universe; const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set("#n-pairs", fmt(u.solana + u.robinhood)); set("#n-sig", fmt(s.stats.signals.lastHour)); set("#n-fc", fmt(s.stats.record.forecasts)); set("#n-hit", s.stats.record.directionHitRate != null ? s.stats.record.directionHitRate + "%" : "—"); set("#n-res", fmt(s.stats.record.resolved)); set("#n-verd", fmt(s.stats.record.verdicts)); });
  const row = (a) => `<a class="sig" href="${a.pair ? `/t/${esc(a.chain)}/${esc(a.pair)}` : "/discover"}"><b>${esc(a.symbol || "")}</b><span>${esc(a.title)} · ${esc(a.detail)}</span><i>${ago(a.at)}</i></a>`;
  const MAX = 4;
  async function feed() { try { const r = await api("/api/alerts?limit=" + MAX); const el = $("#feed"); if (el) el.innerHTML = r.alerts.length ? r.alerts.map(row).join("") : '<p class="empty">GYRE is taking its first readings. Live signals surface here within a minute.</p>'; } catch {} }
  function live() { try { const es = new EventSource("/api/stream"); es.addEventListener("alert", (e) => { const a = JSON.parse(e.data); GYRE.flare(a.severity === "high" ? 1.4 : a.severity === "mid" ? 1 : 0.6); const el = $("#feed"); if (el) { el.querySelector(".empty")?.remove(); el.insertAdjacentHTML("afterbegin", row(a)); while (el.children.length > MAX) el.lastElementChild.remove(); } }); es.onerror = () => { es.close(); setTimeout(live, 6000); }; } catch {} }
  feed(); live();
})();
