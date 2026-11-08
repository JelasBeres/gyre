// GYRE · shared chrome and helpers: depth-rail sidebar, CA bar, footer, wallet (EVM for tiers), streaming, formatting.
window.N = (() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (n, d = 0) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: d });
  const usd = (v) => (v == null ? "—" : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : v >= 1 ? `$${v.toFixed(2)}` : v >= 0.0001 ? `$${v.toFixed(4)}` : `$${Number(v).toPrecision(3)}`);
  const price = (v) => (v == null ? "—" : v >= 1 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : v >= 0.001 ? `$${v.toFixed(5)}` : `$${Number(v).toPrecision(3)}`);
  const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`);
  const pctClass = (v) => (v == null ? "mute" : v > 0 ? "up" : v < 0 ? "down" : "mute");
  const ago = (ms) => { if (!ms) return "—"; const m = (Date.now() - ms) / 60000; return m < 1 ? "now" : m < 60 ? `${Math.floor(m)}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
  const short = (a) => (a ? a.slice(0, 5) + "…" + a.slice(-4) : "");
  const toast = (t) => { let el = $("#toast"); if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); } el.textContent = t; el.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 3000); };
  const api = (p, opts) => fetch(p, opts).then(async (r) => { if (r.ok) return r.json(); let m = r.statusText, j = null; try { j = await r.json(); m = j.message || j.error || m; } catch {} throw Object.assign(new Error(m), { status: r.status, code: j?.error }); });
  const post = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  // SSE over fetch (GET or POST) → onEvent(event, data)
  async function stream(url, onEvent, init) {
    const r = await fetch(url, init); if (!r.ok) { let m = r.statusText, j = null; try { j = await r.json(); m = j.message || j.error || m; } catch {} throw Object.assign(new Error(m), { status: r.status, code: j?.error }); }
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "", ev = null;
    for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); for (const line of block.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ")) { let d; try { d = JSON.parse(line.slice(6)); } catch { d = line.slice(6); } onEvent(ev || "message", d); } } } }
  }
  const tokCell = (p) => `<div class="tok">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'${esc((p.base.symbol || "?").slice(0, 3))}'}))">` : `<div class="ph">${esc((p.base.symbol || "?").slice(0, 3))}</div>`}<div><b>${esc(p.base.symbol)} <span style="display:inline;font-family:var(--font);color:var(--mute);font-weight:400">/ ${esc(p.quote.symbol)}</span></b><span>${esc(p.chain === "solana" ? "SOL" : "RH")} · ${esc(p.dex)} · ${ago(p.createdAt)}</span></div></div>`;
  const press = (s) => (s == null ? '<span class="mute">—</span>' : `<span class="press"><i style="--w:${Math.round(s * 100)}%"></i><span class="mono" style="font-size:12px">${Math.round(s * 100)}%</span></span>`);
  const alertEl = (a) => `<div class="al ${esc(a.severity)}"><div class="h"><b>${esc(a.title)}</b><span class="t">${ago(a.at)}</span></div><p><a href="${a.pair ? `/t/${esc(a.chain)}/${esc(a.pair)}` : "#"}"><b>${esc(a.symbol || "")}</b></a> · ${esc(a.detail)}${a.tx ? ` <a class="violet" href="${a.chain === "solana" ? "https://solscan.io/tx/" : "https://robinhoodchain.blockscout.com/tx/"}${esc(a.tx)}" target="_blank" rel="noopener">tx ↗</a>` : ""}</p></div>`;

  const S = { me: { wallet: null, tier: "free", open: true }, site: null, sol: null };
  const TIER = { free: "Free", holder: "Holder", plus: "Holder+", owner: "Owner" };
  const PAGES = [["/discover", "Discover", "00 m"], ["/ask", "Ask", "40 m"], ["/record", "Track record", "200 m"], ["/dashboard", "Dashboard", "1000 m"], ["/docs", "Docs", "4000 m"]];
  const MARK = '<img class="mark" src="/logo.svg" alt="" width="30" height="30">';
  const X_URL = "", X_HANDLE = "";   // set both when the X account exists; every X link stays hidden until then
  const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l16 16M20 4L4 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  const xLink = (cls = "xlink") => (X_URL ? `<a class="${cls}" href="${X_URL}" target="_blank" rel="noopener me" aria-label="GYRE on X">${X_ICON}</a>` : "");
  function chrome() {
    const path = location.pathname.replace(/\/$/, "") || "/";
    const top = $("#top"); if (top) top.innerHTML = `<div class="banner" id="banner" hidden></div><div class="cabar" id="cabar" hidden></div>
      <div class="mtop"><a class="brand" href="/">${MARK}GYRE</a><button class="pill" data-connect id="wallet-m">Connect</button></div>
      <aside class="dock"><a class="brand" href="/">${MARK}GYRE</a>
        <nav class="main">${PAGES.map(([h, t, d]) => `<a href="${h}" ${path === h || (h === "/discover" && path.startsWith("/t/")) ? 'aria-current="page"' : ""}><span>${t}</span><small>${d}</small></a>`).join("")}</nav>
        <span class="sp"></span>
        <div class="live"><i></i><span id="lv-t">reading the current…</span></div>
        <div class="acts"><button class="pill" id="wallet">Connect wallet</button><div class="row"><a class="btn sm" style="flex:1" href="/discover">Open terminal</a>${xLink()}</div></div>
      </aside>`;
    const foot = $("#foot"); if (foot) foot.innerHTML = `<footer><div class="wrap"><div><a class="brand" href="/" style="margin-bottom:12px">${MARK}GYRE</a><p style="margin:0;max-width:46ch;line-height:1.6">GYRE reads the current of money on Solana and Robinhood Chain. Every figure comes from DexScreener or the chain, every verdict and forecast is logged and graded in public, and every swap goes from your wallet straight to the pool. GYRE never holds funds. Memecoins are high risk.</p></div><div><h5>Terminal</h5><a href="/discover">Discover</a><a href="/ask">Ask GYRE</a><a href="/record">Track record</a><a href="/dashboard">Dashboard</a></div><div><h5>Build</h5><a href="/docs">Docs</a><a href="/docs#api">Agent API</a><a href="/docs#x402">Paid scan (x402)</a></div><div><h5>GYRE</h5><a href="/dashboard#tier">Hold $GYRE</a><a href="/studio">Studio</a>${X_URL ? `<a href="${X_URL}" target="_blank" rel="noopener me">X · ${X_HANDLE}</a>` : ""}</div><div class="fine"><span id="foot-live">…</span><span>Solana · Robinhood Chain${X_URL ? ` · <a href="${X_URL}" target="_blank" rel="noopener">${X_HANDLE}</a>` : ""}</span></div></div></footer>`;
  }
  async function loadSite() {
    try { const s = await api("/api/site"); S.site = s;
      const cb = $("#cabar"); if (cb) { if (s.token) { cb.innerHTML = `<span>$GYRE</span><span>CA</span><code>${esc(s.token)}</code><button data-copy="${esc(s.token)}">COPY</button><button class="buy" data-buy>BUY</button><a class="btn ghost sm" style="height:26px;padding:0 10px;font:600 11px var(--mono)" href="/t/robinhood/${esc(s.token)}">TERMINAL</a>`; cb.hidden = false; } else cb.hidden = true; }
      const b = $("#banner"); if (b) { if (s.banner?.on && s.banner.text) { b.innerHTML = `<span>${esc(s.banner.text)}</span>${s.banner.link ? `<a href="${esc(s.banner.link)}" target="_blank" rel="noopener">Open ↗</a>` : ""}`; b.hidden = false; } else b.hidden = true; }
      const u = s.stats.universe; const lv = $("#lv-t"); if (lv) lv.textContent = `${fmt(u.solana + u.robinhood)} pairs · ${fmt(s.stats.signals.lastHour)} signals an hour`;
      const fl = $("#foot-live"); if (fl) fl.textContent = `${fmt(u.solana)} Solana pairs · ${fmt(u.robinhood)} Robinhood pairs · ${fmt(s.stats.record.forecasts)} forecasts on record`;
      document.dispatchEvent(new CustomEvent("gyre:site", { detail: s }));
    } catch {}
  }
  async function loadMe() { try { S.me = await api("/api/access/me"); } catch { return; } const b = $("#wallet"); if (b) { b.textContent = S.me.wallet ? `${S.me.short} · ${TIER[S.me.tier]}` : "Connect wallet"; b.classList.toggle("on", !!S.me.wallet); } const bm = $("#wallet-m"); if (bm) { bm.textContent = S.me.wallet ? S.me.short : "Connect"; bm.classList.toggle("on", !!S.me.wallet); } document.dispatchEvent(new CustomEvent("gyre:me", { detail: S.me })); }
  async function connectWallet() {
    if (S.me.wallet) { if (!confirm(`Disconnect ${S.me.short}?`)) return; await post("/api/access/signout", {}); await loadMe(); toast("Wallet disconnected."); return; }
    if (!window.ethereum) { toast("No EVM wallet found. Install MetaMask or Rabby; tiers are read on Robinhood Chain."); return; }
    try { const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" }); const { message } = await post("/api/access/challenge", { wallet: addr }); const signature = await window.ethereum.request({ method: "personal_sign", params: [message, addr] }); const me = await post("/api/access/signin", { message, signature }); await loadMe(); toast(me.open ? `Connected ${me.short}. Tiers open until $GYRE launches.` : `Connected ${me.short} · ${TIER[me.tier]}`); }
    catch (err) { toast(err.message || "Sign-in cancelled."); }
  }
  // Solana wallet (Phantom/Solflare/Backpack) for swaps on Solana
  const solProvider = () => window.phantom?.solana || window.solflare || window.backpack || (window.solana?.isPhantom ? window.solana : null);
  async function connectSol() { const p = solProvider(); if (!p) { toast("No Solana wallet found. Install Phantom, Solflare or Backpack."); return null; } try { const r = await p.connect(); S.sol = (r?.publicKey || p.publicKey).toString(); document.dispatchEvent(new CustomEvent("gyre:sol", { detail: S.sol })); return S.sol; } catch (e) { toast(e.message || "Cancelled."); return null; } }
  async function ensureChain(chainHex) { const eth = window.ethereum; const cur = await eth.request({ method: "eth_chainId" }); if (cur?.toLowerCase() === chainHex) return; try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] }); } catch (e) { if (e.code === 4902 || /unrecognized|not added/i.test(e.message || "")) await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: chainHex, chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] }] }); else throw e; } }
  document.addEventListener("click", (e) => { const t = e.target; if (t.closest("#wallet") || t.closest("#wallet-m") || t.closest("[data-connect]")) { connectWallet(); return; } const cp = t.closest("[data-copy]"); if (cp) { (navigator.clipboard?.writeText(cp.dataset.copy) || Promise.reject()).then(() => toast("Copied.")).catch(() => toast("Copy blocked by the browser.")); } });

  // ---- buy $GYRE from any page: the server quotes the Pons curve, the visitor's wallet signs. GYRE never holds funds.
  const BUYS = { info: null, acct: null, busy: false, timer: 0 };
  const fmtTok = (v) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  async function openBuy() {
    let info; try { info = await api("/api/token"); } catch (e) { toast(e.message); return; }
    if (!info.token) { toast("$GYRE has not launched yet. The CA will appear here the minute it does."); return; }
    BUYS.info = info; BUYS.acct = S.me.wallet || BUYS.acct; let m = $("#buym"); if (!m) { m = document.createElement("div"); m.id = "buym"; m.className = "modal"; document.body.appendChild(m); }
    const pr = info.priceUsd != null ? usd(info.priceUsd) : "—";
    m.innerHTML = `<div class="sheet" role="dialog" aria-label="Buy $GYRE"><button class="close" data-close aria-label="Close">✕</button><p class="k">${esc(info.symbol)} · Robinhood Chain · Pons curve</p><h3>Buy ${esc(info.symbol)}</h3>
      <div class="pr"><div><b>${pr}</b><span>per token</span></div><div><b>${Number(info.quoteReserve).toFixed(3)} ETH</b><span>in the curve</span></div><div><b>${((info.feeBps + info.taxBps) / 100).toFixed(2)}%</b><span>curve fee</span></div></div>
      ${info.graduated ? `<div class="quote">${esc(info.symbol)} has graduated: it now trades on the DEX, not on the curve.</div><a class="btn" href="/t/robinhood/${esc(info.token)}">Open the terminal</a>` : `
      <p class="k">You pay</p><div class="amt"><input class="f" id="bm-eth" inputmode="decimal" autocomplete="off" placeholder="0.01"><span class="unit">ETH</span></div>
      <div class="qa">${["0.005", "0.01", "0.05", "0.1", "0.5"].map((v) => `<button type="button" data-eth="${v}">${v} ETH</button>`).join("")}</div>
      <div class="quote" id="bm-q">Enter an amount to see how much ${esc(info.symbol)} you get.</div>
      <button class="btn" id="bm-go">${BUYS.acct ? "Buy now" : "Connect wallet & buy"}</button>`}
      <span class="fine">Buys go straight from your wallet to the Pons curve contract (<a href="${esc(info.explorer)}/address/${esc(info.curve)}" target="_blank" rel="noopener">${esc(info.curve.slice(0, 8))}…</a>), 3% max slippage. GYRE never touches your funds. Prefer Pons? <a href="${esc(info.pons)}" target="_blank" rel="noopener">Buy there ↗</a> · <a href="${esc(info.explorer)}/token/${esc(info.token)}" target="_blank" rel="noopener">Contract ↗</a></span></div>`;
    m.hidden = false; const inp = $("#bm-eth"); if (inp) { inp.focus(); inp.addEventListener("input", () => { clearTimeout(BUYS.timer); BUYS.timer = setTimeout(quoteBuy, 350); }); }
  }
  async function quoteBuy() {
    const inp = $("#bm-eth"), q = $("#bm-q"); if (!inp || !q) return null; const v = inp.value.trim(); if (!v || !(Number(v) > 0)) { q.className = "quote"; q.textContent = "Enter an amount to see how much you get."; return null; }
    try { const r = await api(`/api/token/quote?eth=${encodeURIComponent(v)}${BUYS.acct ? "&from=" + BUYS.acct : ""}`); q.className = "quote";
      q.innerHTML = `You get about <b>${fmtTok(r.tokensOut)}</b> ${esc(BUYS.info.symbol)}${r.usd != null ? ` for ${usd(r.usd)}` : ""} · min ${fmtTok(r.minOut)} after 3% slippage${r.snipeTaxBps > 0 ? `<span class="warn">Early-buy tax is ${(r.snipeTaxBps / 100).toFixed(1)}% right now; it falls over the next minutes.</span>` : ""}`; return r; }
    catch (e) { q.className = "quote bad"; q.textContent = e.message; return null; }
  }
  async function doBuy() {
    if (BUYS.busy) return; const go = $("#bm-go"), q = $("#bm-q"), info = BUYS.info; if (!go || !info) return;
    if (!window.ethereum) { toast("No wallet found in this browser. Install MetaMask or Rabby, then try again."); return; }
    const v = ($("#bm-eth")?.value || "").trim(); if (!(Number(v) > 0)) { toast("Enter an amount in ETH first."); return; }
    BUYS.busy = true; go.disabled = true;
    try {
      go.textContent = "Connecting…"; const [acct] = await window.ethereum.request({ method: "eth_requestAccounts" }); BUYS.acct = acct;
      await ensureChain(info.chainHex);
      go.textContent = "Quoting…"; const r = await quoteBuy(); if (!r || !r.data) throw new Error("Could not quote this buy.");
      go.textContent = "Confirm in your wallet…";
      const hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: acct, to: r.to, value: r.value, data: r.data }] });
      go.textContent = "Waiting for the chain…"; q.className = "quote"; q.innerHTML = `Sent. <a href="${esc(info.explorer)}/tx/${esc(hash)}" target="_blank" rel="noopener">View the transaction ↗</a>`;
      let rc = null; for (let i = 0; i < 45 && !rc; i++) { await new Promise((res) => setTimeout(res, 2000)); rc = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null); }
      if (rc && rc.status === "0x1") { q.innerHTML = `Done: about <b>${fmtTok(r.tokensOut)}</b> ${esc(info.symbol)} is in ${esc(acct.slice(0, 6))}…${esc(acct.slice(-4))}. <a href="${esc(info.explorer)}/tx/${esc(hash)}" target="_blank" rel="noopener">Receipt ↗</a>`; toast("Bought. You are in the current."); loadMe(); }
      else if (rc) { q.className = "quote bad"; q.innerHTML = `The buy reverted. <a href="${esc(info.explorer)}/tx/${esc(hash)}" target="_blank" rel="noopener">See why ↗</a>`; }
      else q.innerHTML += " Still pending; check the explorer.";
      go.textContent = "Buy again";
    } catch (e) { toast(e.code === 4001 ? "Cancelled in the wallet." : e.message || "The buy failed."); go.textContent = BUYS.acct ? "Buy now" : "Connect wallet & buy"; }
    finally { BUYS.busy = false; go.disabled = false; }
  }
  document.addEventListener("click", (e) => { const t = e.target; if (t.closest("[data-buy]")) { openBuy(); return; } const m = $("#buym"); if (!m || m.hidden) return;
    if (t.closest("[data-close]") || t === m) { m.hidden = true; return; } const qa = t.closest("[data-eth]"); if (qa) { $("#bm-eth").value = qa.dataset.eth; quoteBuy(); return; } if (t.closest("#bm-go")) doBuy(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { const m = $("#buym"); if (m) m.hidden = true; } });

  // ---- assistant: a round button bottom-right opens a small chat with GYRE. Answers stream from the server; history stays in this tab.
  const CHAT = { open: false, busy: false, msgs: [] };
  function chatMount() {
    if ($("#cbtn")) return;
    const b = document.createElement("button"); b.id = "cbtn"; b.className = "cbtn"; b.setAttribute("aria-label", "Ask GYRE"); b.innerHTML = '<img src="/logo.svg" alt=""><span class="dot"></span>'; document.body.appendChild(b);
    const p = document.createElement("div"); p.id = "cpanel"; p.className = "cpanel"; p.hidden = true; p.setAttribute("role", "dialog"); p.setAttribute("aria-label", "GYRE assistant");
    p.innerHTML = `<div class="ch"><img src="/logo.svg" alt=""><div><b>GYRE</b><span>assistant · live</span></div><button class="x" data-cclose aria-label="Close">✕</button></div><div class="cm" id="cmsgs"><div class="m a">I am GYRE. Ask how the terminal works, what a signal means or what the scam check reads. I never give buy or sell calls.</div><div class="sug" id="csug">${["What does the scam check look at?", "How do holder tiers work?", "What is a whale buy on the curve?", "Where do swaps go?"].map((t) => `<button type="button" data-csug>${esc(t)}</button>`).join("")}</div></div><form class="cf" id="cform"><input class="f" id="cin" autocomplete="off" maxlength="600" placeholder="Ask GYRE…"><button class="btn sm" type="submit" id="csend">Send</button></form>`;
    document.body.appendChild(p);
    b.addEventListener("click", () => chatToggle());
    p.addEventListener("click", (e) => { if (e.target.closest("[data-cclose]")) chatToggle(false); const sg = e.target.closest("[data-csug]"); if (sg) { $("#cin").value = sg.textContent; chatSend(); } });
    $("#cform").addEventListener("submit", (e) => { e.preventDefault(); chatSend(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && CHAT.open) chatToggle(false); });
  }
  function chatToggle(on = !CHAT.open) { CHAT.open = on; const p = $("#cpanel"), b = $("#cbtn"); if (!p) return; p.hidden = !on; b.classList.toggle("on", on); if (on) setTimeout(() => $("#cin")?.focus(), 50); }
  function chatAdd(role, text) { const box = $("#cmsgs"); const el = document.createElement("div"); el.className = "m " + (role === "user" ? "u" : "a"); el.textContent = text; box.appendChild(el); box.scrollTop = box.scrollHeight; return el; }
  async function chatSend() {
    if (CHAT.busy) return; const inp = $("#cin"); const q = (inp.value || "").trim(); if (!q) return; inp.value = ""; $("#csug")?.remove();
    CHAT.msgs.push({ role: "user", content: q }); chatAdd("user", q); const el = chatAdd("assistant", ""); el.classList.add("typing"); CHAT.busy = true; $("#csend").disabled = true; let t = "";
    try { await stream("/api/chat", (ev, d) => { if (ev === "delta") { t += d; el.textContent = t; el.classList.remove("typing"); $("#cmsgs").scrollTop = 1e9; } else if (ev === "error") { el.textContent = d.message; el.classList.remove("typing"); } }, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: CHAT.msgs.slice(-12), page: location.pathname }) }); if (t) CHAT.msgs.push({ role: "assistant", content: t }); }
    catch (e) { el.textContent = e.status === 429 ? e.message : e.message || "GYRE did not answer. Try again."; el.classList.remove("typing"); }
    finally { CHAT.busy = false; $("#csend").disabled = false; inp.focus(); }
  }
  if (!location.pathname.startsWith("/studio")) chatMount();
  const measure = () => { const bn = $("#banner"), cb = $("#cabar"), h = (el) => (el && !el.hidden ? el.offsetHeight : 0), r = document.documentElement.style;   // fixed bars stack: banner, then CA bar
    r.setProperty("--bn", h(bn) + "px"); r.setProperty("--cb", h(bn) + h(cb) + "px"); r.setProperty("--top", h(bn) + h(cb) + "px"); };
  chrome(); measure(); loadSite().then(measure); loadMe(); setInterval(() => loadSite().then(measure), 30000); addEventListener("resize", measure);
  return { openBuy, $, $$, esc, fmt, usd, price, pct, pctClass, ago, short, toast, api, post, stream, tokCell, press, alertEl, S, TIER, connectWallet, connectSol, solProvider, ensureChain, loadMe, loadSite, MARK };
})();
