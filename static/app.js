/* Edgebook front end — vanilla JS, hash-routed. */
"use strict";

const S = {
  f: { account: "", from: "", to: "", preset: "all" },
  settings: {}, accounts: [], tags: [], playbooks: [], symbols: [],
  charts: [], tv: null, mt5: null,
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = () => $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ------------------------------------------------------------ api */
async function api(path, opts = {}) {
  const o = { ...opts };
  if (o.body && !(o.body instanceof FormData)) {
    o.headers = { "Content-Type": "application/json" };
    o.body = JSON.stringify(o.body);
  }
  const r = await fetch(path, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}
function qs(extra = {}) {
  const p = { account: S.f.account, from: S.f.from, to: S.f.to, ...extra };
  return new URLSearchParams(Object.entries(p).filter(([, v]) => v !== "" && v != null)).toString();
}

/* ------------------------------------------------------------ format */
const cur = () => S.settings.currency_symbol ?? "$";
function money(v, opts = {}) {
  if (v == null || isNaN(v)) return "—";
  const a = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = v < 0 ? "-" : opts.plus && v > 0 ? "+" : "";
  return `${sign}${cur()}${a}`;
}
const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
const pct = (v, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
const num = (v, d = 2) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(d));
const rr = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}R`);
const pf = (s) => (s.profit_factor_inf ? "∞" : num(s.profit_factor));
function price(v) {
  if (v == null) return "—";
  const d = Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 50 ? 3 : 5;
  return Number(v).toFixed(d);
}
function dur(sec) {
  if (sec == null) return "—";
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d}d ${h % 24}h`;
  if (h) return `${h}h ${m % 60}m`;
  return `${m}m`;
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dt(ts, withYear = false) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const h = d.getUTCHours();
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}${withYear ? " " + d.getUTCFullYear() : ""}, ${h % 12 || 12}:${p(d.getUTCMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
const ampm = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
function dayLabel(s) {
  const d = new Date(s + "T00:00:00Z");
  return `${DOW[d.getUTCDay()]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}
const iso = (d) => d.toISOString().slice(0, 10);
function serverNow() {
  return new Date(Date.now() + (Number(S.settings.display_utc_offset) || 0) * 3600e3);
}
const stars = (n) => (n ? `<span class="stars">${"★".repeat(n)}<span class="faint">${"★".repeat(5 - n)}</span></span>` : '<span class="faint">—</span>');
const sideBadge = (d) => `<span class="side-badge ${d}">${d}</span>`;
const tagChips = (tags) => (tags || []).map((g) => `<span class="chip ${g.kind}">${esc(g.name)}</span>`).join("");

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), isErr ? 6000 : 2500);
}
function modal(html, cls = "") {
  $("#modalBox").className = "modal-box " + cls;
  $("#modalBox").innerHTML = html;
  $("#modal").hidden = false;
}
function closeModal() { $("#modal").hidden = true; }
$("#modal").addEventListener("mousedown", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ------------------------------------------------------------ charts */
const C = { pos: "#22c55e", neg: "#f05252", accent: "#14b8a6", grid: "#222b36", tick: "#8b98a8", blue: "#5b8def" };
function cleanup() {
  S.charts.forEach((c) => c.destroy());
  S.charts = [];
  if (S.tv) { S.tv.remove(); S.tv = null; }
}
function baseOpts(extra = {}) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: "#1b222c", borderColor: "#323d4c", borderWidth: 1, padding: 10, titleColor: "#e6edf3", bodyColor: "#e6edf3" } },
    scales: {
      x: { grid: { display: false }, ticks: { color: C.tick, maxTicksLimit: 8, maxRotation: 0 } },
      y: { grid: { color: C.grid }, border: { display: false }, ticks: { color: C.tick, callback: (v) => money(v) } },
    },
    ...extra,
  };
}
function chart(canvas, cfg) {
  if (!window.Chart || !canvas) return null;
  const c = new Chart(canvas, cfg);
  S.charts.push(c);
  return c;
}
function equityChart(canvas, points, opts = {}) {
  if (!points.length) return;
  const labels = points.map((p) => dt(p.time));
  const data = points.map((p) => p.value);
  const ctx = canvas.getContext("2d");
  const last = data[data.length - 1];
  const color = last >= 0 ? C.pos : C.neg;
  const g = ctx.createLinearGradient(0, 0, 0, canvas.parentElement.clientHeight || 260);
  g.addColorStop(0, last >= 0 ? "rgba(34,197,94,.28)" : "rgba(240,82,82,.28)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  chart(canvas, {
    type: "line",
    data: { labels, datasets: [{ data, borderColor: color, backgroundColor: g, fill: true, pointRadius: 0, borderWidth: 2, tension: 0.15 }] },
    options: baseOpts({ plugins: { ...baseOpts().plugins, tooltip: { ...baseOpts().plugins.tooltip, callbacks: { label: (c) => " " + money(c.parsed.y) } } }, ...(opts.compact ? { scales: { x: { display: false }, y: { display: false } } } : {}) }),
  });
}
function barChart(canvas, labels, values, opts = {}) {
  chart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ data: values, backgroundColor: values.map((v) => (v >= 0 ? C.pos : C.neg)), borderRadius: 3, maxBarThickness: 34 }] },
    options: baseOpts({
      indexAxis: opts.horizontal ? "y" : "x",
      plugins: { ...baseOpts().plugins, tooltip: { ...baseOpts().plugins.tooltip, callbacks: { label: (c) => " " + money(opts.horizontal ? c.parsed.x : c.parsed.y) } } },
      scales: opts.horizontal
        ? { y: { grid: { display: false }, ticks: { color: C.tick } }, x: { grid: { color: C.grid }, ticks: { color: C.tick, callback: (v) => money(v) } } }
        : baseOpts().scales,
    }),
  });
}

/* ------------------------------------------------------------ filters / boot */
function applyPreset(p) {
  S.f.preset = p;
  const now = serverNow();
  const t = iso(now);
  let from = "", to = "";
  if (p === "today") { from = to = t; }
  else if (p === "week") { const d = new Date(now); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); from = iso(d); to = t; }
  else if (p === "month") { from = t.slice(0, 8) + "01"; to = t; }
  else if (p === "30" || p === "90") { const d = new Date(now); d.setUTCDate(d.getUTCDate() - Number(p) + 1); from = iso(d); to = t; }
  else if (p === "ytd") { from = t.slice(0, 4) + "-01-01"; to = t; }
  else if (p === "custom") { from = $("#fFrom").value; to = $("#fTo").value; }
  S.f.from = from; S.f.to = to;
  $("#customRange").hidden = p !== "custom";
  if (p === "custom") { $("#fFrom").value = from; $("#fTo").value = to; }
  saveFilters();
}
function saveFilters() { try { localStorage.setItem("edgebook.f", JSON.stringify(S.f)); } catch (e) {} }
function loadFilters() {
  try { Object.assign(S.f, JSON.parse(localStorage.getItem("edgebook.f") || "{}")); } catch (e) {}
}

async function refreshMeta() {
  const st = await api("/api/status");
  S.settings = st.settings;
  S.accounts = st.accounts;
  [S.tags, S.playbooks, S.symbols] = await Promise.all([api("/api/tags"), api("/api/playbooks"), api("/api/symbols")]);
  const sel = $("#fAccount");
  sel.innerHTML = `<option value="">All accounts</option>` + S.accounts.map((a) => `<option value="${a.login}">${esc(a.name || a.login)} · ${a.login}</option>`).join("");
  if (!S.accounts.some((a) => String(a.login) === String(S.f.account))) S.f.account = "";
  sel.value = S.f.account;
  renderSyncInfo(st);
  return st;
}
function renderSyncInfo(st) {
  const s = st.sync;
  let html;
  if (!st.mt5_package) html = `<span class="dot err"></span>MT5 package missing`;
  else if (s.error) html = `<span class="dot err"></span>Sync error<br><span class="faint">${esc(s.error).slice(0, 120)}</span>`;
  else if (s.last) html = `<span class="dot on"></span>Synced ${timeAgo(s.last)}${st.settings.auto_sync ? `<br><span class="faint">Auto every ${st.settings.sync_interval}s</span>` : ""}`;
  else html = `<span class="dot"></span>Not synced yet`;
  $("#syncInfo").innerHTML = html;
}
function timeAgo(ts) {
  const s = Math.round(Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

$("#fAccount").addEventListener("change", (e) => { S.f.account = e.target.value; saveFilters(); route(); });
$("#fPreset").addEventListener("change", (e) => { applyPreset(e.target.value); if (e.target.value !== "custom") route(); });
["#fFrom", "#fTo"].forEach((id) => $(id).addEventListener("change", () => { applyPreset("custom"); route(); }));
$("#syncBtn").addEventListener("click", async () => {
  const b = $("#syncBtn");
  b.disabled = true; b.textContent = "Syncing…";
  try {
    const r = await api("/api/sync", { method: "POST" });
    toast(r.skipped ? "A sync is already running" : `Synced ${r.trades} trades (${r.new} new) in ${r.seconds}s`);
    await refreshMeta();
    route();
  } catch (e) { toast(e.message, true); await refreshMeta().catch(() => {}); }
  b.disabled = false; b.textContent = "↻ Sync";
});
setInterval(async () => {
  try {
    const before = S.lastSync;
    const st = await api("/api/status");
    renderSyncInfo(st);
    S.lastSync = st.sync.last;
    const page = location.hash.split("/")[1] || "";
    if (before && st.sync.last !== before && ["", "journal", "trades"].includes(page) && document.visibilityState === "visible") {
      S.symbols = await api("/api/symbols");
      route(true);
    }
  } catch (e) {}
}, 20000);

/* ------------------------------------------------------------ chart boxes */
let PASTE = null; // upload function of the box that Ctrl+V goes to
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (PASTE && files.length) PASTE(files);
});
function chartBoxHtml(id, title, note = "", saved = "") {
  return `<div class="card" id="${id}"><div class="card-h"><h2>${title}</h2>${saved}</div>
    <div class="shots"></div>
    <div class="drop" style="margin-top:10px">Drop images here, or hover and press Ctrl+V, or click to upload<input type="file" accept="image/*" multiple hidden></div>${note}</div>`;
}
function mountChartBox(id, items, uploadUrl, deleteUrl, pick) {
  const root = $("#" + id), drop = root.querySelector(".drop"), input = root.querySelector("input");
  const draw = () => {
    root.querySelector(".shots").innerHTML = items.map((s) => `<div class="shot"><img src="/uploads/${esc(s.filename)}"><button data-del="${s.id}" title="Delete">✕</button></div>`).join("");
    root.querySelectorAll("img").forEach((im) => im.addEventListener("click", () => modal(`<img src="${im.getAttribute("src")}">`, "img")));
    root.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Delete this chart?")) return;
      await api(deleteUrl(b.dataset.del), { method: "DELETE" });
      items = items.filter((s) => s.id !== +b.dataset.del);
      draw();
    }));
  };
  const upload = async (files) => {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) { toast("No image received. Copy the picture and press Ctrl+V, or drag a saved file."); return; }
    const fd = new FormData();
    imgs.forEach((f, i) => fd.append("file", f, f.name || `paste-${Date.now()}-${i}.png`));
    items = pick(await api(uploadUrl, { method: "POST", body: fd }));
    draw();
    toast("Chart added");
  };
  const activate = () => {
    $$(".drop.active").forEach((d) => d.classList.remove("active"));
    drop.classList.add("active");
    PASTE = upload;
  };
  draw();
  root.addEventListener("mouseenter", activate);
  drop.onclick = () => input.click();
  input.onchange = (e) => upload(e.target.files);
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); upload(e.dataTransfer.files); });
  return activate;
}

/* ------------------------------------------------------------ setups */
async function renderSetups() {
  const d = await api("/api/setups");
  const table = (rows, empty) => (!rows.length ? `<div class="empty"><b>${empty}</b></div>` : `<div class="tbl-wrap"><table><thead><tr>
    <th>Placed</th><th>Symbol</th><th>Side</th><th>Type</th><th class="r">Volume</th><th class="r">Price</th><th class="r">SL</th><th class="r">TP</th><th>Status</th><th class="r">Plan charts</th>
  </tr></thead><tbody>${rows.map((s) => `<tr class="click" data-ticket="${s.ticket}">
    <td class="muted">${dt(s.placed_time)}</td><td><b>${esc(s.symbol)}</b></td><td>${sideBadge(s.direction)}</td><td>${esc(s.order_type)}</td>
    <td class="r num">${s.volume ?? "—"}</td><td class="r num">${price(s.price)}</td><td class="r num">${price(s.sl)}</td><td class="r num">${price(s.tp)}</td>
    <td>${esc(s.status)}</td><td class="r num">${s.charts || ""}</td></tr>`).join("")}</tbody></table></div>`);
  view().innerHTML = `<div class="stack">
    <div class="card"><div class="card-h"><h2>Waiting: pending orders and open trades</h2></div>${table(d.waiting, "Nothing waiting. Place an order in MT5, then press Sync.")}</div>
    <div class="card"><div class="card-h"><h2>Skipped setups: cancelled orders and missed trades</h2><button class="btn primary" id="addMissed">＋ Add missed trade</button></div>${table(d.skipped, "No skipped setups")}</div></div>`;
  $("#addMissed").onclick = missedEditor;
  $$("tr[data-ticket]").forEach((tr) => tr.addEventListener("click", () => (location.hash = `#/setup/${tr.dataset.ticket}`)));
}
function missedEditor() {
  const now = new Date(Date.now() + (S.settings.display_utc_offset || 0) * 3600000).toISOString().slice(0, 16);
  modal(`<h2 style="margin-bottom:14px">Add missed trade</h2>
    <p class="muted" style="margin-top:0">A setup you saw but did not take. It is kept in Skipped setups and never counts in your results.</p>
    <div class="row"><label class="field" style="flex:1"><span>Symbol</span><input type="text" id="mSym" list="mSyms" value="${esc(S.symbols[0] || "")}" style="width:100%"><datalist id="mSyms">${S.symbols.map((x) => `<option value="${esc(x)}">`).join("")}</datalist></label>
      <label class="field"><span>Side</span><select id="mDir"><option value="long">Long</option><option value="short">Short</option></select></label></div>
    <label class="field"><span>When you saw it</span><input type="datetime-local" id="mWhen" value="${now}"></label>
    <div class="row"><label class="field" style="flex:1"><span>Planned entry</span><input type="number" step="any" id="mPrice" style="width:100%"></label>
      <label class="field" style="flex:1"><span>Stop loss</span><input type="number" step="any" id="mSl" style="width:100%"></label>
      <label class="field" style="flex:1"><span>Target</span><input type="number" step="any" id="mTp" style="width:100%"></label></div>
    <label class="field"><span>Why did you skip it?</span><textarea id="mNotes" style="min-height:60px" placeholder="e.g. hesitated on the breakout"></textarea></label>
    <div class="row"><span class="muted">You can add the chart picture on the next screen.</span><span class="spacer"></span><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" id="mSave">Save</button></div>`);
  $("#mSave").onclick = async () => {
    try {
      const r = await api("/api/setups", { method: "POST", body: { symbol: $("#mSym").value, direction: $("#mDir").value, placed: $("#mWhen").value,
        price: $("#mPrice").value, sl: $("#mSl").value, tp: $("#mTp").value, notes: $("#mNotes").value } });
      closeModal(); toast("Missed trade saved");
      location.hash = `#/setup/${r.ticket}`;
    } catch (e) { toast(e.message, true); }
  };
}
async function renderSetup(ticket) {
  const s = await api(`/api/setups/${ticket}`);
  $("#pageTitle").textContent = `${s.symbol} · ${dt(s.placed_time, true)}`;
  view().innerHTML = `<div class="trade-head"><a class="btn" href="#/setups">← Setups</a>
      <span class="sym">${esc(s.symbol)}</span>${sideBadge(s.direction)}<span class="muted">${esc(s.status)}</span>
      <span class="spacer"></span>${s.trade_id ? `<a class="btn" href="#/trade/${s.trade_id}">Open trade →</a>` : ""}${s.status === "missed" ? `<button class="btn danger" id="delMissed">Delete</button>` : ""}</div>
    <div class="trade-layout"><div class="stack"><div class="card"><dl class="kv">
        <dt>Order</dt><dd>${s.status === "missed" ? "typed in" : "#" + s.ticket}</dd><dt>Type</dt><dd>${esc(s.order_type)}</dd><dt>Volume</dt><dd>${s.volume == null ? "—" : s.volume + " lots"}</dd>
        <dt>Price</dt><dd>${price(s.price)}</dd><dt>Stop loss</dt><dd>${price(s.sl)}</dd><dt>Take profit</dt><dd>${price(s.tp)}</dd></dl></div></div>
      <div class="stack">${chartBoxHtml("boxPlan", "Plan chart")}
        <div class="card"><div class="card-h"><h2>Plan notes</h2><span class="saved" id="pSaved">Saved</span></div>
          <textarea id="planNotes" rows="6" placeholder="What is the plan? Why this level?">${esc(s.notes)}</textarea></div></div></div>`;
  mountChartBox("boxPlan", s.charts, `/api/setups/${ticket}/charts`, (c) => `/api/setup_charts/${c}`, (r) => r.charts)();
  const del = $("#delMissed");
  if (del) del.onclick = async () => {
    if (!confirm("Delete this missed trade and its charts?")) return;
    await api(`/api/setups/${ticket}`, { method: "DELETE" });
    location.hash = "#/setups";
  };
  const save = debounce(async () => {
    await api(`/api/setups/${ticket}`, { method: "PATCH", body: { notes: $("#planNotes").value } });
    const el = $("#pSaved"); el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 1200);
  }, 700);
  $("#planNotes").addEventListener("input", save);
}

/* ------------------------------------------------------------ router */
const ROUTES = {
  "": [renderDashboard, "Dashboard", "dashboard"],
  journal: [renderJournal, "Daily journal", "journal"],
  day: [renderDay, "Day", "journal"],
  trades: [renderTrades, "Trades", "trades"],
  trade: [renderTrade, "Trade", "trades"],
  setups: [renderSetups, "Setups", "setups"],
  setup: [renderSetup, "Setup", "setups"],
  reports: [renderReports, "Reports", "reports"],
  playbooks: [renderPlaybooks, "Playbooks", "playbooks"],
  playbook: [renderPlaybook, "Playbook", "playbooks"],
  settings: [renderSettings, "Settings", "settings"],
};
async function route(soft = false) {
  const [, page = "", arg] = location.hash.replace(/^#/, "").split("/");
  const [fn, title, nav] = ROUTES[page] || ROUTES[""];
  $$("nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === nav));
  $("#pageTitle").textContent = title;
  if (page !== "trade" && page !== "day") FROM_WEEKLY = false;
  const scroll = window.scrollY;
  cleanup();
  PASTE = null;
  if (!soft) view().innerHTML = `<div class="loading">Loading…</div>`;
  try {
    await fn(arg ? decodeURIComponent(arg) : undefined);
    if (soft) window.scrollTo(0, scroll);
  } catch (e) {
    view().innerHTML = `<div class="alert bad">${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", () => route());

/* ------------------------------------------------------------ shared blocks */
const info = (lines, right = false) => `<span class="howBtn">ⓘ<span class="howPop${right ? " r" : ""}"><b>How it is computed</b><br>${lines.join("<br>")}</span></span>`;
const infoLabel = (text, side, lines, right = false) => `<div class="label" style="justify-content:flex-start;gap:6px">${info(lines, right)}<span style="flex:1;display:flex;justify-content:space-between;color:inherit">${text}${side ? ` <span>${side}</span>` : ""}</span></div>`;
function statCards(s) {
  const wr = s.win_rate ?? 0;
  const dwr = s.day_win_rate ?? 0;
  const be = s.net - s.gross_profit - s.gross_loss, zone = S.settings.be_zone_r ?? 0;
  return `<div class="grid g-stats">
    <div class="card stat">${infoLabel("Net P&amp;L", `${s.trades} trades`, [
        `All ${s.trades} trades added up, after fees and swap.`,
        `Winning trades: ${money(s.gross_profit)}`, `Losing trades: ${money(s.gross_loss)}`, `Breakeven trades: ${money(be)}`,
        `${money(s.gross_profit)} + ${money(s.gross_loss)} + ${money(be)} = ${money(s.net)}`,
        `Fees ${money(s.commission)} and swap ${money(s.swap)} are already inside this number.`])}
      <div class="value ${cls(s.net)}">${money(s.net)}</div>
      <div class="sub">Fees ${money(s.commission)} · Swap ${money(s.swap)}</div></div>
    <div class="card stat">${infoLabel("Trade win %", `${s.wins}W · ${s.losses}L${s.breakeven ? ` · ${s.breakeven}BE` : ""}`, [
        `Wins ÷ (wins + losses).`, `${s.wins} ÷ (${s.wins} + ${s.losses}) = ${pct(s.win_rate)}`,
        `Breakeven trades (result within ±${zone}R) are not counted: ${s.breakeven}.`])}
      <div class="value">${pct(s.win_rate)}</div>
      <div class="bar"><b style="width:${wr * 100}%"></b></div></div>
    <div class="card stat">${infoLabel("Profit factor", "", [
        `Money won ÷ money lost.`, `${money(s.gross_profit)} ÷ ${money(Math.abs(s.gross_loss))} = ${pf(s)}`,
        `Above 1 = you make more than you lose. 2.5 or more gets full marks in the Outcome score.`])}
      <div class="value">${pf(s)}</div>
      <div class="sub">${money(s.gross_profit)} / ${money(s.gross_loss)}</div></div>
    <div class="card stat">${infoLabel("Avg win / avg loss", "", [
        `Average win: ${money(s.gross_profit)} ÷ ${s.wins} wins = ${money(s.avg_win)}`,
        `Average loss: ${money(s.gross_loss)} ÷ ${s.losses} losses = ${money(s.avg_loss)}`,
        `${money(s.avg_win)} ÷ ${money(Math.abs(s.avg_loss))} = ${num(s.payoff)}`,
        `2.0 or more gets full marks in the Outcome score.`])}
      <div class="value">${num(s.payoff)}</div>
      <div class="sub"><span class="pos">${money(s.avg_win)}</span> · <span class="neg">${money(s.avg_loss)}</span></div></div>
    <div class="card stat">${infoLabel("Day win %", `${s.green_days}G · ${s.red_days}R`, [
        `Green days ÷ (green days + red days). A day is green when its trades add up to a profit.`,
        `${s.green_days} ÷ (${s.green_days} + ${s.red_days}) = ${pct(s.day_win_rate)}`])}
      <div class="value">${pct(s.day_win_rate)}</div>
      <div class="bar"><b style="width:${dwr * 100}%"></b></div></div>
    <div class="card stat">${infoLabel("Process score", `${(s.graded_trades ?? 0) - (s.tilt_trades ?? 0)} clean of ${s.graded_trades ?? 0} graded`, [
        `How you traded. Results do not count.`,
        `Rules: per trade, required playbook rules ticked ÷ required rules. Average of trades with ticks = ${s.rules_score ?? "—"}`,
        `Behavior: per trade, 100 − 25 for each tilt flag. Average = ${s.behaviour_score ?? "—"}`,
        `Process = average of the two = ${s.process_score ?? "—"}`,
        `Only graded trades count: ${s.graded_trades ?? 0} (from the "Grade discipline from" date in Settings). Clean = no tilt flag.`], true)}
      <div class="value">${s.process_score ?? "—"}</div>
      <div class="bar"><b style="width:${s.process_score ?? 0}%"></b></div>
      <div class="sub" title="Rules: playbook boxes ticked. Behavior: 100 minus 25 per tilt flag. Process score is the average of the two.">Rules ${s.rules_score ?? "—"} · Behavior ${s.behaviour_score ?? "—"}</div></div>
    <div class="card stat">${infoLabel("Expectancy", "", [
        `What one trade makes on average.`, `${money(s.net)} ÷ ${s.trades} trades = ${money(s.expectancy)}`,
        `Avg R: ${rr(s.total_r)} total ÷ ${s.r_count} trades with a stop loss = ${rr(s.avg_r)}`,
        `R = profit ÷ money risked at the stop loss. Trades without a stop loss have no R.`], true)}
      <div class="value ${cls(s.expectancy)}">${money(s.expectancy)}</div>
      <div class="sub">Avg ${rr(s.avg_r)} per trade${s.r_count ? ` · ${s.r_count} with SL` : ""}</div></div>
  </div>`;
}
function tradesTable(trades, opts = {}) {
  if (!trades.length) return `<div class="empty"><b>No trades</b>Nothing matches the current filters.</div>`;
  const sel = opts.select;
  return `<div class="tbl-wrap"><table><thead><tr>
    ${sel ? `<th><input type="checkbox" id="selAll"></th>` : ""}
    <th>Closed</th><th>Symbol</th><th>Side</th><th class="r">Volume</th>
    ${opts.compact ? "" : `<th class="r">Entry</th><th class="r">Exit</th>`}
    <th class="r">Net P&amp;L</th><th class="r">R</th><th class="r">Hold</th>
    ${opts.compact ? "" : `<th>Playbook</th><th>Tags</th><th>Rating</th><th></th>`}
  </tr></thead><tbody>
  ${trades.map((t) => `<tr class="click" data-id="${t.id}">
    ${sel ? `<td><input type="checkbox" class="sel" value="${t.id}"></td>` : ""}
    <td class="muted">${dt(t.close_time)}</td>
    <td><b>${esc(t.symbol)}</b></td>
    <td>${sideBadge(t.direction)}</td>
    <td class="r num">${t.volume}</td>
    ${opts.compact ? "" : `<td class="r num">${price(t.entry_price)}</td><td class="r num">${price(t.exit_price)}</td>`}
    <td class="r num ${cls(t.net)}">${money(t.net)}</td>
    <td class="r num ${cls(t.r)}">${rr(t.r)}</td>
    <td class="r muted">${dur(t.close_time - t.open_time)}</td>
    ${opts.compact ? "" : `<td>${t.playbook_name ? `<span class="pb-dot" style="background:${esc(t.playbook_color || "#3fb68b")}"></span>${esc(t.playbook_name)}` : '<span class="faint">—</span>'}</td>
      <td style="white-space:normal;max-width:240px">${tagChips(t.tags)}</td><td>${stars(t.rating)}</td>
      <td title="${t.reviewed ? "Reviewed" : "Not reviewed"}">${t.reviewed ? '<span class="pos">✓</span>' : (t.notes ? "✎" : "")}</td>`}
  </tr>`).join("")}
  </tbody></table></div>`;
}
function bindTradeRows(root) {
  $$("tr.click", root).forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest("input")) return;
    location.hash = `#/trade/${tr.dataset.id}`;
  }));
}

/* ------------------------------------------------------------ dashboard */
async function renderDashboard() {
  const [d, pos] = await Promise.all([api("/api/dashboard?" + qs()), api("/api/positions").catch(() => [])]);
  S.lastSync = S.lastSync || null;
  const s = d.summary;
  renderRuleBanner(d.rules);
  if (!s.trades && !S.accounts.length) {
    view().innerHTML = onboarding();
    return;
  }
  view().innerHTML = `<div class="stack">
    ${statCards(s)}
    <div class="grid g-2">
      <div class="card" style="display:flex;flex-direction:column"><div class="card-h"><h2>Cumulative P&amp;L</h2><span class="muted">${info([`The biggest fall of this line from a high point to a later low point.`,
        `Largest peak-to-low drop over these ${s.trades} trades: ${money(s.max_drawdown)}`,
        `It is in dollars of closed trades, not a percent of the balance.`], true)} Max drawdown <b class="neg num">${money(-s.max_drawdown)}</b></span></div>
        <div class="chart-box tall" style="flex:1;height:auto;min-height:340px"><canvas id="eq" style="position:absolute;inset:0"></canvas></div></div>
      <div class="card">${scorePanel(s)}</div>
    </div>
    <div class="grid g-2e">
      <div class="card"><div class="card-h"><h2>Daily net P&amp;L</h2><span class="muted">${s.days} trading days</span></div>
        <div class="chart-box"><canvas id="daily"></canvas></div></div>
      <div class="card">${rulePanel(d.rules)}</div>
    </div>
    <div class="card" id="calCard"></div>
    <div class="grid g-2e">
      <div class="card"><div class="card-h"><h2>Recent trades</h2><a class="btn sm" href="#/trades">View all</a></div>${tradesTable(d.recent, { compact: true })}</div>
      <div class="card"><div class="card-h"><h2>Open positions</h2><span class="muted">${pos.length ? "Live from MT5" : ""}</span></div>${positionsTable(pos)}</div>
    </div>
  </div>`;
  equityChart($("#eq"), d.equity);
  const daily = d.daily.slice(-90);
  barChart($("#daily"), daily.map((x) => x.date.slice(5)), daily.map((x) => +x.net.toFixed(2)));
  bindTradeRows(view());
  const ring = $("#ring");
  if (ring && s.edge_score != null) {
    chart(ring, { type: "doughnut", data: { datasets: [{ data: [s.edge_score, 100 - s.edge_score], backgroundColor: [C.accent, "#222b36"], borderWidth: 0 }] },
      options: { cutout: "78%", plugins: { legend: { display: false }, tooltip: { enabled: false } }, animation: false } });
  }
  let month = (S.f.to || iso(serverNow())).slice(0, 7);
  if (d.daily.length && !S.f.to) month = d.daily[d.daily.length - 1].date.slice(0, 7);
  renderCalendar($("#calCard"), month);
}
function onboarding() {
  return `<div class="card" style="max-width:720px;margin:20px auto">
    <h2 style="font-size:18px;margin-bottom:8px">Connect your MT5 terminal</h2>
    <p class="muted">Edgebook reads your closed trades straight from the MetaTrader 5 terminal on this PC. Nothing leaves your computer.</p>
    <ol style="line-height:1.9;padding-left:20px">
      <li>Open MetaTrader 5 and log in to your account.</li>
      <li>In MT5: <b>Tools → Options → Expert Advisors</b> → tick <b>Allow algorithmic trading</b>.</li>
      <li>Set your broker's server time offset in <a href="#/settings" class="pos">Settings</a> (most brokers are UTC+2 / +3).</li>
      <li>Press <b>↻ Sync</b> at the top right.</li>
    </ol>
    <p class="muted">Want to look around first? Restart with <code>python app.py --demo</code> to load sample trades.</p>
  </div>`;
}
function scorePanel(s) {
  const rows = [
    ["Largest win", money(s.largest_win), "pos"], ["Largest loss", money(s.largest_loss), "neg"],
    ["Best day", money(s.best_day), cls(s.best_day)], ["Worst day", money(s.worst_day), cls(s.worst_day)],
    ["Avg hold (wins)", dur(s.avg_hold_win), ""], ["Avg hold (losses)", dur(s.avg_hold_loss), ""],
    ["Win / loss streak", `${s.max_win_streak} / ${s.max_loss_streak}`, ""],
    ["Current streak", s.current_streak > 0 ? `${s.current_streak} wins` : s.current_streak < 0 ? `${-s.current_streak} losses` : "—", cls(s.current_streak)],
    ["Long", `${s.longs} · ${money(s.long_net)}`, cls(s.long_net)], ["Short", `${s.shorts} · ${money(s.short_net)}`, cls(s.short_net)],
  ];
  return `<div class="card-h"><h2>Outcome score</h2>${info([`Results only. Average of the six parts below, each 0 to 100. Behaviour is in the Process score.`,
        `Win rate: 100 at 60% wins`, `Profit factor: 100 at 2.5`, `Avg win / loss: 100 at 2.0`,
        `Drawdown: 100 − biggest drop as a share of all winnings`, `Recovery: net profit ÷ biggest drop, 100 at 3`,
        `Consistency: lower when one day made most of the profit`,
        ...(s.outcome_parts ? [`(${s.outcome_parts.map((x) => x.score).join(" + ")}) ÷ 6 = ${s.edge_score}`] : [`Needs 5 or more trades.`])], true)}</div>
    ${s.edge_score != null ? `<div class="score-ring"><canvas id="ring"></canvas><span>${s.edge_score}</span></div>
      ${s.outcome_parts.map((p) => `<div class="row" style="margin-top:8px;font-size:12px"><span style="width:96px">${p.name}</span><div class="progress" style="flex:1"><b style="width:${p.score}%"></b></div><span class="num" style="width:28px;text-align:right">${p.score}</span></div>`).join("")}` : `<div class="empty">Needs 5+ trades</div>`}
    <dl class="kv" style="margin-top:16px">${rows.map(([k, v, c]) => `<dt>${k}</dt><dd class="${c}">${v}</dd>`).join("")}</dl>`;
}
function meter(label, value, limit, invert) {
  const p = limit > 0 ? Math.min(Math.max(value / limit, 0), 1) : 0;
  const color = invert ? C.accent : p > 0.85 ? C.neg : p > 0.6 ? "#f2a93b" : C.accent;
  return `<div class="meter"><div class="lbl"><span>${label}</span><span class="num">${money(value)} / ${money(limit)}</span></div>
    <div class="track"><b style="width:${p * 100}%;background:${color}"></b></div></div>`;
}
function rulePanel(r) {
  const any = r.daily_loss_limit || r.max_drawdown_limit || r.profit_target || r.max_trades_per_day;
  let h = `<div class="card-h"><h2>Risk rules</h2><a class="btn sm" href="#/settings">Edit</a></div>`;
  if (!any) return h + `<div class="empty"><b>No limits set</b>Add a daily loss limit, max drawdown or profit target (useful for prop-firm challenges) in Settings.</div>`;
  h += `<div class="muted" style="margin-bottom:12px">Today (${r.today}): <b class="${cls(r.today_net)} num">${money(r.today_net)}</b> over ${r.today_trades} trades</div>`;
  if (r.daily_loss_limit) h += meter("Daily loss used", Math.max(-r.today_net, 0), r.daily_loss_limit);
  if (r.max_drawdown_limit) h += meter("Drawdown from peak", r.current_drawdown, r.max_drawdown_limit);
  if (r.profit_target) h += meter("Progress to target", Math.max(r.total_net, 0), r.profit_target, true);
  if (r.max_trades_per_day) {
    const over = r.today_trades >= r.max_trades_per_day;
    h += `<div class="meter"><div class="lbl"><span>Trades today</span><span class="num ${over ? "neg" : ""}">${r.today_trades} / ${r.max_trades_per_day}</span></div>
      <div class="track"><b style="width:${Math.min(r.today_trades / r.max_trades_per_day, 1) * 100}%;background:${over ? C.neg : C.accent}"></b></div></div>`;
  }
  return h;
}
function renderRuleBanner(r) {
  const msgs = [];
  if (r.daily_loss_limit && -r.today_net >= r.daily_loss_limit) msgs.push(["bad", `Daily loss limit hit: ${money(r.today_net)} today (limit ${money(-r.daily_loss_limit)}). Step away from the screen.`]);
  else if (r.daily_loss_limit && -r.today_net >= r.daily_loss_limit * 0.75) msgs.push(["warn", `You've used ${pct(-r.today_net / r.daily_loss_limit, 0)} of today's loss limit.`]);
  if (r.max_drawdown_limit && r.current_drawdown >= r.max_drawdown_limit) msgs.push(["bad", `Max drawdown limit reached (${money(r.current_drawdown)}).`]);
  if (r.max_trades_per_day && r.today_trades > r.max_trades_per_day) msgs.push(["warn", `Over your trade limit: ${r.today_trades} trades today (max ${r.max_trades_per_day}).`]);
  if (r.profit_target && r.total_net >= r.profit_target) msgs.push(["ok", `Profit target reached: ${money(r.total_net)}.`]);
  $("#banner").innerHTML = msgs.map(([k, m]) => `<div class="alert ${k}">${esc(m)}</div>`).join("");
}
function positionsTable(pos) {
  if (!pos.length) return `<div class="empty">No open positions${S.mt5 === false ? " (MT5 not connected)" : ""}.</div>`;
  return `<div class="tbl-wrap"><table><thead><tr><th>Symbol</th><th>Side</th><th class="r">Vol</th><th class="r">Entry</th><th class="r">Price</th><th class="r">SL</th><th class="r">P&amp;L</th></tr></thead><tbody>
    ${pos.map((p) => `<tr><td><b>${esc(p.symbol)}</b></td><td>${sideBadge(p.direction)}</td><td class="r num">${p.volume}</td><td class="r num">${price(p.entry_price)}</td><td class="r num">${price(p.price)}</td><td class="r num">${price(p.sl)}</td><td class="r num ${cls(p.profit)}">${money(p.profit)}</td></tr>`).join("")}
  </tbody></table></div>`;
}

/* ------------------------------------------------------------ calendar */
async function renderCalendar(el, month) {
  const p = new URLSearchParams(qs()); p.delete("from"); p.delete("to"); p.set("month", month);
  const d = await api("/api/calendar?" + p);
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // monday first
  const today = iso(serverNow());
  const notes = new Set(d.notes);
  let cells = "", week = { net: 0, trades: 0, days: 0 }, wk = 1;
  const flushWeek = () => {
    cells += `<div class="cell wk"><div class="d">Week ${wk++}</div><div class="p ${cls(week.net)}">${week.trades ? money(week.net) : ""}</div><div class="n">${week.trades ? `${week.days} days · ${week.trades} trades` : ""}</div></div>`;
    week = { net: 0, trades: 0, days: 0 };
  };
  for (let i = 0; i < lead; i++) cells += `<div class="cell out"></div>`;
  for (let day = 1; day <= days; day++) {
    const ds = `${month}-${String(day).padStart(2, "0")}`;
    const x = d.days[ds];
    const k = x ? (x.net > 0 ? "win" : x.net < 0 ? "loss" : "flat") : notes.has(ds) ? "flat" : "";
    if (x) { week.net += x.net; week.trades += x.trades; week.days++; }
    cells += `<div class="cell ${k} ${ds === today ? "today" : ""}" ${k ? `data-day="${ds}"` : ""}>
      <div class="d"><span>${day}</span>${notes.has(ds) ? '<span class="note-dot" title="Journal note"></span>' : ""}</div>
      ${x ? `<div class="p ${cls(x.net)}">${money(x.net)}</div><div class="n">${x.trades} trade${x.trades > 1 ? "s" : ""} · ${pct(x.wins / Math.max(x.wins + x.losses, 1), 0)}</div>` : ""}
    </div>`;
    if ((lead + day) % 7 === 0) flushWeek();
  }
  const tail = (lead + days) % 7;
  if (tail) { for (let i = tail; i < 7; i++) cells += `<div class="cell out"></div>`; flushWeek(); }
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  el.innerHTML = `<div class="card-h"><div class="row"><button class="btn sm" data-m="${prev}">‹</button><h2>${MON[m - 1]} ${y}</h2><button class="btn sm" data-m="${next}">›</button></div>
    <span class="muted">Month: <b class="${cls(d.summary.net)} num">${money(d.summary.net)}</b> · ${d.summary.days} days · ${d.summary.trades} trades</span></div>
    <div class="cal">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Week"].map((x) => `<div class="dow">${x}</div>`).join("")}${cells}</div>`;
  $$("[data-m]", el).forEach((b) => b.addEventListener("click", () => renderCalendar(el, b.dataset.m)));
  $$("[data-day]", el).forEach((c) => c.addEventListener("click", () => (location.hash = `#/day/${c.dataset.day}`)));
}

/* ------------------------------------------------------------ journal */
const MOODS = ["😣", "😕", "😐", "🙂", "😄"];
function dayCard(day) {
  const s = day.summary, j = day.journal || {};
  return `<div class="card day-card" data-date="${day.date}">
    <div class="day-h">
      <a class="date" href="#/day/${day.date}">${dayLabel(day.date)}</a>
      <span class="num ${cls(s.net)}" style="font-weight:600;font-size:15px">${s.trades ? money(s.net) : '<span class="faint">No trades</span>'}</span>
      ${j.mood ? `<span title="Mood">${MOODS[j.mood - 1]}</span>` : ""}
      <div class="day-metrics">
        <div>Trades<b>${s.trades}</b></div><div>Win %<b>${pct(s.win_rate, 0)}</b></div>
        <div>Winners / losers<b>${s.wins} / ${s.losses}</b></div><div>Profit factor<b>${pf(s)}</b></div>
        <div>Fees<b>${money(s.commission)}</b></div><div>R<b>${rr(s.total_r)}</b></div>
      </div>
    </div>
    <div class="day-body">
      <div>${s.trades > 1 ? `<div class="chart-box short"><canvas class="dayEq"></canvas></div>` : ""}
        <div class="row" style="margin-top:10px"><button class="btn sm noteBtn">${j.plan || j.plan_ny || j.review ? "✎ Edit notes" : "＋ Add notes"}</button></div>
        ${j.plan || j.plan_ny || j.review ? `<div class="muted" style="margin-top:10px;white-space:pre-wrap;font-size:13px;max-height:120px;overflow:hidden">${esc((j.plan ? "London plan: " + j.plan + "\n" : "") + (j.plan_ny ? "New York plan: " + j.plan_ny + "\n" : "") + (j.review ? "Review: " + j.review : ""))}</div>` : ""}
      </div>
      <div>${s.trades ? tradesTable(day.trades, { compact: false }) : ""}</div>
    </div>
  </div>`;
}
function bindDayCards(days) {
  $$(".day-card").forEach((el) => {
    const day = days.find((d) => d.date === el.dataset.date);
    const cv = $(".dayEq", el);
    if (cv) equityChart(cv, day.curve, { compact: true });
    $(".noteBtn", el).addEventListener("click", () => noteEditor(day.date));
    bindTradeRows(el);
  });
}
async function noteEditor(date, inline) {
  const j = await api(`/api/journal/${date}?account=${S.f.account || 0}`);
  const html = `<div class="card-h"><h2>${dayLabel(date)}</h2>${inline ? '<span class="saved" id="jSaved">Saved</span>' : ""}</div>
    <label class="field"><span>London session plan</span><textarea id="jPlan" placeholder="Bias, key levels, news, what you will and won't trade…">${esc(j.plan)}</textarea></label>
    <label class="field"><span>New York session plan</span><textarea id="jPlanNy" placeholder="Bias, key levels, news, what you will and won't trade…">${esc(j.plan_ny)}</textarea></label>
    <label class="field"><span>End-of-day review</span><textarea id="jReview" placeholder="What went well, what didn't, what to change tomorrow…">${esc(j.review)}</textarea></label>
    <label class="field"><span>How did you feel?</span><div class="mood" id="jMood">${MOODS.map((m, i) => `<button type="button" data-v="${i + 1}" class="${j.mood === i + 1 ? "on" : ""}">${m}</button>`).join("")}</div></label>
    ${inline ? "" : `<div class="row end"><button class="btn" id="jCancel">Cancel</button><button class="btn primary" id="jSave">Save</button></div>`}`;
  const root = inline || $("#modalBox");
  if (inline) inline.innerHTML = html; else modal(html);
  let mood = j.mood;
  const save = async () => {
    await api(`/api/journal/${date}`, { method: "PUT", body: { account: S.f.account || 0, plan: $("#jPlan", root).value, plan_ny: $("#jPlanNy", root).value, review: $("#jReview", root).value, mood } });
    if (inline) { const s = $("#jSaved"); s.classList.add("show"); setTimeout(() => s.classList.remove("show"), 1200); }
  };
  $$("#jMood button", root).forEach((b) => b.addEventListener("click", () => {
    mood = mood === +b.dataset.v ? null : +b.dataset.v;
    $$("#jMood button", root).forEach((x) => x.classList.toggle("on", +x.dataset.v === mood));
    if (inline) save();
  }));
  if (inline) {
    const ds = debounce(save, 700);
    ["#jPlan", "#jPlanNy", "#jReview"].forEach((id) => $(id, root).addEventListener("input", ds));
  } else {
    $("#jCancel").onclick = closeModal;
    $("#jSave").onclick = async () => { await save(); closeModal(); toast("Notes saved"); route(true); };
  }
}
async function renderJournal() {
  let offset = 0;
  const limit = 15;
  const d = await api(`/api/days?${qs({ limit, offset })}`);
  let all = d.days;
  if (!all.length) { view().innerHTML = `<div class="empty card"><b>No trading days yet</b>Sync MT5 or widen the date range.</div>`; return; }
  view().innerHTML = `<div class="row" style="margin-bottom:14px"><button class="btn" id="todayNote">＋ Note for today</button><span class="spacer"></span><span class="muted">${d.total} days</span></div>
    <div class="stack" id="days">${all.map(dayCard).join("")}</div>
    <div class="row" style="justify-content:center;margin-top:16px">${d.total > limit ? `<button class="btn" id="more">Load more days</button>` : ""}</div>`;
  bindDayCards(all);
  $("#todayNote").onclick = () => noteEditor(iso(serverNow()));
  const more = $("#more");
  if (more) more.onclick = async () => {
    offset += limit;
    const n = await api(`/api/days?${qs({ limit, offset })}`);
    const tmp = document.createElement("div");
    tmp.innerHTML = n.days.map(dayCard).join("");
    const fresh = [...tmp.children];
    fresh.forEach((c) => $("#days").appendChild(c));
    all = all.concat(n.days);
    fresh.forEach((el) => {
      const day = n.days.find((x) => x.date === el.dataset.date);
      const cv = $(".dayEq", el);
      if (cv) equityChart(cv, day.curve, { compact: true });
      $(".noteBtn", el).addEventListener("click", () => noteEditor(day.date));
      bindTradeRows(el);
    });
    if (offset + limit >= n.total) more.remove();
  };
}
async function renderDay(date) {
  $("#pageTitle").textContent = dayLabel(date);
  const p = new URLSearchParams(qs()); p.set("from", date); p.set("to", date);
  const d = await api(`/api/days?${p}`);
  const day = d.days[0] || { date, summary: (await api(`/api/trades?${p}`)).summary, trades: [], curve: [], journal: null };
  const prev = new Date(date + "T00:00:00Z"); prev.setUTCDate(prev.getUTCDate() - 1);
  const next = new Date(date + "T00:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
  const s = day.summary;
  view().innerHTML = `<div class="row" style="margin-bottom:14px">${FROM_WEEKLY ? `<a class="btn" href="#/reports">← Review</a>` : ""}<a class="btn" href="#/day/${iso(prev)}">‹ ${iso(prev)}</a><a class="btn" href="#/day/${iso(next)}">${iso(next)} ›</a><span class="spacer"></span><a class="btn" href="#/journal">All days</a></div>
    <div class="stack">${statCards(s)}
      <div class="grid g-2e"><div class="card"><div class="card-h"><h2>Intraday P&amp;L</h2></div><div class="chart-box">${s.trades ? '<canvas id="deq"></canvas>' : '<div class="empty">No trades this day</div>'}</div></div>
        <div class="card" id="inlineNote"></div></div>
      <div class="card"><div class="card-h"><h2>Trades</h2></div>${tradesTable([...day.trades].reverse())}</div></div>`;
  if (s.trades) equityChart($("#deq"), [{ time: day.trades[0].open_time, value: 0 }, ...day.curve]);
  bindTradeRows(view());
  noteEditor(date, $("#inlineNote"));
}

/* ------------------------------------------------------------ trades list */
const TF = { symbol: "", direction: "", result: "", playbook: "", tag: "" };
async function renderTrades() {
  const d = await api("/api/trades?" + qs(TF));
  const s = d.summary;
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? "selected" : ""}>${esc(l)}</option>`;
  view().innerHTML = `<div class="stack">
    <div class="card"><div class="row">
      <select data-k="symbol">${opt("", "All symbols", TF.symbol)}${S.symbols.map((x) => opt(x, x, TF.symbol)).join("")}</select>
      <select data-k="direction">${opt("", "Long & short", TF.direction)}${opt("long", "Long", TF.direction)}${opt("short", "Short", TF.direction)}</select>
      <select data-k="result">${opt("", "All results", TF.result)}${opt("win", "Winners", TF.result)}${opt("loss", "Losers", TF.result)}${opt("be", "Break-even", TF.result)}</select>
      <select data-k="playbook">${opt("", "All playbooks", TF.playbook)}${S.playbooks.map((p) => opt(p.id, p.name, TF.playbook)).join("")}</select>
      <select data-k="tag">${opt("", "All tags", TF.tag)}${S.tags.map((g) => opt(g.id, `${g.kind}: ${g.name}`, TF.tag)).join("")}</select>
      <span class="spacer"></span>
      <a class="btn" href="/api/export.csv?${qs(TF)}">⤓ Export CSV</a>
    </div>
    <div class="row muted" style="margin-top:12px;gap:22px;font-size:13px">
      <span>${s.trades} trades</span><span>Net <b class="num ${cls(s.net)}">${money(s.net)}</b></span><span>Win % <b class="num">${pct(s.win_rate)}</b></span>
      <span>PF <b class="num">${pf(s)}</b></span><span>Avg <b class="num">${money(s.expectancy)}</b></span><span>Total <b class="num">${rr(s.total_r)}</b></span>
    </div></div>
    <div class="card" id="bulk" hidden><div class="row"><b id="bulkN"></b>
      <select id="bulkPb"><option value="">Assign playbook…</option><option value="0">(none)</option>${S.playbooks.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select>
      <select id="bulkTag"><option value="">Add tag…</option>${S.tags.map((g) => `<option value="${g.id}">${g.kind}: ${esc(g.name)}</option>`).join("")}</select>
      <button class="btn" id="bulkRev">Mark reviewed</button></div></div>
    <div class="card">${tradesTable(d.trades, { select: true })}</div></div>`;
  $$("select[data-k]").forEach((sel) => sel.addEventListener("change", () => { TF[sel.dataset.k] = sel.value; route(true); }));
  bindTradeRows(view());
  const picked = () => $$(".sel:checked").map((x) => +x.value);
  const upd = () => { const n = picked().length; $("#bulk").hidden = !n; $("#bulkN").textContent = `${n} selected`; };
  $$(".sel").forEach((x) => x.addEventListener("change", upd));
  const all = $("#selAll");
  if (all) all.addEventListener("change", () => { $$(".sel").forEach((x) => (x.checked = all.checked)); upd(); });
  const bulk = async (body) => { await api("/api/trades/bulk", { method: "POST", body: { ids: picked(), ...body } }); toast("Updated"); route(true); };
  $("#bulkPb").onchange = (e) => e.target.value !== "" && bulk({ playbook_id: +e.target.value || null });
  $("#bulkTag").onchange = (e) => e.target.value && bulk({ add_tags: [+e.target.value] });
  $("#bulkRev").onclick = () => bulk({ reviewed: true });
}

/* ------------------------------------------------------------ single trade */
async function renderTrade(id) {
  const t = await api(`/api/trades/${id}`);
  $("#pageTitle").textContent = `${t.symbol} · ${dt(t.close_time, true)}`;
  const gross = t.profit;
  const risk = t.manual_risk || t.risk;
  const pbs = S.playbooks.filter((p) => !p.archived || p.id === t.playbook_id);
  view().innerHTML = `
  <div class="trade-head">
    <a class="btn" href="${FROM_WEEKLY ? "#/reports" : "#/trades"}">← ${FROM_WEEKLY ? "Review" : "Trades"}</a>
    <span class="sym">${esc(t.symbol)}</span>${sideBadge(t.direction)} ${(t.tilt || []).map((x) => `<span class="chip mistake">${esc(x)}</span>`).join(" ")}
    <span class="big ${cls(t.net)}">${money(t.net)}</span><span class="num ${cls(t.r)}">${rr(t.r)}</span>
    <span class="spacer"></span>
    <button class="btn" id="tradePdf" title="Opens this trade as a document. In the print window choose Save as PDF.">⤓ Save as PDF</button>
    <label class="check" style="padding:0"><input type="checkbox" id="rev" ${t.reviewed ? "checked" : ""}> Reviewed</label>
    <a class="btn ${t.prev_id ? "" : "disabled"}" ${t.prev_id ? `href="#/trade/${t.prev_id}"` : ""}>‹ Prev</a>
    <a class="btn ${t.next_id ? "" : "disabled"}" ${t.next_id ? `href="#/trade/${t.next_id}"` : ""}>Next ›</a>
  </div>
  <div class="trade-layout">
    <div class="stack">
      <div class="card"><dl class="kv">
        <dt>Account</dt><dd>${t.account}</dd><dt>Position</dt><dd>#${t.position_id}</dd>
        <dt>Opened</dt><dd>${dt(t.open_time)}</dd><dt>Closed</dt><dd>${dt(t.close_time)}</dd>
        <dt>Hold time</dt><dd>${dur(t.close_time - t.open_time)}</dd><dt>Volume</dt><dd>${t.volume} lots</dd>
        <dt>Entry</dt><dd>${price(t.entry_price)}</dd><dt>Exit</dt><dd>${price(t.exit_price)}</dd>
        <dt>Stop loss</dt><dd>${price(t.sl)}</dd><dt>Take profit</dt><dd>${price(t.tp)}</dd>
        <dt>Exit reason</dt><dd>${esc(t.exit_reason || "—")}</dd>
        <dt>Moved SL</dt><dd class="${t.moved_sl === "AGAINST" ? "neg" : ""}">${esc(t.moved_sl || "—")}</dd>
        <dt>Gross P&amp;L</dt><dd class="${cls(gross)}">${money(gross)}</dd>
        <dt>Commission</dt><dd>${money(t.commission + (t.fee || 0))}</dd><dt>Swap</dt><dd>${money(t.swap)}</dd>
        <dt>Planned risk</dt><dd>${money(risk)}</dd>
        <dt>MAE</dt><dd class="neg">${money(t.mae)}</dd><dt>MFE</dt><dd class="pos">${money(t.mfe)}</dd>
        ${t.mfe ? `<dt>Captured of MFE</dt><dd>${t.net > 0 ? pct(t.net / t.mfe, 0) : "—"}</dd>` : ""}
        ${t.comment ? `<dt>MT5 comment</dt><dd>${esc(t.comment)}</dd>` : ""}
      </dl>
      <label class="field" style="margin:14px 0 0"><span>Override risk (${cur()})</span>
        <input type="number" step="0.01" id="mRisk" value="${t.manual_risk ?? ""}" placeholder="${t.risk ? num(t.risk) + " from SL" : "No SL — enter what you risked"}" style="width:100%">
        <small>Used for R-multiples. Leave empty to use the initial stop loss.</small></label>
      </div>
      <div class="card"><div class="card-h"><h2>Playbook</h2></div>
        <select id="pb" style="width:100%"><option value="">No playbook</option>${pbs.map((p) => `<option value="${p.id}" ${p.id === t.playbook_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
        <div id="rules"></div></div>
      <div class="card"><div class="card-h"><h2>Rating</h2></div><div class="stars-input" id="rating">${[1, 2, 3, 4, 5].map((i) => `<span data-v="${i}" class="${(t.rating || 0) >= i ? "on" : ""}">★</span>`).join("")}</div></div>
    </div>
    <div class="stack">
      <div class="card"><div class="card-h"><h2>Chart</h2><div class="seg" id="tfSeg">${["auto", "M1", "M5", "M15", "H1", "H4", "D1"].map((x) => `<button data-tf="${x}" class="${x === "auto" ? "on" : ""}">${x}</button>`).join("")}</div></div>
        <div id="tvChart"><div class="loading">Loading chart from MT5…</div></div>
        <div class="tv-credit">Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a> Lightweight Charts™</div></div>
      <div class="card"><div class="card-h"><h2>Tags</h2><button class="btn sm" id="newTag">＋ New tag</button></div><div id="tags"></div></div>
      <div class="chart-pair">${chartBoxHtml("boxPlan", "Plan chart", `<textarea id="planNotes" rows="4" style="margin-top:10px" placeholder="Plan note: what was the plan before the trade?">${esc(t.plan_notes)}</textarea>`, `<span class="saved" id="pSaved">Saved</span>`)}${chartBoxHtml("boxResult", "Result chart", `<textarea id="resultNotes" rows="4" style="margin-top:10px" placeholder="Result note: what happened? What does the chart show after?">${esc(t.result_notes)}</textarea>`, `<span class="saved" id="rSaved">Saved</span>`)}</div>
    </div>
  </div>`;

  const patch = async (body, msg) => {
    const n = await api(`/api/trades/${id}`, { method: "PATCH", body });
    Object.assign(t, n);
    if (msg) toast(msg);
    return n;
  };
  // rules checklist
  const drawRules = () => {
    const rules = t.playbook_rules || [];
    if (!t.playbook_id) { $("#rules").innerHTML = ""; return; }
    if (!rules.length) { $("#rules").innerHTML = `<div class="muted" style="margin-top:10px">This playbook has no rules yet.</div>`; return; }
    const req = rules.map((r, i) => i).filter((i) => (rules[i].group || "").trim().toLowerCase() !== "optional");  // Optional rules are not scored
    const n = t.rules_followed.filter((i) => req.includes(i)).length, all = t.rules_followed.length === rules.length;
    let last = null, h = `<div class="row" style="margin-top:12px"><b>Rules followed</b><span class="spacer"></span><a href="#" id="rulesAll" style="font-size:12px">${all ? "UNCHECK ALL" : "CHECK ALL"}</a></div>
      <div class="row" style="margin-top:6px"><div class="progress" style="flex:1"><b style="width:${req.length ? (n / req.length) * 100 : 0}%"></b></div><span class="num">${n} / ${req.length}</span></div>`;
    rules.forEach((r, i) => {
      if (r.group && r.group !== last) { h += `<div class="rules-group">${esc(r.group)}</div>`; last = r.group; }
      h += `<label class="check"><input type="checkbox" data-i="${i}" ${t.rules_followed.includes(i) ? "checked" : ""}><span>${esc(r.text)}</span></label>`;
    });
    $("#rules").innerHTML = h;
    $("#rulesAll").onclick = async (e) => {
      e.preventDefault();
      await patch({ rules_followed: all ? [] : rules.map((_, i) => i) });
      drawRules();
    };
    $$("#rules input").forEach((cb) => cb.addEventListener("change", async () => {
      const followed = $$("#rules input:checked").map((x) => +x.dataset.i);
      await patch({ rules_followed: followed });
      drawRules();
    }));
  };
  drawRules();
  $("#pb").onchange = async (e) => { await patch({ playbook_id: e.target.value ? +e.target.value : null }); drawRules(); };
  // rating
  $$("#rating span").forEach((s) => s.addEventListener("click", async () => {
    const v = +s.dataset.v === t.rating ? null : +s.dataset.v;
    await patch({ rating: v });
    $$("#rating span").forEach((x) => x.classList.toggle("on", (v || 0) >= +x.dataset.v));
  }));
  $("#rev").onchange = (e) => patch({ reviewed: e.target.checked ? 1 : 0 }, e.target.checked ? "Marked reviewed" : null);
  $("#mRisk").onchange = async (e) => { await patch({ manual_risk: e.target.value === "" ? null : +e.target.value }, "Risk updated"); route(true); };
  // tags
  const drawTags = () => {
    const on = new Set(t.tags.map((g) => g.id));
    const groups = { setup: "Setups", mistake: "Mistakes", custom: "Custom" };
    $("#tags").innerHTML = Object.entries(groups).map(([k, l]) => `<div class="rules-group">${l}</div><div>${S.tags.filter((g) => g.kind === k).map((g) => `<span class="chip toggle ${k} ${on.has(g.id) ? "on" : ""}" data-id="${g.id}">${on.has(g.id) ? "✓ " : ""}${esc(g.name)}</span>`).join("") || '<span class="faint">none</span>'}</div>`).join("");
    $$("#tags .chip").forEach((c) => c.addEventListener("click", async () => {
      const gid = +c.dataset.id;
      const ids = on.has(gid) ? [...on].filter((x) => x !== gid) : [...on, gid];
      await patch({ tags: ids });
      drawTags();
    }));
  };
  drawTags();
  $("#newTag").onclick = () => {
    modal(`<h2 style="margin-bottom:14px">New tag</h2>
      <label class="field"><span>Name</span><input type="text" id="tgName" style="width:100%" autofocus></label>
      <label class="field"><span>Type</span><select id="tgKind" style="width:100%"><option value="setup">Setup</option><option value="mistake">Mistake</option><option value="custom">Custom</option></select></label>
      <div class="row end"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" id="tgSave">Create &amp; apply</button></div>`);
    $("#tgName").focus();
    $("#tgSave").onclick = async () => {
      const name = $("#tgName").value.trim();
      if (!name) return;
      const g = await api("/api/tags", { method: "POST", body: { name, kind: $("#tgKind").value } });
      S.tags = await api("/api/tags");
      await patch({ tags: [...new Set([...t.tags.map((x) => x.id), g.id])] });
      closeModal(); drawTags();
    };
  };
  // charts
  mountChartBox("boxPlan", t.plan_charts, `/api/setups/${t.position_id}/charts`, (c) => `/api/setup_charts/${c}`, (r) => r.charts);
  mountChartBox("boxResult", t.screenshots, `/api/trades/${id}/screenshots`, (c) => `/api/screenshots/${c}`, (r) => r.screenshots)();
  const savePlan = debounce(async () => {
    await api(`/api/setups/${t.position_id}`, { method: "PATCH", body: { notes: $("#planNotes").value } });
    const el = $("#pSaved"); el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 1200);
  }, 700);
  $("#planNotes").addEventListener("input", savePlan);
  const saveResult = debounce(async () => {
    await patch({ result_notes: $("#resultNotes").value });
    const el = $("#rSaved"); el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 1200);
  }, 700);
  $("#resultNotes").addEventListener("input", saveResult);
  // one-page document of this trade; the browser's print window saves it as PDF
  $("#tradePdf").onclick = () => {
    const rules = t.playbook_rules || [], ticked = new Set(t.rules_followed || []);
    const para = (v) => (v || "").trim() ? `<p>${esc(v.trim()).replace(/\n/g, "<br>")}</p>` : `<p class="none">No note.</p>`;
    const pics = (list) => list.length ? list.map((x) => `<img src="${location.origin}/uploads/${esc(x.filename)}">`).join("") : `<p class="none">No chart.</p>`;
    const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
    let mt5 = "";
    try { if (S.tv) mt5 = `<h2>MT5 chart</h2><img src="${S.tv.takeScreenshot().toDataURL()}">`; } catch (e) { /* chart not loaded */ }
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.symbol)} ${t.direction} ${dt(t.close_time, true)}</title><style>
      body{font-family:Calibri,Arial,sans-serif;color:#111;max-width:780px;margin:24px auto;padding:0 20px;font-size:14px;line-height:1.5}
      h1{font-size:22px;margin:0 0 2px}h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #999;padding-bottom:3px}
      .sub{color:#555;margin-bottom:14px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:3px 8px;border-bottom:1px solid #ddd;font-size:13px}
      th{width:160px;color:#555;font-weight:normal}img{max-width:100%;margin:6px 0;border:1px solid #ccc}.none{color:#888}
      .cols{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}h2,img{break-after:avoid}img{break-inside:avoid}p{margin:6px 0}
      </style></head><body>
      <h1>${esc(t.symbol)} ${t.direction} &nbsp; ${money(t.net)} &nbsp; ${rr(t.r)}</h1>
      <div class="sub">Account ${t.account} · Position #${t.position_id} · Closed ${dt(t.close_time, true)}</div>
      <div class="cols"><table>
        ${row("Opened", dt(t.open_time, true))}${row("Closed", dt(t.close_time, true))}${row("Hold time", dur(t.close_time - t.open_time))}
        ${row("Volume", t.volume + " lots")}${row("Entry", price(t.entry_price))}${row("Exit", price(t.exit_price))}
        ${row("Stop loss", price(t.sl))}${row("Take profit", price(t.tp))}</table><table>
        ${row("Exit reason", esc(t.exit_reason || "—"))}${row("Moved SL", esc(t.moved_sl || "—"))}
        ${row("Planned risk", money(t.manual_risk || t.risk))}${row("Gross P&amp;L", money(t.profit))}
        ${row("Commission + swap", money(t.commission + (t.fee || 0) + t.swap))}${row("MAE / MFE", money(t.mae) + " / " + money(t.mfe))}
        ${row("Rating", t.rating ? "★".repeat(t.rating) + "☆".repeat(5 - t.rating) : "—")}${row("Reviewed", t.reviewed ? "Yes" : "No")}</table></div>
      <h2>Playbook${t.playbook_name ? ": " + esc(t.playbook_name) : ""}</h2>
      ${rules.length ? rules.map((r, i) => `<div>${ticked.has(i) ? "☑" : "☐"} ${r.group ? `<span style="color:#555">${esc(r.group)}:</span> ` : ""}${esc(r.text || r.name || "")}</div>`).join("") : `<p class="none">No playbook rules.</p>`}
      <h2>Tags and flags</h2>
      <p>${t.tags.length ? t.tags.map((g) => `${esc(g.name)} (${g.kind})`).join(", ") : "No tags"}${(t.tilt || []).length ? `<br>Tilt flags: ${t.tilt.map(esc).join(", ")}` : ""}</p>
      <h2>Plan chart</h2>${pics(t.plan_charts)}${para($("#planNotes").value)}
      <h2>Result chart</h2>${pics(t.screenshots)}${para($("#resultNotes").value)}
      ${mt5}
      <script>window.onload = () => setTimeout(() => window.print(), 300);<\/script></body></html>`;
    const w = window.open("", "_blank");
    if (!w) { toast("The browser blocked the new window. Allow pop-ups for this page.", true); return; }
    w.document.write(html); w.document.close();
  };
  // chart
  const loadChart = async (tf) => {
    const box = $("#tvChart");
    if (S.tv) { S.tv.remove(); S.tv = null; }
    box.innerHTML = `<div class="loading">Loading chart from MT5…</div>`;
    try {
      const c = await api(`/api/trades/${id}/chart${tf && tf !== "auto" ? "?tf=" + tf : ""}`);
      if (!window.LightweightCharts) throw new Error("Chart library didn't load (needs internet the first time).");
      box.innerHTML = "";
      drawTradeChart(box, c, t);
    } catch (e) {
      box.innerHTML = `<div class="empty"><b>Chart unavailable</b>${esc(e.message)}</div>`;
    }
  };
  $$("#tfSeg button").forEach((b) => b.addEventListener("click", () => {
    $$("#tfSeg button").forEach((x) => x.classList.toggle("on", x === b)); loadChart(b.dataset.tf);
  }));
  loadChart();
}
function drawTradeChart(el, c, t) {
  const LW = window.LightweightCharts;
  const ch = LW.createChart(el, {
    height: 420, layout: { background: { color: "transparent" }, textColor: "#8b98a8", fontFamily: "Inter, system-ui" },
    grid: { vertLines: { color: "#1c242e" }, horzLines: { color: "#1c242e" } },
    rightPriceScale: { borderColor: "#262f3b" }, timeScale: { borderColor: "#262f3b", timeVisible: true },
    crosshair: { mode: 0 },
  });
  S.tv = ch;
  const prec = c.digits ?? 5;
  const s = ch.addCandlestickSeries({ upColor: "#22c55e", downColor: "#f05252", borderVisible: false, wickUpColor: "#22c55e", wickDownColor: "#f05252", priceFormat: { type: "price", precision: prec, minMove: 1 / 10 ** prec } });
  s.setData(c.candles);
  const snap = (ts) => { let best = c.candles[0].time; for (const k of c.candles) { if (k.time <= ts) best = k.time; else break; } return best; };
  const long = t.direction === "long";
  s.setMarkers([
    { time: snap(t.open_time), position: long ? "belowBar" : "aboveBar", color: "#5b8def", shape: long ? "arrowUp" : "arrowDown", text: `${long ? "Buy" : "Sell"} ${t.volume} @ ${price(t.entry_price)}` },
    { time: snap(t.close_time), position: long ? "aboveBar" : "belowBar", color: t.net >= 0 ? "#22c55e" : "#f05252", shape: long ? "arrowDown" : "arrowUp", text: `Exit @ ${price(t.exit_price)}` },
  ].sort((a, b) => a.time - b.time));
  s.createPriceLine({ price: t.entry_price, color: "#5b8def", lineWidth: 1, lineStyle: 2, title: "Entry" });
  if (t.sl) s.createPriceLine({ price: t.sl, color: "#f05252", lineWidth: 1, lineStyle: 2, title: "SL" });
  if (t.tp) s.createPriceLine({ price: t.tp, color: "#22c55e", lineWidth: 1, lineStyle: 2, title: "TP" });
  ch.timeScale().fitContent();
  new ResizeObserver(() => ch.applyOptions({ width: el.clientWidth })).observe(el);
}

/* ------------------------------------------------------------ reports */
let REPORT = "overview";
/* ------------------------------------------------------------ AI review */
async function reportAI() {
  const p = await api("/api/ai_review?" + qs());
  const saved = localStorage.getItem("aiModel");
  const opt = (m) => `<option value="${esc(m.id)}" ${m.id === saved ? "selected" : ""}>${esc(m.label)}</option>`;
  const local = p.models.filter((m) => m.local), outside = p.models.filter((m) => !m.local);
  $("#rep").innerHTML = `<div class="stack">
    <div class="card"><div class="card-h"><h2>AI Review</h2></div>
      <p class="muted">Sends ${p.trades} trades (the account and dates picked at the top) to the AI you choose and asks for patterns.
      Sent: date, session, symbol, side, R result, hold time, exit reason, moved stop, rating, playbook, tags, tilt flags.
      Never sent: account number, balance, dollar amounts, lot size, prices, notes, screenshots.
      The answer is a guide, not proof and not financial advice.</p>
      <details style="margin:10px 0"><summary class="muted">See exactly what will be sent</summary><pre style="white-space:pre-wrap;font-size:12px;max-height:300px;overflow:auto">${esc(p.prompt)}</pre></details>
      <label class="field"><span>Which AI reads the trades</span><select id="aiModel">
        ${local.length ? `<optgroup label="Local AI: stays on this PC">${local.map(opt).join("")}</optgroup>` : ""}
        <optgroup label="OmniRoute: goes to outside AI companies">${outside.map(opt).join("")}</optgroup></select>
        <small id="aiWhere"></small></label>
      <button class="btn primary" id="aiGo" style="margin-top:10px" ${p.trades ? "" : "disabled"}>Review these trades</button></div>
    <div class="card" id="aiOut" hidden></div></div>`;
  const where = () => {
    const isLocal = $("#aiModel").value.startsWith("local:");
    $("#aiWhere").textContent = isLocal ? "Private: nothing leaves this PC. Slower (can take a few minutes)."
      : "The trade list above is sent to outside AI companies, which may keep it.";
  };
  where();
  $("#aiModel").addEventListener("change", () => { localStorage.setItem("aiModel", $("#aiModel").value); where(); });
  $("#aiGo").addEventListener("click", async () => {
    const b = $("#aiGo"), out = $("#aiOut");
    b.disabled = true; b.textContent = "Asking the AI…";
    out.hidden = false; out.innerHTML = `<p class="muted">Waiting for the answer…</p>`;
    try {
      const r = await api("/api/ai_review?" + qs({ model: $("#aiModel").value }), { method: "POST" });
      out.innerHTML = `<div class="card-h"><h2>Answer</h2><span class="muted">${esc(r.model)}</span></div><div style="white-space:pre-wrap;line-height:1.6">${esc(r.answer)}</div>`;
    } catch (e) {
      out.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`;
    }
    b.disabled = false; b.textContent = "Review these trades";
  });
}

/* ------------------------------------------------------------ weekly review */
let WEEK = "", PERIOD = "week", FROM_WEEKLY = false, WK_SCROLL = null;
async function reportWeekly() {
  const d = await api("/api/weekly?" + qs({ week: WEEK, period: PERIOD, from: "", to: "" }));
  const s = d.summary, p = d.prev;
  const add = (base, n) => { const x = new Date(base + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
  const shift = (n) => add(d.from, n);
  // words for the chosen period
  const isW = d.period === "week", is3 = d.period === "3m", unit = isW ? "week" : "month";
  const thisP = is3 ? "These 3 months" : `This ${unit}`, thisLow = thisP.toLowerCase();
  const lastP = is3 ? "The 3 months before" : `Last ${unit}`, beforeP = is3 ? "the 3 months before" : `the ${unit} before`;
  const vsP = is3 ? "vs the 3 months before" : `vs last ${unit}`, Adj = isW ? "Weekly" : is3 ? "3-month" : "Monthly";
  const day = (v) => { const x = new Date(v + "T00:00:00Z"); return `${MON[x.getUTCMonth()]} ${x.getUTCDate()}`; };
  const delta = (a, b, fmt) => a == null || b == null || !p.trades ? `<span class="faint">no trades ${beforeP}</span>`
    : `<span class="${cls(a - b)}">${a - b > 0 ? "▲" : a - b < 0 ? "▼" : "•"} ${fmt(Math.abs(a - b))}</span> <span class="faint">${vsP}</span>`;
  const card = (label, value, sub, c = "", how = []) => `<div class="card stat"><div class="label" style="justify-content:flex-start;gap:6px">${how.length ? `<span class="howBtn">ⓘ<span class="howPop"><b>How it is computed</b><br>${how.join("<br>")}</span></span>` : ""}<span style="flex:1;display:flex;justify-content:space-between;color:inherit">${label}</span></div><div class="value ${c}">${value}</div><div class="sub">${sub}</div></div>`;
  // the working behind each card, from the same numbers the cards use
  const had = p.trades > 0, sg = (v, f) => (v > 0 ? "+" : v < 0 ? "−" : "") + f(Math.abs(v));
  const wl = (x) => `${x.wins} wins ÷ ${x.wins + x.losses} decided trades = ${pct(x.win_rate)}`;
  const FULL = { "Win rate": "100 at 60% wins", "Profit factor": "100 at 2.5", "Avg win / loss": "100 at 2.0", "Drawdown": "biggest drop vs all winnings", "Recovery": "net ÷ biggest drop, 100 at 3", "Consistency": "profit not from one day" };
  const howNet = [`${thisP}: all ${s.trades} trades added up, after fees and swap = ${money(s.net)}`,
    ...(had ? [`${lastP}: ${p.trades} trades = ${money(p.net)}`, `Change: ${money(s.net)} − ${money(p.net)} = ${sg(s.net - p.net, money)}`] : [])];
  const howTrades = [`${thisP}: ${s.trades} = ${s.wins} wins + ${s.losses} losses + ${s.breakeven} breakeven`,
    ...(had ? [`${lastP}: ${p.trades} = ${p.wins} wins + ${p.losses} losses + ${p.breakeven} breakeven`, `Change: ${s.trades} − ${p.trades} = ${sg(s.trades - p.trades, (v) => v)}`] : [])];
  const howWin = [`Wins ÷ (wins + losses). Breakeven (within ±${S.settings.be_zone_r ?? 0}R) is not counted.`,
    s.win_rate == null ? `${thisP}: no decided trades` : `${thisP}: ${wl(s)}`,
    ...(had && p.win_rate != null && s.win_rate != null ? [`${lastP}: ${wl(p)}`, `Change: ${pct(s.win_rate)} − ${pct(p.win_rate)} = ${sg((s.win_rate - p.win_rate) * 100, (v) => v.toFixed(1))} pts (shown rounded)`] : [])];
  const rl = (x) => `${rr(x.total_r)} total ÷ ${x.r_count} trades = ${num(x.avg_r)}R`;
  const howR = [`Total R ÷ trades with a known risk. R = profit ÷ money risked at the stop loss.`,
    s.avg_r == null ? `${thisP}: no trade with a known risk` : `${thisP}: ${rl(s)}`,
    ...(had && p.avg_r != null && s.avg_r != null ? [`${lastP}: ${rl(p)}`, `Change: ${num(s.avg_r)} − ${num(p.avg_r)} = ${sg(s.avg_r - p.avg_r, (v) => num(v))}R`] : [])];
  const howOut = s.outcome_parts ? [`Average of 6 parts, each 0 to 100:`,
    ...s.outcome_parts.map((x) => `${esc(x.name)}: ${x.score} <span style="opacity:.7">(${FULL[x.name] || ""})</span>`),
    `(${s.outcome_parts.map((x) => x.score).join(" + ")}) ÷ 6 = ${s.edge_score}`,
    ...(had && p.edge_score != null ? [`${lastP}: ${p.edge_score}. Change: ${s.edge_score} − ${p.edge_score} = ${sg(s.edge_score - p.edge_score, (v) => v)} pts`] : [])] : [];
  const howProc = s.process_score == null ? [] : [
    `Rules: per trade, required playbook rules ticked ÷ required rules. Average of trades with ticks = ${s.rules_score ?? "—"}`,
    `Behavior: per trade, 100 − 25 for each tilt flag. Average = ${s.behaviour_score ?? "—"}`,
    `Process = average of the two = ${s.process_score} (${s.graded_trades} graded trades)`,
    ...(had && p.process_score != null ? [`${lastP}: ${p.process_score} (Rules ${p.rules_score ?? "—"}, Behavior ${p.behaviour_score ?? "—"}). Change: ${s.process_score} − ${p.process_score} = ${sg(s.process_score - p.process_score, (v) => v)} pts`] : [])];
  const pts = (v) => v.toFixed(0) + " pts";
  const hours = [...d.hours].sort((a, b) => b.net - a.net);
  const flags = [...d.flags].sort((a, b) => a.net - b.net);
  const weak = [...d.stages].sort((a, b) => a.followed / a.total - b.followed / b.total)[0];
  const look = [];
  if (hours.length > 1) look.push(`Best hour: <b>${ampm(+hours[0].key.slice(0, 2))}</b> (${money(hours[0].net)}, ${hours[0].trades} trades). Worst: <b>${ampm(+hours[hours.length - 1].key.slice(0, 2))}</b> (${money(hours[hours.length - 1].net)}, ${hours[hours.length - 1].trades} trades).`);
  if (flags.length) look.push(`Most common rule break: <b>${esc([...d.flags].sort((a, b) => b.trades - a.trades)[0].key)}</b>. Lowest result: <b>${esc(flags[0].key)}</b> (${money(flags[0].net)} on ${flags[0].trades} trades).`);
  if (weak && weak.followed < weak.total) look.push(`Weakest stage: <b>${esc(weak.stage)}</b>, ${weak.followed} of ${weak.total} rules ticked.`);
  if (s.graded_trades) look.push(`${s.graded_trades - s.tilt_trades} of ${s.graded_trades} trades were fully clean.`);
  const today = iso(new Date(Date.now() + (S.settings.display_utc_offset || 0) * 3600000));
  const sumOf = (list) => { const ts = list.flatMap((x) => x.trades); return { net: ts.reduce((a, t) => a + t.net, 0), n: ts.length, days: list.filter((x) => x.trades.length).length }; };
  const dayCell = (ds) => {
    const x = d.daily.find((y) => y.date === ds), n = x ? x.trades.length : 0;
    const w = x ? x.trades.filter((t) => t.net > 0).length : 0, l = x ? x.trades.filter((t) => t.net < 0).length : 0;
    return `<div class="cell wkGo ${n ? (x.net > 0 ? "win" : x.net < 0 ? "loss" : "flat") : "flat"} ${ds === today ? "today" : ""}" data-day="${ds}" title="Open this day's journal and trades">
      <div class="d"><span>${day(ds)}</span>${x && x.journal ? '<span class="note-dot" title="Journal note"></span>' : ""}</div>
      ${n ? `<div class="p ${cls(x.net)}">${money(x.net)}</div><div class="n">${n} trade${n > 1 ? "s" : ""} · ${pct(w / Math.max(w + l, 1), 0)}</div>` : ""}</div>`;
  };
  const sumCell = (label, t, attrs = "") => `<div class="cell wk" ${attrs}><div class="d"><span>${label}</span></div>${t.n ? `<div class="p ${cls(t.net)}">${money(t.net)}</div><div class="n">${t.days} day${t.days > 1 ? "s" : ""} · ${t.n} trade${t.n > 1 ? "s" : ""}</div>` : ""}</div>`;
  const tradeDays = d.daily.filter((x) => x.trades.length).length;
  // week of the month, counted like the dashboard calendar: rows start on Monday, Week 1 holds the 1st
  const mon = new Date(d.from + "T00:00:00Z"), first = new Date(Date.UTC(mon.getUTCFullYear(), mon.getUTCMonth(), 1));
  const weekNo = Math.floor(((first.getUTCDay() + 6) % 7 + mon.getUTCDate() - 1) / 7) + 1;
  const weekName = `Week ${weekNo} of ${MON[mon.getUTCMonth()]}`;
  const end = new Date(d.to + "T00:00:00Z");
  const title = isW ? weekName : is3 ? `${MON[mon.getUTCMonth()]} to ${MON[end.getUTCMonth()]} ${end.getUTCFullYear()}` : `${MON[mon.getUTCMonth()]} ${mon.getUTCFullYear()}`;
  let strip, hint = "Click a day to open its journal and review the trades you took.";
  if (isW) {
    strip = [0, 1, 2, 3, 4, 5, 6].map((i) => dayCell(shift(i))).join("") + sumCell(weekName, sumOf(d.daily));
  } else if (!is3) {  // month: one row per week, days outside the month left empty
    strip = ""; hint += " Click a week total to open that week.";
    for (let m = add(d.from, -((mon.getUTCDay() + 6) % 7)), k = 1; m <= d.to; m = add(m, 7), k++) {
      const days = [0, 1, 2, 3, 4, 5, 6].map((i) => add(m, i));
      strip += days.map((ds) => ds < d.from || ds > d.to ? `<div class="cell out"></div>` : dayCell(ds)).join("")
        + sumCell(`Week ${k}`, sumOf(d.daily.filter((x) => days.includes(x.date))), `data-week="${m}" style="cursor:pointer" title="Open this week"`);
    }
  } else {  // 3 months: one box per month
    hint = "Click a month to open its review.";
    strip = [0, 1, 2].map((k) => {
      const x = new Date(Date.UTC(mon.getUTCFullYear(), mon.getUTCMonth() + k, 1)), ym = iso(x).slice(0, 7);
      return sumCell(`${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`, sumOf(d.daily.filter((y) => y.date.startsWith(ym))), `data-month="${ym}-01" style="cursor:pointer" title="Open this month"`);
    }).join("");
  }
  const seg = `<div class="seg">${[["week", "Week"], ["month", "Month"], ["3m", "3 months"]].map(([k, l]) => `<button data-period="${k}" class="${k === d.period ? "on" : ""}">${l}</button>`).join("")}</div>`;
  $("#rep").innerHTML = `<div class="stack">
    <div class="row">${seg}<button class="btn" id="wkPrev">← Before</button><b style="font-size:16px">${title}</b><span class="muted">${day(d.from)} to ${day(d.to)}</span><button class="btn" id="wkNext">After →</button><span class="spacer"></span><button class="btn" id="wkNow">${is3 ? "Latest" : thisP}</button></div>
    <div class="card"><div class="cal" ${is3 ? 'style="grid-template-columns:repeat(3,1fr)"' : ""}>${is3 ? "" : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Week"].map((x) => `<div class="dow">${x}</div>`).join("")}${strip}</div>
      <div class="muted" style="font-size:12px;margin-top:8px">${hint}${s.trades && !isW ? ` Total: ${money(s.net)} over ${tradeDays} days and ${s.trades} trades.` : ""}</div></div>
    ${s.trades || d.daily.length || d.note ? `<div class="grid g-3">
      ${card("Net P&amp;L", money(s.net), delta(s.net, p.net, (v) => money(v)), cls(s.net), howNet)}
      ${card("Trades", s.trades, delta(s.trades, p.trades, (v) => v), "", howTrades)}
      ${card("Win %", pct(s.win_rate, 0), delta(s.win_rate, p.win_rate, (v) => (v * 100).toFixed(0) + " pts"), "", howWin)}
      ${card("Avg R per trade", s.avg_r == null ? "—" : num(s.avg_r) + "R", delta(s.avg_r, p.avg_r, (v) => num(v) + "R"), "", howR)}
      ${card("Outcome score", s.edge_score ?? "—", s.edge_score == null ? `<span class="faint">needs 5+ trades</span>` : delta(s.edge_score, p.edge_score, pts), "", howOut)}
      ${card(`Process score <span>Rules ${s.rules_score ?? "—"} · Behavior ${s.behaviour_score ?? "—"}</span>`, s.process_score ?? "—", delta(s.process_score, p.process_score, pts), "", howProc)}</div>
    <div class="card"><div class="card-h"><h2>What to look at</h2><span class="muted">Facts from ${thisLow} only.${isW ? " One week is a small sample." : ""}</span></div>
      ${look.length ? `<ul style="margin:0;padding-left:18px;line-height:1.9">${look.map((x) => `<li>${x}</li>`).join("")}</ul>` : `<div class="muted">Nothing stands out yet.</div>`}</div>
    <div class="card"><div class="card-h"><h2>AI ${Adj.toLowerCase()} review</h2><button class="btn" id="wkAiToggle">Show</button></div>
      <div id="wkAiBody" hidden></div></div>
    <div class="card"><div class="card-h"><h2>${Adj} reflection</h2><span class="saved" id="wkSaved">Saved</span></div>
      <textarea id="wkNote" rows="6" placeholder="What went well ${isW ? "this week" : thisLow}? What did I repeat? What is the one thing I will do differently next?">${esc(d.note)}</textarea></div>
    ${tiltExtras(d)}
    <div class="card"><div class="card-h"><h2>Rule breaks ${thisLow}</h2></div>${flags.length ? reportTable(flags, "Flag") : `<div class="empty">No flags ${thisLow}.</div>`}</div>
    <div class="card"><div class="card-h"><h2>By day</h2></div>${reportTable(d.days, "Day")}</div>
    <div class="card"><div class="card-h"><h2>By hour opened</h2></div>${reportTable(d.hours.map((r) => ({ ...r, key: ampm(+r.key.slice(0, 2)) })), "Hour")}</div>
    <div class="card"><div class="card-h"><h2>By playbook</h2></div>${reportTable(d.playbooks, "Playbook")}</div>` : `<div class="card"><div class="empty"><b>No trades ${thisLow}</b>Use the buttons above to look at another period.</div>
      <div class="card-h" style="margin-top:14px"><h2>${Adj} reflection</h2><span class="saved" id="wkSaved">Saved</span></div>
      <textarea id="wkNote" rows="5" placeholder="A period without trades can still have a reflection."></textarea></div>`}</div>`;
  $$(".wkGo").forEach((a) => a.addEventListener("click", () => {
    FROM_WEEKLY = true; WK_SCROLL = window.scrollY;
    if (a.dataset.day) location.hash = `#/day/${a.dataset.day}`;
  }));
  if (WK_SCROLL != null) { window.scrollTo(0, WK_SCROLL); WK_SCROLL = null; }
  const note = $("#wkNote");
  if (note) note.addEventListener("input", debounce(async () => {
    await api(`/api/weekly/${encodeURIComponent(d.key)}`, { method: "PUT", body: { account: S.f.account || 0, note: note.value } });
    const el = $("#wkSaved"); el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 1200);
  }, 700));
  if ($("#wkAiToggle")) $("#wkAiToggle").onclick = async () => {
    const body = $("#wkAiBody"), btn = $("#wkAiToggle");
    body.hidden = !body.hidden; btn.textContent = body.hidden ? "Show" : "Hide";
    if (body.hidden || body.dataset.ready) return;
    body.dataset.ready = "1";
    body.innerHTML = `<p class="muted">Loading…</p>`;
    const q = qs({ week: d.anchor, period: d.period, from: "", to: "" }), key = `aiWeek:${S.f.account || 0}:${d.key}`;
    const p = await api("/api/weekly_ai?" + q);
    const saved = localStorage.getItem("aiModel");
    const opt = (m) => `<option value="${esc(m.id)}" ${m.id === saved ? "selected" : ""}>${esc(m.label)}</option>`;
    const local = p.models.filter((m) => m.local), outside = p.models.filter((m) => !m.local);
    body.innerHTML = `<p class="muted">Sends the ${p.trades} trades of ${thisLow}, the totals next to ${beforeP}, the rule breaks and the rules ticked per stage.
      Never sent: account number, balance, dollar amounts, lot size, prices, notes, the reflection, screenshots.
      The answer is a guide, not proof and not financial advice.</p>
      <details style="margin:10px 0"><summary class="muted">See exactly what will be sent</summary><pre style="white-space:pre-wrap;font-size:12px;max-height:300px;overflow:auto">${esc(p.prompt)}</pre></details>
      <label class="field"><span>Which AI reads it</span><select id="wkAiModel">
        ${local.length ? `<optgroup label="Local AI: stays on this PC">${local.map(opt).join("")}</optgroup>` : ""}
        <optgroup label="OmniRoute: goes to outside AI companies">${outside.map(opt).join("")}</optgroup></select></label>
      <button class="btn primary" id="wkAiGo" style="margin-top:10px">Ask the AI about ${thisLow}</button>
      <div id="wkAiOut" style="margin-top:14px"></div>`;
    const show = (r) => { $("#wkAiOut").innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:6px">${esc(r.model)} · ${esc(r.at)}</div><div style="white-space:pre-wrap;line-height:1.6">${esc(r.answer)}</div>`; };
    try { const old = JSON.parse(localStorage.getItem(key)); if (old) show(old); } catch (e) { /* no saved answer */ }
    $("#wkAiModel").addEventListener("change", () => localStorage.setItem("aiModel", $("#wkAiModel").value));
    $("#wkAiGo").onclick = async () => {
      const b = $("#wkAiGo");
      b.disabled = true; b.textContent = "Asking the AI…";
      try {
        const r = await api(`/api/weekly_ai?${q}&model=${encodeURIComponent($("#wkAiModel").value)}`, { method: "POST" });
        r.at = new Date().toLocaleString();
        localStorage.setItem(key, JSON.stringify(r));
        show(r);
      } catch (e) {
        $("#wkAiOut").innerHTML = `<div class="alert bad">${esc(e.message)}</div>`;
      }
      b.disabled = false; b.textContent = `Ask the AI about ${thisLow}`;
    };
  };
  $("#wkPrev").onclick = () => { WEEK = d.nav_prev; reportWeekly(); };
  $("#wkNext").onclick = () => { WEEK = d.nav_next; reportWeekly(); };
  $("#wkNow").onclick = () => { WEEK = ""; reportWeekly(); };
  $$("[data-period]").forEach((b) => b.addEventListener("click", () => { PERIOD = b.dataset.period; WEEK = d.anchor; reportWeekly(); }));
  $$("[data-week]").forEach((b) => b.addEventListener("click", () => { PERIOD = "week"; WEEK = b.dataset.week; reportWeekly(); }));
  $$("[data-month]").forEach((b) => b.addEventListener("click", () => { PERIOD = "month"; WEEK = b.dataset.month; reportWeekly(); }));
}
function tiltExtras(d) {
  const c = d.edge.clean, f = d.edge.flagged;
  const row = (name, s) => `<tr><td><b>${name}</b></td><td class="r num">${s.trades}</td><td class="r num ${cls(s.net)}">${money(s.net)}</td><td class="r num">${pct(s.win_rate, 0)}</td><td class="r num ${cls(s.expectancy)}">${s.trades ? money(s.expectancy) : "—"}</td></tr>`;
  const gap = c.trades && f.trades ? c.expectancy - f.expectancy : null;
  return `<div class="grid g-2">
    <div class="card"><div class="card-h"><h2>Discipline by stage</h2><span class="muted">Playbook rules ticked, on trades where you ticked at least one</span></div>
      ${d.stages.length ? d.stages.map((x) => `<div class="row" style="margin-top:10px"><span style="width:130px">${esc(x.stage)}</span><div class="progress" style="flex:1"><b style="width:${(x.followed / x.total) * 100}%"></b></div><span class="num" style="width:90px;text-align:right">${pct(x.followed / x.total, 0)} · ${x.followed}/${x.total}</span></div>`).join("") : `<div class="empty">Pick a playbook on your trades and tick the rules to see this.</div>`}</div>
    <div class="card"><div class="card-h"><h2>Clean vs flagged trades</h2><span class="muted">Graded trades only</span></div>
      <div class="tbl-wrap"><table><thead><tr><th></th><th class="r">Trades</th><th class="r">Net P&amp;L</th><th class="r">Win %</th><th class="r">Avg per trade</th></tr></thead><tbody>${row("Clean", c)}${row("Flagged", f)}</tbody></table></div>
      ${gap == null ? "" : `<div class="muted" style="margin-top:10px">${gap >= 0 ? `Flagged trades made ${money(gap)} less per trade than clean ones: about ${money(gap * f.trades)} across ${f.trades} flagged trades.` : `Flagged trades made ${money(-gap)} more per trade than clean ones so far.`} Small samples swing a lot.</div>`}</div></div>`;
}
async function renderReports() {
  const groups = { overview: "Overview", weekly: "Review", compare: "Compare", ...(await api("/api/reports?group=symbol&" + qs())).groups, ai: "AI Review" };
  const tabs = `<div class="seg" style="margin-bottom:16px">${Object.entries(groups).map(([k, l]) => `<button data-g="${k}" class="${k === REPORT ? "on" : ""}">${l}</button>`).join("")}</div>`;
  view().innerHTML = tabs + `<div id="rep"></div>`;
  $$("[data-g]").forEach((b) => b.addEventListener("click", () => { REPORT = b.dataset.g; renderReports(); }));
  if (REPORT === "overview") return reportOverview();
  if (REPORT === "compare") return reportCompare();
  if (REPORT === "weekly") return reportWeekly();
  if (REPORT === "ai") return reportAI();
  const d = await api(`/api/reports?group=${REPORT}&${qs()}`);
  const rows = d.rows;
  if (REPORT === "hour") rows.forEach((r) => (r.key = ampm(+r.key.slice(0, 2))));
  const horiz = rows.length > 12 || ["symbol", "setup", "mistake", "custom", "playbook"].includes(REPORT);
  const best = [...rows].sort((a, b) => b.net - a.net)[0];
  const worst = [...rows].sort((a, b) => a.net - b.net)[0];
  $("#rep").innerHTML = `<div class="stack">
    ${REPORT === "tilt" ? tiltExtras(d) : ""}
    ${rows.length > 1 ? `<div class="grid g-3">
      <div class="card stat"><div class="label">Best ${esc(groups[REPORT].toLowerCase())}</div><div class="value" style="font-size:18px">${esc(best.key)}</div><div class="sub pos">${money(best.net)} · ${best.trades} trades</div></div>
      <div class="card stat"><div class="label">Worst ${esc(groups[REPORT].toLowerCase())}</div><div class="value" style="font-size:18px">${esc(worst.key)}</div><div class="sub neg">${money(worst.net)} · ${worst.trades} trades</div></div>
      <div class="card stat"><div class="label">Groups</div><div class="value">${rows.length}</div><div class="sub">${d.summary.trades} trades total</div></div></div>` : ""}
    <div class="grid g-2e">
      <div class="card"><div class="card-h"><h2>Net P&amp;L</h2></div><div class="chart-box" style="height:${horiz ? Math.max(260, rows.length * 28) : 280}px"><canvas id="rNet"></canvas></div></div>
      <div class="card"><div class="card-h"><h2>Win % and trade count</h2></div><div class="chart-box" style="height:${horiz ? Math.max(260, rows.length * 28) : 280}px"><canvas id="rWin"></canvas></div></div>
    </div>
    <div class="card">${reportTable(rows, groups[REPORT])}</div></div>`;
  barChart($("#rNet"), rows.map((r) => r.key), rows.map((r) => +r.net.toFixed(2)), { horizontal: horiz });
  chart($("#rWin"), {
    data: { labels: rows.map((r) => r.key), datasets: [
      { type: "bar", label: "Trades", data: rows.map((r) => r.trades), backgroundColor: "rgba(91,141,239,.45)", borderRadius: 3, yAxisID: horiz ? undefined : "y1", xAxisID: horiz ? "x1" : undefined, maxBarThickness: 30 },
      { type: horiz ? "bar" : "line", label: "Win %", data: rows.map((r) => r.win_rate == null ? null : +(r.win_rate * 100).toFixed(1)), borderColor: C.accent, backgroundColor: C.accent, pointRadius: 3, borderRadius: 3, maxBarThickness: 30 },
    ] },
    options: baseOpts({
      indexAxis: horiz ? "y" : "x",
      plugins: { legend: { display: true, labels: { color: C.tick, boxWidth: 10 } }, tooltip: baseOpts().plugins.tooltip },
      scales: horiz
        ? { y: { grid: { display: false }, ticks: { color: C.tick } }, x: { min: 0, max: 100, grid: { color: C.grid }, ticks: { color: C.tick, callback: (v) => v + "%" } }, x1: { position: "top", grid: { display: false }, ticks: { color: C.tick } } }
        : { x: { grid: { display: false }, ticks: { color: C.tick } }, y: { min: 0, max: 100, grid: { color: C.grid }, ticks: { color: C.tick, callback: (v) => v + "%" } }, y1: { position: "right", grid: { display: false }, ticks: { color: C.tick } } },
    }),
  });
}
function reportTable(rows, label) {
  if (!rows.length) return `<div class="empty">No trades in range.</div>`;
  return `<div class="tbl-wrap"><table><thead><tr><th>${esc(label)}</th><th class="r">Trades</th><th class="r">Win %</th><th class="r">Net P&amp;L</th><th class="r">Profit factor</th><th class="r">Avg / trade</th><th class="r">Avg win</th><th class="r">Avg loss</th><th class="r">Avg R</th><th class="r">Volume</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><b>${esc(r.key)}</b></td><td class="r num">${r.trades}</td><td class="r num">${pct(r.win_rate)}</td><td class="r num ${cls(r.net)}">${money(r.net)}</td><td class="r num">${pf(r)}</td><td class="r num ${cls(r.expectancy)}">${money(r.expectancy)}</td><td class="r num pos">${money(r.avg_win)}</td><td class="r num neg">${money(r.avg_loss)}</td><td class="r num ${cls(r.avg_r)}">${rr(r.avg_r)}</td><td class="r num">${num(r.volume)}</td></tr>`).join("")}
  </tbody></table></div>`;
}
async function reportOverview() {
  const d = await api("/api/dashboard?" + qs());
  const s = d.summary;
  const L = [
    ["Total net P&L", money(s.net), cls(s.net)], ["Gross profit", money(s.gross_profit), "pos"], ["Gross loss", money(s.gross_loss), "neg"],
    ["Commissions & fees", money(s.commission)], ["Swap", money(s.swap)], ["Total trades", s.trades], ["Winning trades", s.wins], ["Losing trades", s.losses], ["Break-even trades", s.breakeven],
    ["Win rate", pct(s.win_rate)], ["Profit factor", pf(s)], ["Expectancy", money(s.expectancy), cls(s.expectancy)], ["Payoff ratio", num(s.payoff)],
  ];
  const R = [
    ["Average win", money(s.avg_win), "pos"], ["Average loss", money(s.avg_loss), "neg"], ["Largest win", money(s.largest_win), "pos"], ["Largest loss", money(s.largest_loss), "neg"],
    ["Max drawdown", money(-s.max_drawdown), "neg"], ["Max consecutive wins", s.max_win_streak], ["Max consecutive losses", s.max_loss_streak],
    ["Average R", rr(s.avg_r), cls(s.avg_r)], ["Total R", rr(s.total_r), cls(s.total_r)], ["Avg hold time", dur(s.avg_hold)], ["Avg hold (wins)", dur(s.avg_hold_win)], ["Avg hold (losses)", dur(s.avg_hold_loss)], ["Total volume", num(s.volume) + " lots"],
  ];
  const D = [
    ["Trading days", s.days], ["Green days", s.green_days, "pos"], ["Red days", s.red_days, "neg"], ["Day win rate", pct(s.day_win_rate)],
    ["Average daily P&L", money(s.avg_day), cls(s.avg_day)], ["Best day", money(s.best_day), "pos"], ["Worst day", money(s.worst_day), "neg"],
    ["Long trades", `${s.longs} · ${pct(s.long_win_rate, 0)} win`], ["Long P&L", money(s.long_net), cls(s.long_net)], ["Short trades", `${s.shorts} · ${pct(s.short_win_rate, 0)} win`], ["Short P&L", money(s.short_net), cls(s.short_net)], ["Outcome score", s.edge_score ?? "—"], ["Process score", s.process_score ?? "—"], ["Rules score", s.rules_score ?? "—"], ["Behavior score", s.behaviour_score ?? "—"],
  ];
  const kv = (rows) => `<dl class="kv">${rows.map(([k, v, c]) => `<dt>${k}</dt><dd class="${c || ""}">${v}</dd>`).join("")}</dl>`;
  $("#rep").innerHTML = `<div class="stack"><div class="grid g-3"><div class="card"><h2 style="margin-bottom:12px">Performance</h2>${kv(L)}</div><div class="card"><h2 style="margin-bottom:12px">Trade statistics</h2>${kv(R)}</div><div class="card"><h2 style="margin-bottom:12px">Days &amp; direction</h2>${kv(D)}</div></div>
    <div class="card"><div class="card-h"><h2>Drawdown</h2></div><div class="chart-box"><canvas id="dd"></canvas></div></div></div>`;
  let peak = 0;
  const pts = d.equity.map((p) => { peak = Math.max(peak, p.value); return { time: p.time, value: +(p.value - peak).toFixed(2) }; });
  if (pts.length) chart($("#dd"), { type: "line", data: { labels: pts.map((p) => dt(p.time)), datasets: [{ data: pts.map((p) => p.value), borderColor: C.neg, backgroundColor: "rgba(240,82,82,.18)", fill: true, pointRadius: 0, borderWidth: 1.5 }] }, options: baseOpts() });
}
const CMP = { a: { k: "direction", v: "long" }, b: { k: "direction", v: "short" } };
async function reportCompare() {
  const optsFor = (k) => ({
    direction: [["long", "Long"], ["short", "Short"]],
    symbol: S.symbols.map((x) => [x, x]),
    playbook: S.playbooks.map((p) => [p.id, p.name]),
    tag: S.tags.map((g) => [g.id, `${g.kind}: ${g.name}`]),
    result: [["win", "Winners"], ["loss", "Losers"]],
  }[k] || []);
  const side = (x) => `<div class="row"><select data-side="${x}" data-part="k">${["direction", "symbol", "playbook", "tag"].map((k) => `<option ${CMP[x].k === k ? "selected" : ""}>${k}</option>`).join("")}</select>
    <select data-side="${x}" data-part="v"><option value="">(all)</option>${optsFor(CMP[x].k).map(([v, l]) => `<option value="${esc(v)}" ${String(CMP[x].v) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>`;
  const p = new URLSearchParams(qs());
  if (CMP.a.v !== "") p.set("a_" + CMP.a.k, CMP.a.v);
  if (CMP.b.v !== "") p.set("b_" + CMP.b.k, CMP.b.v);
  const [A, B] = await api("/api/compare?" + p);
  const rows = [
    ["Trades", (s) => s.trades], ["Net P&L", (s) => money(s.net)], ["Win %", (s) => pct(s.win_rate)], ["Profit factor", pf], ["Expectancy", (s) => money(s.expectancy)],
    ["Avg win", (s) => money(s.avg_win)], ["Avg loss", (s) => money(s.avg_loss)], ["Avg R", (s) => rr(s.avg_r)], ["Max drawdown", (s) => money(-s.max_drawdown)], ["Avg hold", (s) => dur(s.avg_hold)],
  ];
  $("#rep").innerHTML = `<div class="stack"><div class="grid g-2e"><div class="card"><h3 style="margin-bottom:8px"><span class="pb-dot" style="background:${C.accent}"></span>Group A</h3>${side("a")}</div><div class="card"><h3 style="margin-bottom:8px"><span class="pb-dot" style="background:${C.blue}"></span>Group B</h3>${side("b")}</div></div>
    <div class="grid g-2e"><div class="card"><table><thead><tr><th>Metric</th><th class="r">A</th><th class="r">B</th></tr></thead><tbody>${rows.map(([l, f]) => `<tr><td class="muted">${l}</td><td class="r num">${f(A.summary)}</td><td class="r num">${f(B.summary)}</td></tr>`).join("")}</tbody></table></div>
    <div class="card"><div class="card-h"><h2>Cumulative P&amp;L by trade #</h2></div><div class="chart-box tall"><canvas id="cmp"></canvas></div></div></div></div>`;
  $$("[data-side]").forEach((s) => s.addEventListener("change", () => {
    const x = s.dataset.side;
    if (s.dataset.part === "k") { CMP[x] = { k: s.value, v: "" }; } else CMP[x].v = s.value;
    reportCompare();
  }));
  const n = Math.max(A.equity.length, B.equity.length);
  chart($("#cmp"), { type: "line", data: { labels: Array.from({ length: n }, (_, i) => i + 1), datasets: [
    { label: "A", data: A.equity.map((p) => p.value), borderColor: C.accent, pointRadius: 0, borderWidth: 2 },
    { label: "B", data: B.equity.map((p) => p.value), borderColor: C.blue, pointRadius: 0, borderWidth: 2 },
  ] }, options: baseOpts({ plugins: { legend: { display: true, labels: { color: C.tick, boxWidth: 10 } }, tooltip: baseOpts().plugins.tooltip } }) });
}

/* ------------------------------------------------------------ playbooks */
async function renderPlaybooks() {
  const pbs = await api("/api/playbooks?" + qs());
  S.playbooks = pbs;
  view().innerHTML = `<div class="row" style="margin-bottom:16px"><span class="muted">Define your setups and the rules you trade them by. Tick rules on each trade to see whether following them pays.</span><span class="spacer"></span><button class="btn primary" id="newPb">＋ New playbook</button></div>
    ${pbs.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">${pbs.map((p) => `
      <div class="card pb-card" style="--c:${esc(p.color)};${p.archived ? "opacity:.55" : ""}" data-id="${p.id}">
        <div class="card-h" style="margin-bottom:0"><h2>${esc(p.name)}</h2>${p.archived ? '<span class="chip">Archived</span>' : `<span class="muted">${p.rules.length} rules</span>`}</div>
        <p>${esc(p.description || "No description")}</p>
        <div class="mini-stats"><div>Net P&amp;L<b class="${cls(p.stats.net)}">${money(p.stats.net)}</b></div><div>Win %<b>${pct(p.stats.win_rate, 0)}</b></div><div>Trades<b>${p.stats.trades}</b></div>
          <div>Profit factor<b>${pf(p.stats)}</b></div><div>Expectancy<b class="${cls(p.stats.expectancy)}">${money(p.stats.expectancy)}</b></div><div>Rules followed<b>${pct(p.rule_adherence, 0)}</b></div></div>
      </div>`).join("")}</div>` : `<div class="card empty"><b>No playbooks yet</b>Create one for each setup you trade.</div>`}`;
  $("#newPb").onclick = () => playbookEditor();
  $$(".pb-card").forEach((c) => c.addEventListener("click", () => (location.hash = `#/playbook/${c.dataset.id}`)));
}
function playbookEditor(p) {
  p = p || { name: "", description: "", rules: [], color: "#14b8a6" };
  const COLORS = ["#14b8a6", "#5b8def", "#e0a43a", "#c778dd", "#f05252", "#22c55e", "#8b98a8"];
  const BASE = ["Entry", "Trade management", "Exit", "Optional"];
  // risk is decided at entry, so old "Risk" rules are filed under Entry
  const canon = (g) => { g = (g || "").trim(); if (g.toLowerCase() === "risk") g = "Entry"; return BASE.find((b) => b.toLowerCase() === g.toLowerCase()) || g || "Other"; };
  // o = the rule's position before editing, so ticks on old trades follow the rule when it moves
  const rules = p.rules.map((r, i) => ({ group: canon(r.group), text: r.text, o: p.id ? i : null }));
  const groups = [...new Set([...BASE, ...rules.map((r) => r.group)])];
  const rows = () => groups.map((g) => `<div class="rules-group">${esc(g)}${g === "Optional" ? " · nice to have, not scored" : ""}</div>${rules.map((r, i) => r.group !== g ? "" : `<div class="rule-row"><input type="text" class="rt" data-i="${i}" value="${esc(r.text)}" placeholder="Rule, e.g. Wait for a 15m close"><button class="btn sm" type="button" data-rm="${i}">✕</button></div>`).join("")}<button class="btn sm" type="button" data-add="${esc(g)}">＋ Add rule</button>`).join("");
  modal(`<h2 style="margin-bottom:14px">${p.id ? "Edit" : "New"} playbook</h2>
    <label class="field"><span>Name</span><input type="text" id="pbName" value="${esc(p.name)}" style="width:100%" placeholder="e.g. London Breakout"></label>
    <label class="field"><span>Description</span><textarea id="pbDesc" style="min-height:60px" placeholder="When and why you take this trade">${esc(p.description)}</textarea></label>
    <label class="field"><span>Colour</span><div class="row" id="pbColor">${COLORS.map((c) => `<button type="button" data-c="${c}" style="width:26px;height:26px;border-radius:6px;border:2px solid ${c === p.color ? "#fff" : "transparent"};background:${c};cursor:pointer"></button>`).join("")}</div></label>
    <div style="margin-bottom:14px"><span style="display:block;font-size:12px;color:var(--muted);margin-bottom:5px;font-weight:500">Rules: each one becomes a checkbox on your trades</span><div id="pbRules">${rows()}</div></div>
    <div class="row">${p.id ? `<button class="btn danger" id="pbDel">Delete</button><label class="check"><input type="checkbox" id="pbArch" ${p.archived ? "checked" : ""}> Archived</label>` : ""}<span class="spacer"></span><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" id="pbSave">Save</button></div>`);
  const collect = () => $$("#pbRules .rt").forEach((x) => { rules[+x.dataset.i].text = x.value.trim(); });
  const bindRows = () => {
    $$("#pbRules [data-rm]").forEach((b) => (b.onclick = () => { collect(); rules.splice(+b.dataset.rm, 1); $("#pbRules").innerHTML = rows(); bindRows(); }));
    $$("#pbRules [data-add]").forEach((b) => (b.onclick = () => { collect(); rules.push({ group: b.dataset.add, text: "", o: null }); $("#pbRules").innerHTML = rows(); bindRows(); $(`#pbRules .rt[data-i="${rules.length - 1}"]`).focus(); }));
  };
  bindRows();
  $$("#pbColor button").forEach((b) => (b.onclick = () => { p.color = b.dataset.c; $$("#pbColor button").forEach((x) => (x.style.borderColor = x === b ? "#fff" : "transparent")); }));
  $("#pbSave").onclick = async () => {
    collect();
    const kept = groups.flatMap((g) => rules.filter((r) => r.group === g && r.text));
    const body = { name: $("#pbName").value.trim() || "Untitled playbook", description: $("#pbDesc").value, rules: kept.map((r) => ({ group: r.group, text: r.text })), rule_map: kept.map((r) => r.o), color: p.color, archived: $("#pbArch")?.checked };
    if (p.id) await api(`/api/playbooks/${p.id}`, { method: "PUT", body });
    else { const r = await api("/api/playbooks", { method: "POST", body }); p.id = r.id; }
    closeModal(); S.playbooks = await api("/api/playbooks"); toast("Playbook saved");
    location.hash === `#/playbook/${p.id}` ? route(true) : (location.hash = `#/playbook/${p.id}`);
  };
  const del = $("#pbDel");
  if (del) del.onclick = async () => {
    if (!confirm("Delete this playbook? Trades keep their notes but lose the playbook link.")) return;
    await api(`/api/playbooks/${p.id}`, { method: "DELETE" });
    closeModal(); S.playbooks = await api("/api/playbooks"); location.hash = "#/playbooks";
  };
}
async function renderPlaybook(id) {
  const p = await api(`/api/playbooks/${id}?${qs()}`);
  $("#pageTitle").textContent = p.name;
  const s = p.stats;
  view().innerHTML = `<div class="row" style="margin-bottom:14px"><a class="btn" href="#/playbooks">← Playbooks</a><span class="pb-dot" style="background:${esc(p.color)};width:12px;height:12px"></span><span class="muted">${esc(p.description || "")}</span><span class="spacer"></span><button class="btn" id="editPb">Edit playbook</button></div>
    <div class="stack">${statCards(s)}
      ${chartBoxHtml("boxPb", "Setup reference photos")}
      <div class="grid g-2"><div class="card"><div class="card-h"><h2>Cumulative P&amp;L</h2></div><div class="chart-box">${p.equity.length ? '<canvas id="peq"></canvas>' : '<div class="empty">No trades with this playbook yet</div>'}</div></div>
        <div class="card"><div class="card-h"><h2>By session</h2></div>${reportTable(p.by_session, "Session")}</div></div>
      <div class="card"><div class="card-h"><h2>Does following the rules pay?</h2><span class="muted">Only trades where you ticked at least one rule count</span></div>
        ${p.rule_stats.length ? `<div class="tbl-wrap"><table><thead><tr><th>Rule</th><th class="r">Followed: trades</th><th class="r">Win %</th><th class="r">Avg</th><th class="r">Broken: trades</th><th class="r">Win %</th><th class="r">Avg</th></tr></thead><tbody>
          ${p.rule_stats.map((r) => `<tr><td style="white-space:normal">${r.rule.group ? `<span class="faint">${esc(r.rule.group)} · </span>` : ""}${esc(r.rule.text)}</td>
            <td class="r num">${r.followed.trades}</td><td class="r num">${pct(r.followed.win_rate, 0)}</td><td class="r num ${cls(r.followed.expectancy)}">${money(r.followed.expectancy)}</td>
            <td class="r num">${r.broken.trades}</td><td class="r num">${pct(r.broken.win_rate, 0)}</td><td class="r num ${cls(r.broken.expectancy)}">${money(r.broken.expectancy)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Add rules to this playbook to track adherence.</div>`}</div>
      <div class="card"><div class="card-h"><h2>By symbol</h2></div>${reportTable(p.by_symbol, "Symbol")}</div>
      <div class="card"><div class="card-h"><h2>Trades</h2></div>${tradesTable(p.trades)}</div></div>`;
  if (p.equity.length) equityChart($("#peq"), p.equity);
  bindTradeRows(view());
  $("#editPb").onclick = () => playbookEditor(p);
  mountChartBox("boxPb", p.photos, `/api/playbooks/${id}/photos`, (c) => `/api/playbook_photos/${c}`, (r) => r.photos)();
}

/* ------------------------------------------------------------ settings */
async function renderSettings() {
  const st = await refreshMeta();
  const s = st.settings;
  const conn = await api("/api/mt5").catch((e) => ({ connected: false, reason: e.message }));
  S.mt5 = conn.connected;
  view().innerHTML = `<div class="grid g-2e">
    <div class="stack">
      <div class="card"><div class="card-h"><h2>MetaTrader 5</h2>${conn.connected ? '<span class="pos"><span class="dot on"></span>Connected</span>' : '<span class="neg"><span class="dot err"></span>Not connected</span>'}</div>
        ${conn.connected ? `<div class="alert ok" style="margin-bottom:14px">Logged in as <b>${conn.login}</b> on ${esc(conn.server)}${conn.terminal_connected ? "" : " — terminal is offline from the broker"}</div>` : `<div class="alert warn" style="margin-bottom:14px">${esc(conn.reason || "Unknown error")}</div>`}
        <label class="field"><span>Allowed MT5 accounts</span><input type="text" data-s="allowed_accounts" value="${esc(s.allowed_accounts)}"><small>Separate with commas. Any other account is refused, so demo stays out unless you add it.</small></label>
        <label class="field"><span>Terminal path (optional)</span><input type="text" data-s="terminal_path" value="${esc(s.terminal_path)}" placeholder="C:\\Program Files\\MetaTrader 5\\terminal64.exe" style="width:100%"><small>Only needed if you have more than one MT5 installed.</small></label>
        <label class="field"><span>Show times in (hours from UTC)</span><input type="number" step="0.5" data-s="display_utc_offset" value="${s.display_utc_offset}"><small>For example London = 0, Philippines = 8, New York = −5. Every time, day and report in the app uses this clock.</small></label>
        <label class="field"><span>Broker summer time</span><select data-s="server_dst"><option value="us" ${s.server_dst === "us" ? "selected" : ""}>Moves with New York (most MT5 brokers)</option><option value="none" ${s.server_dst === "none" ? "selected" : ""}>Never changes</option></select><small>Broker server clock is detected automatically at each sync: now UTC+${s.server_utc_offset} in winter. Press Sync to apply changes.</small></label>
        <label class="field"><span>Import history from</span><input type="date" data-s="history_start" value="${esc(s.history_start)}"></label>
        <label class="check"><input type="checkbox" data-s="auto_sync" ${s.auto_sync ? "checked" : ""}> Sync automatically while the app is running</label>
        <label class="field"><span>Every (seconds)</span><input type="number" min="15" data-s="sync_interval" value="${s.sync_interval}"></label>
        <label class="check"><input type="checkbox" data-s="compute_excursions" ${s.compute_excursions ? "checked" : ""}> Calculate MAE / MFE from M1 candles (slower first sync)</label>
      </div>
      <div class="card"><div class="card-h"><h2>Display</h2></div>
        <label class="field"><span>Breakeven zone (± R)</span><input type="number" step="0.05" min="0" data-s="be_zone_r" value="${s.be_zone_r}"><small>Trades within this many R count as breakeven, not wins or losses. 0 = off.</small></label>
        <label class="field"><span>Currency symbol</span><input type="text" data-s="currency_symbol" value="${esc(s.currency_symbol)}" style="width:80px"></label></div>
    </div>
    <div class="stack">
      <div class="card"><div class="card-h"><h2>Risk rules</h2><span class="muted">0 = off</span></div>
        <p class="muted" style="margin-top:0">Shown on the dashboard with warnings. Handy for prop-firm challenges.</p>
        <label class="field"><span>Daily loss limit (${esc(s.currency_symbol)})</span><input type="number" step="any" data-s="daily_loss_limit" value="${s.daily_loss_limit}"></label>
        <label class="field"><span>Max drawdown from peak (${esc(s.currency_symbol)})</span><input type="number" step="any" data-s="max_drawdown_limit" value="${s.max_drawdown_limit}"></label>
        <label class="field"><span>Profit target (${esc(s.currency_symbol)})</span><input type="number" step="any" data-s="profit_target" value="${s.profit_target}"></label>
        <label class="field"><span>Max trades per day</span><input type="number" data-s="max_trades_per_day" value="${s.max_trades_per_day}"></label>
        <label class="field"><span>Planned risk per trade (%)</span><input type="number" step="0.05" data-s="risk_per_trade_pct" value="${s.risk_per_trade_pct}"><small>Tilt score counts a trade as oversized above 1.25x this.</small></label>
        <label class="field"><span>Grade discipline from</span><input type="date" data-s="discipline_start" value="${esc(s.discipline_start)}"><small>Trades opened before this day get no tilt flags and are left out of the Discipline score. Empty = grade every trade.</small></label></div>
      <div class="card"><div class="card-h"><h2>Accounts</h2></div>
        ${st.accounts.length ? `<table><tbody>${st.accounts.map((a) => `<tr><td><b>${esc(a.name || "")}</b><div class="muted">${a.login} · ${esc(a.server || "")}</div></td><td class="r muted">${a.last_sync ? "synced " + timeAgo(a.last_sync) : ""}</td><td class="r"><button class="btn sm danger" data-delacc="${a.login}">Remove</button></td></tr>`).join("")}</tbody></table>` : `<div class="muted">No accounts yet. Log in to an account in MT5 and press Sync. Switch accounts in MT5 and sync again to add more.</div>`}</div>
      <div class="card"><div class="card-h"><h2>Tags</h2></div>
        ${["setup", "mistake", "custom"].map((k) => `<div class="rules-group">${k}s</div><div>${S.tags.filter((g) => g.kind === k).map((g) => `<span class="chip ${k}">${esc(g.name)} <span class="faint">${g.uses}</span> <span class="x" data-deltag="${g.id}">✕</span></span>`).join("")}</div>`).join("")}
        <div class="row" style="margin-top:12px"><input type="text" id="tgN" placeholder="New tag"><select id="tgK"><option value="setup">Setup</option><option value="mistake">Mistake</option><option value="custom">Custom</option></select><button class="btn" id="tgAdd">Add</button></div></div>
    </div></div>`;
  const save = debounce(async () => {
    const body = {};
    $$("[data-s]").forEach((el) => {
      const k = el.dataset.s;
      body[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value || 0) : el.value;
    });
    S.settings = await api("/api/settings", { method: "PUT", body });
    toast("Settings saved");
  }, 500);
  $$("[data-s]").forEach((el) => el.addEventListener("change", save));
  $$("[data-delacc]").forEach((b) => (b.onclick = async () => {
    if (!confirm(`Remove account ${b.dataset.delacc} and all its trades, notes and screenshots from Edgebook? (Your MT5 account is not affected.)`)) return;
    await api(`/api/accounts/${b.dataset.delacc}`, { method: "DELETE" });
    toast("Account removed"); renderSettings();
  }));
  $$("[data-deltag]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this tag from all trades?")) return;
    await api(`/api/tags/${b.dataset.deltag}`, { method: "DELETE" });
    S.tags = await api("/api/tags"); renderSettings();
  }));
  $("#tgAdd").onclick = async () => {
    const name = $("#tgN").value.trim();
    if (!name) return;
    await api("/api/tags", { method: "POST", body: { name, kind: $("#tgK").value } });
    S.tags = await api("/api/tags"); renderSettings();
  };
}

/* ------------------------------------------------------------ start */
(async function boot() {
  loadFilters();
  try {
    await refreshMeta();
  } catch (e) {
    view().innerHTML = `<div class="alert bad">Can't reach the Edgebook server: ${esc(e.message)}</div>`;
    return;
  }
  $("#fPreset").value = S.f.preset || "all";
  if (S.f.preset === "custom") { $("#fFrom").value = S.f.from; $("#fTo").value = S.f.to; $("#customRange").hidden = false; }
  else applyPreset(S.f.preset || "all");
  api("/api/mt5").then((c) => (S.mt5 = c.connected)).catch(() => {});
  route();
})();
