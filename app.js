import * as C from "./calc.js";

const KEY = "nw.store.v1";
const $ = (s) => document.querySelector(s);
const today = () => new Date().toISOString().slice(0, 10);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const gbp0 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const gbp2 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const money = (v, dp = 2) => (v == null || Number.isNaN(v) ? "—" : (dp ? gbp2 : gbp0).format(v));
const signed = (v, dp = 2) => (v == null ? "—" : (v >= 0 ? "+" : "−") + (dp ? gbp2 : gbp0).format(Math.abs(v)));
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2) + "%");
const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
const priceFmt = (p) => (p == null ? "—" : p >= 100 ? gbp2.format(p) : "£" + p.toFixed(4));
const fmtDate = (iso, long) => {
  if (!iso) return "no date";
  const d = new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso);
  const opts = { day: "numeric", month: "short", timeZone: "Europe/London" };
  if (long || d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  if (iso.length > 10) Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString("en-GB", opts);
};

// ---------- state ----------

const EMPTY = {
  version: 1, funds: [], fidelityCash: {}, crypto: [], metals: [], savings: [],
  car: null, loan: null, priceOverrides: {}, snapshots: [], lastImport: null,
};
function applyTheme(t = store?.theme || "dark") {
  const eff = t === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : t;
  document.documentElement.dataset.theme = eff;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", eff === "light" ? "#fbfaf7" : "#000000");
}
function load() {
  try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...EMPTY }; }
}
let store = load();
applyTheme();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { alertSheet("Couldn't save on this device: " + e.message); }
}

let prices = null, pricesErr = null, priceHist = { funds: {}, crypto: {} }, live = {};
const ui = { range: { all: "1Y", investments: "1Y", crypto: "1Y", cash: "1Y", bullion: "1Y", detail: "1Y" }, custom: {}, detailMode: "price" };

/** Window a full [[iso, v]] series by a chart's selected range (preset or custom). */
function windowFor(key, pts) {
  const r = ui.range[key];
  if (r === "Custom") { const c = ui.custom[key] || {}; return C.pointsBetween(pts, c.from, c.to); }
  return C.seriesWindow(Object.fromEntries(pts), r);
}
const seriesPts = (s) => C.seriesWindow(s, "ALL");
function rangeLabel(key) {
  if (ui.range[key] !== "Custom") return `over ${ui.range[key]}`;
  const c = ui.custom[key] || {};
  return `${c.from ? fmtDate(c.from, true) : "start"} – ${c.to ? fmtDate(c.to, true) : "latest"}`;
}
let route = location.hash.slice(1) || "home";

async function loadPrices() {
  try {
    const r = await fetch("data/prices.json", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    prices = await r.json(); pricesErr = null;
  } catch (e) { pricesErr = "Couldn't load prices file (" + e.message + ")"; }
}
async function loadHistory() {
  try {
    const r = await fetch("data/history.json", { cache: "no-store" });
    if (r.ok) priceHist = await r.json();
  } catch { /* charts show "not enough history" */ }
}
async function loadLiveCrypto() {
  if (!store.crypto.length) return;
  const ids = store.crypto.map((c) => c.coingeckoId).filter(Boolean);
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=gbp&include_last_updated_at=true`);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    live = {};
    for (const c of store.crypto) {
      const row = d[c.coingeckoId];
      if (row) live[c.symbol] = { price_gbp: row.gbp, as_of: new Date(row.last_updated_at * 1000).toISOString() };
    }
  } catch { /* scheduled price is fine */ }
}

function value() {
  const v = C.valuation({ ...store, _liveCrypto: live }, prices, new Date());
  if (!v.missing.length && v.lines.length) {
    store.snapshots = C.upsertSnapshot(store.snapshots, today(), v.total, v.totals);
    save();
  }
  return v;
}

const fundSeries = (isin) => priceHist.funds?.[isin] || {};
const coinSeries = (sym) => {
  const s = { ...(priceHist.crypto?.[sym] || {}) };
  const q = live[sym];
  if (q) s[q.as_of.slice(0, 10)] = q.price_gbp;
  return s;
};
const shortName = (n) => n.replace(/\bP-(Acc|Inc)\b/g, "").replace(/\((I)\)|\s-\s/g, " ").replace(/\b(Fund|Index|Trust|Portfolio|Class|Framlington|GBP|Z|I|C|P)\b/g, "").replace(/\b(Acc|Inc|INC|ACC|P-Acc|P-Inc)\b/g, "").replace(/Legal & General/, "L&G").replace(/\s+/g, " ").trim();
const legFor = (l) => (l.kind === "fund" ? { name: `${shortName(l.name)} (${l.account})`, series: fundSeries(l.isin), units: l.units }
  : l.kind === "crypto" ? { name: l.name, series: coinSeries(l.name), units: l.units } : null);

// ---------- charts ----------

const CHARTS = new Map();
let chartSeq = 0;

/** Placeholder; drawn after insertion at the element's real width. */
function lineChart(pts, { h = 200, readout = null, fmt = (v) => money(v, 0), axis = true, empty = "No prices in this date range", bands = [] } = {}) {
  const id = "c" + ++chartSeq;
  CHARTS.set(id, { pts: C.thin(pts, 260), h, readout, fmt, axis, empty, bands });
  return `<div class="lc" data-chart="${id}" style="height:${h}px"></div>`;
}
function sparkline(pts) {
  if (!pts || pts.length < 2) return `<svg class="spark"></svg>`;
  const t = C.thin(pts, 40), ys = t.map((p) => p[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys), W = 64, H = 28;
  const d = t.map((p, i) => `${i ? "L" : "M"}${((i / (t.length - 1)) * W).toFixed(1)},${(H - 3 - ((p[1] - lo) / (hi - lo || 1)) * (H - 6)).toFixed(1)}`).join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--${ys.at(-1) >= ys[0] ? "pos" : "neg"})" stroke-width="1.5"/></svg>`;
}

function drawCharts() {
  document.querySelectorAll(".lc[data-chart]").forEach((el) => {
    const c = CHARTS.get(el.dataset.chart);
    if (!c) return;
    const W = el.clientWidth, H = c.h, padT = 18, padB = c.axis ? 22 : 6;
    if (c.pts.length < 2) {
      el.innerHTML = `<div class="note" style="text-align:center;padding-top:${H / 2 - 20}px">${esc(c.empty)}</div>`;
      return;
    }
    const ys = c.pts.map((p) => p[1]);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const X = (i) => (i / (c.pts.length - 1)) * W;
    const Y = (y) => padT + (1 - (y - lo) / (hi - lo || 1)) * (H - padT - padB);
    const up = ys.at(-1) >= ys[0], col = `var(--${up ? "pos" : "neg"})`;
    const line = c.pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
    const gid = "g" + el.dataset.chart;
    const iHi = ys.indexOf(hi), iLo = ys.indexOf(lo);
    const anchor = (i) => (X(i) < 40 ? "start" : X(i) > W - 40 ? "end" : "middle");
    const idx = (d, last) => { let k = last ? -1 : c.pts.length - 1; c.pts.forEach(([pd], i) => { if (last ? pd <= d : pd >= d && i < k) k = i; }); return Math.max(0, k); };
    // big-move markers: a large dot on the line where each move ended
    const bandSvg = (c.bands || []).map((b) => {
      const i = idx(b.to, true), col2 = b.dir === "up" ? "var(--pos)" : "var(--neg)";
      return `<circle cx="${X(i)}" cy="${Y(c.pts[i][1])}" r="7" fill="${col2}" stroke="var(--bg)" stroke-width="2.5"><title>${b.dir === "up" ? "Largest rise" : "Largest fall"}</title></circle>`;
    }).join("");
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Line chart from ${fmtDate(c.pts[0][0])} to ${fmtDate(c.pts.at(-1)[0])}, ${c.fmt(ys[0])} to ${c.fmt(ys.at(-1))}">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".18"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      <path d="${line}L${W},${H - padB}L0,${H - padB}Z" fill="url(#${gid})"/>
      <path d="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>
      ${bandSvg}
      <text x="${X(iHi)}" y="11" text-anchor="${anchor(iHi)}">${c.fmt(hi)}</text>
      ${c.axis && hi !== lo ? `<text x="${X(iLo)}" y="${Y(lo) + 14 > H - padB - 2 ? Y(lo) - 8 : Y(lo) + 14}" text-anchor="${anchor(iLo)}">${c.fmt(lo)}</text>` : ""}
      ${c.axis ? `
      <text x="0" y="${H - 3}">${fmtDate(c.pts[0][0], true)}</text><text x="${W}" y="${H - 3}" text-anchor="end">${fmtDate(c.pts.at(-1)[0], true)}</text>` : ""}
      <line class="xh" x1="0" x2="0" y1="${padT - 4}" y2="${H - padB}"/>
      <circle class="dot" r="5" fill="${col}" stroke="var(--bg)" stroke-width="2"/>
    </svg>`;
    c.X = X; c.Y = Y;
  });
}

function scrub(el, clientX) {
  const c = CHARTS.get(el.dataset.chart);
  if (!c?.X) return;
  const r = el.getBoundingClientRect();
  const i = Math.max(0, Math.min(c.pts.length - 1, Math.round(((clientX - r.left) / r.width) * (c.pts.length - 1))));
  const [d, v] = c.pts[i], x = c.X(i);
  el.classList.add("scrub");
  const xh = el.querySelector(".xh"), dot = el.querySelector(".dot");
  xh.setAttribute("x1", x); xh.setAttribute("x2", x);
  dot.setAttribute("cx", x); dot.setAttribute("cy", c.Y(v));
  if (c.readout) setReadout(c.readout, v, v - c.pts[0][1], (v / c.pts[0][1] - 1) * 100, fmtDate(d, true), c.fmt);
}
function unscrub(el) {
  const c = CHARTS.get(el.dataset.chart);
  el.classList.remove("scrub");
  if (c?.readout) resetReadout(c.readout);
}
const READOUTS = new Map();
function readout(id, v, chg, chgPct, label, fmt) {
  READOUTS.set(id, [v, chg, chgPct, label, fmt]);
  return `<div class="readout" id="${id}">${readoutInner(v, chg, chgPct, label, fmt)}</div>`;
}
function readoutInner(v, chg, chgPct, label, fmt) {
  const c = chg == null ? "" : `<span class="c num ${cls(chg)}">${signed(chg, Math.abs(chg) < 100 ? 2 : 0)} (${pct(chgPct)})</span> `;
  return `<div class="p num">${fmt(v)}</div><div>${c}<span class="d">${esc(label)}</span></div>`;
}
function setReadout(id, ...a) { const el = document.getElementById(id); if (el) el.innerHTML = readoutInner(...a); }
function resetReadout(id) { const r = READOUTS.get(id); if (r) setReadout(id, ...r); }

document.addEventListener("pointermove", (e) => { const el = e.target.closest?.(".lc"); if (el) scrub(el, e.clientX); });
document.addEventListener("pointerdown", (e) => { const el = e.target.closest?.(".lc"); if (el) scrub(el, e.clientX); });
document.addEventListener("pointerout", (e) => { const el = e.target.closest?.(".lc"); if (el && !el.contains(e.relatedTarget)) unscrub(el); });
document.addEventListener("pointercancel", (e) => { const el = e.target.closest?.(".lc"); if (el) unscrub(el); });
document.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") { const el = e.target.closest?.(".lc"); if (el) unscrub(el); } });
window.addEventListener("resize", () => drawCharts());

const rangeSeg = (key, opts) => `<div class="seg small">${[...opts, "Custom"].map((r) => `<button class="${ui.range[key] === r ? "on" : ""}" data-act="${r === "Custom" ? "custom" : "range"}" data-k="${key}" data-r="${r}">${r}</button>`).join("")}</div>`;

// ---------- layout ----------

const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z"/>',
  invest: '<path d="M4 19h16M6 16V10M11 16V6M16 16v-4"/>',
  assets: '<circle cx="12" cy="12" r="8"/><path d="M12 7v10M9 9.5c0-1 1.3-1.8 3-1.8s3 .8 3 1.8-1.3 1.6-3 1.9-3 .9-3 1.9 1.3 1.8 3 1.8 3-.8 3-1.8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
};
function renderNav() {
  const base = route.split("/")[0], tab = base === "settings" ? "settings" : "home";
  const items = [["home", "Home"], ["settings", "Data"]];
  $("#nav").innerHTML = items.map(([k, l]) =>
    `<button class="${tab === k ? "on" : ""}" data-tab="${k}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>${l}</button>`).join("");
}

function render(keepScroll) {
  CHARTS.clear(); READOUTS.clear(); MOVES.clear();
  renderNav();
  const v = value();
  const base = route.split("/")[0], arg = decodeURIComponent(route.split("/").slice(1).join("/"));
  if (base === "invest") route = "home/investments";
  if (base === "assets") route = "home/crypto";
  const views = { home: viewHome, settings: viewSettings };
  $("#view").innerHTML = base === "h" ? viewDetail(v, arg) : (views[base] || viewHome)(v);
  drawCharts();
  const chips = document.querySelector(".chips"), on = chips?.querySelector(".chip.on");
  if (on) chips.scrollLeft = on.offsetLeft - (chips.clientWidth - on.offsetWidth) / 2;
  if (!keepScroll) window.scrollTo(0, 0);
}
function go(r) { route = r; location.hash = r; render(); }

function row({ t, m, v, vm, tap, attrs = "", mid = "", lead = "" }) {
  return `<div class="row ${tap ? "tap" : ""}" ${attrs}>${lead}<div class="l"><div class="t">${t}</div>${m ? `<div class="m">${m}</div>` : ""}</div>${mid}<div class="v num">${v}${vm ? `<div class="m">${vm}</div>` : ""}</div></div>`;
}
const badges = (l) => (l.stale ? '<span class="badge">STALE</span>' : "") + (l.manual ? '<span class="badge">MANUAL</span>' : "") + (l.estimate ? '<span class="badge">EST</span>' : "");

function warnings(v) {
  const w = [];
  if (pricesErr) w.push(pricesErr);
  if (v.missing?.length) w.push(`No price for: ${v.missing.map(esc).join(", ")}. Total excludes them, and no snapshot is saved today.`);
  const stale = v.lines.filter((l) => l.stale && l.value != null);
  if (stale.length) w.push(`${stale.length} stale price${stale.length > 1 ? "s" : ""}: ${stale.map((l) => esc(l.name)).join(", ")}`);
  return w.map((x) => `<div class="warn">${x}</div>`).join("");
}

/** Latest-day change in £ across market-priced lines. */
function marketDayChange(lines) {
  let abs = 0, base = 0;
  for (const l of lines) {
    const leg = legFor(l), dc = leg && C.dayChange(leg.series);
    if (dc && l.value != null) { abs += dc.abs * l.units; base += l.value - dc.abs * l.units; }
  }
  return base ? { abs, pct: (abs / base) * 100 } : null;
}

// ---------- views ----------

const CATS = [
  { k: "all", label: "All" },
  { k: "investments", label: "Investments", group: "Investments", s: "s1" },
  { k: "crypto", label: "Crypto", group: "Crypto", s: "s2" },
  { k: "cash", label: "Cash", group: "Cash savings", s: "s3" },
  { k: "car", label: "Car", group: "Car", s: "s5" },
  { k: "bullion", label: "Bullion", group: "Gold & silver", s: "s4" },
];
const catOf = (k) => CATS.find((c) => c.k === k) || CATS[0];
const snapSeries = (group) => store.snapshots.filter((s) => s.totals && s.totals[group] != null).map((s) => [s.date, s.totals[group]]);
const addRow = (act, label, sub = "") => `<div class="row tap" data-act="${act}" data-id=""><div class="l"><div class="t" style="color:var(--accent)">+ ${label}</div>${sub ? `<div class="m">${sub}</div>` : ""}</div></div>`;

const MOVES = new Map();
const moveAmt = (abs, fmt) => (fmt === priceFmt ? (abs >= 0 ? "+" : "−") + priceFmt(Math.abs(abs)) : signed(abs, 0));
const span = (m) => (m.from === m.to ? fmtDate(m.to, true) : `${fmtDate(m.from)} – ${fmtDate(m.to, true)}`);
/** Biggest rise/fall in a window, as chart bands plus tappable rows naming the drivers. */
function movesFor(key, w, legs, fmt) {
  if (w.length < 3) return { bands: [], html: "" };
  const m = C.biggestMoves(w), rows = [];
  for (const dir of ["down", "up"]) {
    const mv = m[dir];
    if (!mv) continue;
    const contrib = legs ? C.contributions(legs, mv.from, mv.to) : [];
    MOVES.set(key + dir, { ...mv, dir, contrib, fmt });
    const top = contrib.filter((c) => Math.sign(c.abs) === Math.sign(mv.abs)).slice(0, 2);
    rows.push(`<div class="move tap" data-act="move" data-m="${key + dir}">
      <div class="mt"><span class="${dir === "up" ? "pos" : "neg"}"><span class="mdot" style="background:var(--${dir === "up" ? "pos" : "neg"})"></span>${dir === "up" ? "Largest rise" : "Largest fall"} ${moveAmt(mv.abs, fmt)} (${pct(mv.pct)})</span><span class="d">${span(mv)}</span></div>
      ${top.length ? `<div class="md">Mostly ${top.map((c) => `${esc(c.name)} <b class="${cls(c.abs)}">${signed(c.abs, 0)}</b>`).join(", ")}${contrib.length > 2 ? " ›" : ""}</div>` : ""}
    </div>`);
  }
  return { bands: ["down", "up"].filter((d) => m[d]).map((d) => ({ ...m[d], dir: d })), html: rows.length ? `<div class="moves">${rows.join("")}</div>` : "" };
}

/** The shared layout: readout, chart, range buttons, biggest moves, footnote. */
function chartCard(key, { title, right = "", pts, ranges = ["1W", "1M", "3M", "1Y"], fmt = (x) => money(x, 0), note = "", empty, value, legs = null, moves = false }) {
  if (!ranges.includes(ui.range[key]) && ui.range[key] !== "Custom") ui.range[key] = ranges.at(-1) === "5Y" ? "1Y" : ranges.at(-1);
  const w = windowFor(key, pts), wc = C.windowChange(w);
  const mv = moves ? movesFor(key, w, legs, fmt) : { bands: [], html: "" };
  return `<div class="chartcard">
    <div class="lab"><span>${title}</span><span>${right}</span></div>
    ${readout("ro-" + key, w.at(-1)?.[1] ?? value ?? 0, wc?.abs, wc?.pct, w.length > 1 ? rangeLabel(key) : "", fmt)}
    ${lineChart(w, { h: 190, readout: "ro-" + key, fmt, empty, bands: mv.bands })}
    ${rangeSeg(key, ranges)}
    ${mv.html}
    ${note ? `<div class="lab" style="margin-top:6px"><span>${note}</span></div>` : ""}
  </div>`;
}

function viewHome(v) {
  if (!v.lines.length) {
    return `<div class="hero"><h1>Net worth</h1><div class="big">£0</div><div class="sub">No holdings on this device yet. Import a backup or your Fidelity files to start.</div></div>
      <button class="btn" data-act="go" data-to="settings">Import your data</button>`;
  }
  const cat = catOf(route.split("/")[1]);
  const dc = marketDayChange(v.lines.filter((l) => l.kind === "fund" || l.kind === "crypto"));
  const ch = C.changeVsPrevious(store.snapshots, today(), v.total);
  const chips = CATS.map((c) => `<button class="chip ${c.k === cat.k ? "on" : ""}" data-act="cat" data-c="${c.k}">${c.s ? `<span class="key" style="background:var(--${c.s})"></span>` : ""}${c.label}</button>`).join("");
  const panels = { all: panelAll, investments: panelInvest, crypto: panelCrypto, cash: panelCash, car: panelCar, bullion: panelBullion };
  return `<div class="hero"><h1>Net worth</h1><div class="big">${money(v.total, 0)}</div>
      ${dc ? `<div class="sub"><span class="${cls(dc.abs)} num">${signed(dc.abs)} (${pct(dc.pct)})</span> latest market day</div>` : ""}
      <div class="sub">${ch ? `<span class="${cls(ch.amount)} num">${signed(ch.amount)}</span> since ${fmtDate(ch.since)} · ` : ""}prices ${prices ? fmtDate(prices.generated_at) : "—"}</div>
    </div>
    <div class="chips" role="tablist">${chips}</div>
    ${warnings(v)}
    ${panels[cat.k](v)}
    <p class="note">Excludes house, mortgage and joint assets.</p>`;
}

function panelAll(v) {
  const market = v.lines.filter((l) => l.kind === "fund" || l.kind === "crypto");
  const marketNow = market.reduce((s, l) => s + (l.value || 0), 0);
  const other = v.total - marketNow;
  const legs = market.map(legFor).filter(Boolean);
  const pts = C.holdingsSeries(legs).map(([d, x]) => [d, C.round2(x + other)]);
  const fundLegs = market.filter((l) => l.kind === "fund").map(legFor), coinLegs = market.filter((l) => l.kind === "crypto").map(legFor);
  const loanPts = store.loan ? loanSchedule(store.loan).filter(([d]) => d <= today()).map(([d, b]) => [d, -b]) : [];
  const catSeries = { investments: () => C.holdingsSeries(fundLegs), crypto: () => C.holdingsSeries(coinLegs),
    cash: () => snapSeries("Cash savings"), car: () => snapSeries("Car"), bullion: () => snapSeries("Gold & silver"), loan: () => loanPts };
  const chg = (k) => { const w = windowFor("all", catSeries[k]()); return C.windowChange(w); };
  const chgHtml = (c) => c && Math.abs(c.abs) < 0.005 ? `<span class="chg" style="color:var(--muted)">no change</span>` : c ? `<span class="chg ${cls(c.abs)}">${signed(c.abs, 0)} (${pct(c.pct)})</span>` : `<span class="chg" style="color:var(--muted)">no history</span>`;
  const assets = CATS.filter((c) => c.group && v.totals[c.group] > 0);
  const assetTotal = assets.reduce((s, c) => s + v.totals[c.group], 0);
  const snaps = store.snapshots.map((s) => [s.date, s.total]);
  return chartCard("all", { title: "Over time", right: "Indicative", pts, value: v.total, legs, moves: true,
      note: "Today's holdings at past prices; cash, car and loan held at today's values." }) +
    `<h2><span>Allocation</span><span>${esc(rangeLabel("all").replace(/^over /, ""))}</span></h2><div class="card">
      <div style="padding:0 0 10px"><div class="alloc" role="img" aria-label="Asset allocation">${assets.map((c) => `<i style="width:${(v.totals[c.group] / assetTotal) * 100}%;background:var(--${c.s})" title="${c.label}"></i>`).join("")}</div></div>
      ${assets.map((c) => row({ lead: `<span class="key" style="background:var(--${c.s})"></span>`, t: c.label, m: ((v.totals[c.group] / assetTotal) * 100).toFixed(1) + "% of assets", v: money(v.totals[c.group], 0), vm: chgHtml(chg(c.k)), tap: 1, attrs: `data-act="cat" data-c="${c.k}"` })).join("")}
      ${v.totals["Car loan"] ? row({ lead: `<span class="key" style="background:var(--line)"></span>`, t: "Car loan", m: "liability · repaid in range", v: `<span class="neg">${money(v.totals["Car loan"], 0)}</span>`, vm: chgHtml(chg("loan")), tap: 1, attrs: `data-act="cat" data-c="car"` }) : ""}
    </div>
    <div class="chartcard"><div class="lab"><span>Recorded net worth</span><span>${snaps.length} daily snapshot${snaps.length === 1 ? "" : "s"}</span></div>
      ${lineChart(snaps, { h: 140, empty: "Builds from one snapshot a day, starting from your second day of use" })}</div>`;
}

function panelInvest(v) {
  const funds = v.lines.filter((l) => l.group === "Investments");
  if (!funds.length) return `<div class="note">No funds yet. Import your Fidelity files in Data.</div>`;
  const fl = funds.filter((l) => l.kind === "fund");
  const val = fl.reduce((s, l) => s + (l.value || 0), 0), book = fl.reduce((s, l) => s + (l.bookCost || 0), 0);
  const inv = fl.reduce((s, l) => s + (l.invested || 0), 0), wd = fl.reduce((s, l) => s + (l.withdrawn || 0), 0);
  const dc = marketDayChange(fl);
  const accts = [...new Set(funds.map((l) => l.account || l.id.split("|")[1]))];
  let html = chartCard("investments", { title: `Fidelity · ${fl.length} funds`, right: dc ? `Latest day <b class="${cls(dc.abs)}">${signed(dc.abs, 0)}</b>` : "",
      pts: C.holdingsSeries(fl.map(legFor)), ranges: ["1W", "1M", "3M", "1Y", "5Y"], value: v.totals.Investments, legs: fl.map(legFor), moves: true,
      note: "Indicative: today's units at past prices." }) +
    `<div class="stats">
      <div class="stat"><div class="k">Net invested</div><div class="v">${money(inv - wd, 0)}</div></div>
      <div class="stat"><div class="k">Growth since start</div><div class="v ${cls(val - inv + wd)}">${signed(val - inv + wd, 0)}</div></div>
      <div class="stat"><div class="k">Gain vs book cost</div><div class="v ${cls(val - book)}">${signed(val - book, 0)}</div></div>
      <div class="stat"><div class="k">Return on book cost</div><div class="v ${cls(val - book)}">${pct(((val - book) / book) * 100)}</div></div>
    </div>`;
  for (const a of accts) {
    const ls = funds.filter((l) => (l.account || l.id.split("|")[1]) === a).sort((x, y) => (y.value || 0) - (x.value || 0));
    const acctFunds = ls.filter((l) => l.kind === "fund");
    const aw = windowFor("investments", C.holdingsSeries(acctFunds.map(legFor))), ac = C.windowChange(aw);
    html += `<h2><span>${esc(a)}</span><span class="num">${money(ls.reduce((s, l) => s + (l.value || 0), 0), 0)}${ac ? ` <span class="chg ${cls(ac.abs)}">${signed(ac.abs, 0)} (${pct(ac.pct)})</span>` : ""}</span></h2><div class="card">` +
      ls.map((l) => {
        if (l.kind !== "fund") return row({ t: esc(l.name), m: `updated ${fmtDate(l.asOf)}`, v: money(l.value), tap: 1, attrs: `data-act="cash" data-acct="${esc(a)}"` });
        const w = windowFor("investments", seriesPts(fundSeries(l.isin))), wc = C.windowChange(w);
        const f = store.funds.find((x) => `${x.account}|${x.isin}` === l.id);
        return row({ t: esc(l.name), m: `<span class="pill">${f?.shareClass || "—"}</span>${wc ? `<span class="${cls(wc.abs)}">${signed(wc.abs * l.units, 0)}</span>` : fmtDate(l.asOf)}${badges(l)}`,
          mid: sparkline(w), v: money(l.value, 0), vm: `<span class="chg ${cls(wc?.pct)}">${pct(wc?.pct)}</span>`,
          tap: 1, attrs: `data-act="go" data-to="h/${encodeURIComponent("fund:" + l.id)}"` });
      }).join("") + "</div>";
  }
  return html + `<p class="note">Fund rows follow the selected range (${esc(rangeLabel("investments").replace(/^over /, ""))}): price change %, sparkline, and £ change on today's units. Income (Inc) funds show price only, excluding income paid out. XIRR and year-by-year growth need your Fidelity transaction history.</p>`;
}

function panelCrypto(v) {
  const cl = v.lines.filter((l) => l.kind === "crypto");
  if (!cl.length) return `<div class="note">No crypto held.</div>`;
  return chartCard("crypto", { title: `${cl.length} coins`, right: "Indicative", pts: C.holdingsSeries(cl.map(legFor)), value: v.totals.Crypto, legs: cl.map(legFor), moves: true,
      note: "Today's balances at past prices. CoinGecko free history covers one year." }) +
    `<h2><span>Holdings</span><span class="num">${money(v.totals.Crypto, 0)}</span></h2><div class="card">` +
    cl.map((l) => {
      const w = windowFor("crypto", seriesPts(coinSeries(l.name))), wc = C.windowChange(w);
      return row({ t: esc(l.name), m: `${l.units} · ${priceFmt(l.price)}${badges(l)}`, mid: sparkline(w),
        v: money(l.value), vm: `<span class="chg ${cls(wc?.pct)}">${pct(wc?.pct)}</span>`, tap: 1, attrs: `data-act="go" data-to="h/${encodeURIComponent("coin:" + l.name)}"` });
    }).join("") + `</div><p class="note">Rows follow the selected range. Balances only, so no gain on cost is shown.</p>`;
}

function panelCash(v) {
  const sl = v.lines.filter((l) => l.kind === "savings");
  const weighted = sl.reduce((s, l) => s + (l.value || 0) * (l.rate || 0), 0) / (v.totals["Cash savings"] || 1);
  return chartCard("cash", { title: "Cash savings", right: sl.length ? `Blended ${weighted.toFixed(2)}% AER` : "", pts: snapSeries("Cash savings"),
      value: v.totals["Cash savings"], ranges: ["1M", "3M", "1Y"], empty: "Builds from your daily snapshots as balances change" }) +
    `<h2><span>Accounts</span><span class="num">${money(v.totals["Cash savings"] ?? 0, 0)}</span></h2><div class="card">` +
    sl.map((l) => row({ t: esc(l.name), m: `${l.rate != null ? l.rate + "% AER · " : ""}updated ${fmtDate(l.asOf)}`, v: money(l.value), tap: 1, attrs: `data-act="saving" data-id="${esc(l.id.slice(4))}"` })).join("") +
    addRow("saving", "Add account") + `</div><p class="note">Tap an account to update its balance.</p>`;
}

function panelCar(v) {
  const car = v.lines.find((l) => l.kind === "car"), loan = v.lines.find((l) => l.kind === "loan");
  const lp = loan?.loan, equity = (car?.value || 0) - (lp?.balance || 0);
  let html = "";
  if (store.loan) {
    const sched = loanSchedule(store.loan);
    html += `<div class="chartcard"><div class="lab"><span>Car value less loan</span><span>${car ? "Car " + money(car.value, 0) + " (est.)" : ""}</span></div>
      ${readout("ro-car", equity, null, null, "today", (x) => money(x, 0))}
      <div class="lab" style="margin-top:8px"><span>Loan balance over the term</span><span>Paid off ${fmtDate(lp.payoffDate, true)}</span></div>
      ${lineChart(sched, { h: 170, readout: "ro-car", fmt: (x) => money(x, 0) })}
      <div class="lab" style="margin-top:6px"><span>Drag the chart to see the balance at any month.</span></div></div>
    <div class="stats">
      <div class="stat"><div class="k">Payments made / left</div><div class="v">${lp.paymentsMade} / ${lp.paymentsLeft}</div></div>
      <div class="stat"><div class="k">Loan balance</div><div class="v neg">${money(lp.balance, 0)}</div></div>
      <div class="stat"><div class="k">Interest paid</div><div class="v">${money(lp.interestPaid, 0)}</div></div>
      <div class="stat"><div class="k">Interest to come</div><div class="v">${money(lp.interestRemaining, 0)}</div></div>
    </div>`;
  }
  html += `<h2><span>Car &amp; loan</span><span class="num">${money(equity, 0)}</span></h2><div class="card">` +
    (car ? row({ t: esc(car.name) + badges(car), m: `${esc(car.source)} · ${fmtDate(car.asOf)}`, v: money(car.value, 0), tap: 1, attrs: `data-act="car"` }) : addRow("car", "Add car value")) +
    (loan ? row({ t: "Car loan (unsecured)" + badges(loan), m: `${lp.paymentsLeft} payments left · ${store.loan.apr}% APR`, v: `<span class="neg">${money(loan.value)}</span>`, tap: 1, attrs: `data-act="loan"` }) : addRow("loan", "Add loan")) +
    `</div>${lp ? `<p class="note">Loan basis: ${esc(lp.basis)}. Tap the loan to add a statement balance.</p>` : ""}`;
  return html;
}

function panelBullion(v) {
  const ml = v.lines.filter((l) => l.kind === "metal");
  return (ml.length ? chartCard("bullion", { title: "Gold & silver", pts: snapSeries("Gold & silver"), value: v.totals["Gold & silver"], ranges: ["1M", "3M", "1Y"],
      empty: "Builds from your daily snapshots" }) : `<div class="chartcard"><div class="lab"><span>Gold &amp; silver</span></div><p class="note" style="text-align:center;padding:30px 0">Nothing held yet. Add a holding when you buy, in troy ounces or grams.</p></div>`) +
    `<h2><span>Holdings</span><span class="num">${money(v.totals["Gold & silver"] ?? 0, 0)}</span></h2><div class="card">` +
    ml.map((l) => row({ t: esc(l.name), m: `${(l.units || 0).toFixed(3)} ozt · ${l.source}`, v: money(l.value), tap: 1, attrs: `data-act="metal" data-id="${esc(l.id.slice(6))}"` })).join("") +
    addRow("metal", "Add holding", "Metal, quantity, date, cost, platform") + `</div>`;
}

function viewDetail(v, arg) {
  const kind = arg.split(":")[0], id = arg.slice(arg.indexOf(":") + 1);
  const l = v.lines.find((x) => (kind === "fund" ? x.id === id : x.kind === "crypto" && x.name === id));
  if (!l) return `<button class="back" data-act="back">‹ Back</button><p class="note">Holding not found.</p>`;
  const series = kind === "fund" ? fundSeries(l.isin) : coinSeries(l.name);
  if (ui.range.detail === "5Y" && kind !== "fund") ui.range.detail = "1Y";
  const pricePts = windowFor("detail", seriesPts(series));
  const holding = ui.detailMode === "holding";
  const pts = holding ? pricePts.map(([d, p]) => [d, C.round2(p * l.units)]) : pricePts;
  const fmt = holding ? (x) => money(x, 0) : priceFmt;
  const wc = C.windowChange(pts);
  const ranges = kind === "fund" ? ["1W", "1M", "3M", "1Y", "5Y"] : ["1W", "1M", "3M", "1Y"];
  const f = kind === "fund" ? store.funds.find((x) => `${x.account}|${x.isin}` === id) : null;
  const rec = f ? C.reconcile([f], prices, store.priceOverrides)[0] : null;
  const ov = f ? store.priceOverrides[f.isin] : null;
  const stat = (k, val, c = "", wide = "") => `<div class="stat ${wide}"><div class="k">${k}</div><div class="v ${c}">${val}</div></div>`;
  let stats;
  if (f) {
    const tr = l.value + f.withdrawn - f.invested;
    stats = stat("Your units", f.units.toLocaleString("en-GB", { maximumFractionDigits: 4 })) + stat("Value", money(l.value)) +
      stat("Book cost", money(f.bookCost)) + stat("Gain vs book", signed(l.value - f.bookCost), cls(l.value - f.bookCost)) +
      stat("Total invested", money(f.invested)) + stat("Withdrawn incl. income", money(f.withdrawn)) +
      stat("Total return", signed(tr), cls(tr)) + stat("Return on invested", pct((tr / f.invested) * 100), cls(tr)) +
      stat("Price", `${priceFmt(l.price)} · ${esc(l.source)} · ${fmtDate(l.asOf)}${badges(l)}`, "", "wide") +
      stat(`Fidelity value (${fmtDate(f.importedAt)})`, `${money(f.fidelityValue)} <span class="${cls(rec.diff)}" style="font-size:13px">${signed(rec.diff)} vs now</span>`, "", "wide");
  } else {
    stats = stat("Balance", `${l.units} ${esc(l.name)}`) + stat("Value", money(l.value)) +
      stat("Price", `${priceFmt(l.price)} · ${esc(l.source)} · ${fmtDate(l.asOf)}${badges(l)}`, "", "wide") +
      stat("Cost basis", "Not held, so no gain shown", "", "wide");
  }
  return `<div class="top"><button class="back" data-act="back">‹ Back</button></div>
    <div class="title">${esc(f ? f.name : l.name)}</div>
    <div class="subt">${f ? `${esc(f.account)} · ${esc(f.isin)} · ${f.shareClass}` : "Crypto · CoinGecko"}</div>
    <div class="chartcard">
      <div class="seg small" style="margin:0 0 10px">${[["price", "Price"], ["holding", "My holding"]].map(([k, t]) => `<button class="${ui.detailMode === k ? "on" : ""}" data-act="mode" data-m="${k}">${t}</button>`).join("")}</div>
      ${readout("ro-d", pts.at(-1)?.[1] ?? l.value, wc?.abs, wc?.pct, rangeLabel("detail"), fmt)}
      ${(() => { const mv = movesFor("detail", pts, null, fmt); return lineChart(pts, { h: 220, readout: "ro-d", fmt, bands: mv.bands }) + rangeSeg("detail", ranges) + mv.html; })()}
      <div class="lab" style="margin-top:6px"><span>${holding ? "Indicative: today's units at past prices." : f?.shareClass === "Inc" ? "Price only. Income units fall when income is paid out, so this understates total return." : "Daily closing prices."}</span></div>
    </div>
    <div class="stats">${stats}</div>
    ${f ? `<details><summary>Manual price override</summary><form id="ovf"><label>£ per unit (blank to clear)</label>
      <input name="p" type="number" inputmode="decimal" step="any" value="${ov?.price ?? ""}" data-isin="${esc(f.isin)}">
      <button class="btn ghost" type="submit">Save override</button></form></details>`
    : `<button class="btn ghost" data-act="crypto" data-sym="${esc(l.name)}">Edit balance</button>`}`;
}

function loanSchedule(loan) {
  const pts = [], r = C.monthlyRateFromApr(loan.apr);
  let b = loan.principal;
  for (let k = 0; k <= loan.termMonths; k++) {
    pts.push([C.addMonths(loan.startDate, k), C.round2(Math.max(0, b))]);
    b = b * (1 + r) - loan.payment;
  }
  return pts;
}

function viewSettings() {
  const imp = store.lastImport;
  let rec = "";
  if (store.funds.length) {
    const r = C.reconcile(store.funds, prices, store.priceOverrides);
    const tf = r.reduce((s, x) => s + (x.fidelityValue || 0), 0), ta = r.reduce((s, x) => s + (x.appValue || 0), 0);
    rec = `<h2>Reconciliation to Fidelity</h2><div class="card" style="padding:10px">
      <div class="note" style="margin:0 0 8px">Fidelity file ${fmtDate(imp?.asOf)} vs app at today's prices. Differences are shown, never balanced off.</div>
      <table><tr><th>Fund</th><th class="num">Fidelity</th><th class="num">App</th><th class="num">Diff</th></tr>
      ${r.map((x) => `<tr><td>${esc(x.name.slice(0, 26))}<div style="color:var(--muted);font-size:12px">${x.account} · price ${pct(x.priceDiffPct)} · ${fmtDate(x.appAsOf)}</div></td><td class="num">${money(x.fidelityValue)}</td><td class="num">${money(x.appValue)}</td><td class="num ${cls(x.diff)}">${x.diff == null ? "no price" : signed(x.diff)}</td></tr>`).join("")}
      <tr><th>Total</th><th class="num">${money(tf)}</th><th class="num">${money(ta)}</th><th class="num ${cls(ta - tf)}">${signed(C.round2(ta - tf))}</th></tr></table></div>`;
  }
  return `<h1>Data</h1>
    <h2>Fidelity</h2>
    <button class="btn" data-act="pickcsv">Import Fidelity holdings CSV</button>
    <p class="note">Download the holdings CSV for each account from Fidelity and pick it here. Units update; the file stays on this device. ${imp ? `Last import: ${fmtDate(imp.asOf)} (${imp.accounts.join(", ")}).` : ""}</p>
    ${rec}
    <h2>Backup</h2>
    <button class="btn ghost" data-act="export">Export backup (JSON)</button>
    <button class="btn ghost" data-act="pickjson">Restore / import backup</button>
    <p class="note">Your holdings live only in this browser. Export after changes, and to move to another device.</p>
    <h2>Appearance</h2>
    <div class="seg">${[["dark", "Dark"], ["light", "Light"], ["system", "Match device"]].map(([k, l]) => `<button class="${(store.theme || "dark") === k ? "on" : ""}" data-act="theme" data-t="${k}">${l}</button>`).join("")}</div>
    <h2>Prices</h2>
    <div class="card" style="padding:12px 0"><div class="kv">
      <div>Prices file</div><div>${prices ? fmtDate(prices.generated_at) : "not loaded"}</div>
      <div>Price history</div><div>${priceHist.generated_at ? fmtDate(priceHist.generated_at) : "not loaded"}</div>
      <div>Funds</div><div>FT, daily close</div><div>Crypto</div><div>CoinGecko</div>
      <div>Snapshots stored</div><div>${store.snapshots.length}</div></div></div>
    <button class="btn ghost" data-act="refresh">Refresh prices</button>
    <button class="btn danger" data-act="wipe">Delete all data on this device</button>
    <input type="file" id="fcsv" accept=".csv,text/csv" multiple hidden>
    <input type="file" id="fjson" accept=".json,application/json" hidden>`;
}

// ---------- sheets / forms ----------

function sheet(html) { $("#sheet").innerHTML = html; $("#dlg").showModal(); }
function closeSheet() { $("#dlg").close(); }
function alertSheet(msg) { sheet(`<h3>Note</h3><p>${msg}</p><button class="btn" data-act="close">OK</button>`); }

function form(title, fields, onSave, extra = "") {
  sheet(`<h3>${esc(title)}</h3><form id="frm">${fields.map((f) => `<label for="f_${f.k}">${esc(f.label)}</label>` +
    (f.options ? `<select id="f_${f.k}" name="${f.k}">${f.options.map((o) => `<option ${o === f.value ? "selected" : ""}>${o}</option>`).join("")}</select>`
      : `<input id="f_${f.k}" name="${f.k}" type="${f.type || "text"}" ${f.type === "number" ? `inputmode="decimal" step="${f.step || "any"}"` : ""} value="${esc(f.value ?? "")}">`)).join("")}
    <button class="btn" type="submit">Save</button>${extra}<button class="btn ghost" type="button" data-act="close">Cancel</button></form>`);
  $("#frm").onsubmit = (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    for (const f of fields) if (f.type === "number") d[f.k] = d[f.k] === "" ? null : parseFloat(d[f.k]);
    onSave(d); save(); closeSheet(); render(true);
  };
}

const ACTIONS = {
  go: (el) => go(el.dataset.to),
  cat: (el) => { route = "home/" + el.dataset.c; history.replaceState(null, "", "#" + route); render(true); },
  back: () => (window.history.length > 1 ? window.history.back() : go("home")),
  range: (el) => { ui.range[el.dataset.k] = el.dataset.r; render(true); },
  mode: (el) => { ui.detailMode = el.dataset.m; render(true); },
  custom: (el) => {
    const k = el.dataset.k, c = ui.custom[k] || {};
    const yearAgo = C.addMonths(today(), -12);
    sheet(`<h3>Custom date range</h3><form id="cr">
      <label for="cr_from">From</label><input id="cr_from" name="from" type="date" value="${esc(c.from || yearAgo)}" max="${today()}">
      <label for="cr_to">To</label><input id="cr_to" name="to" type="date" value="${esc(c.to || today())}" max="${today()}">
      <p class="note">Funds have daily prices from Nov 2021; crypto from Nov 2025. History grows from here.</p>
      <button class="btn" type="submit">Apply</button><button class="btn ghost" type="button" data-act="close">Cancel</button></form>`);
    $("#cr").onsubmit = (e) => {
      e.preventDefault();
      let { from, to } = Object.fromEntries(new FormData(e.target));
      if (from && to && from > to) [from, to] = [to, from];
      ui.custom[k] = { from, to }; ui.range[k] = "Custom"; closeSheet(); render(true);
    };
  },
  close: () => closeSheet(),
  theme: (el) => { store.theme = el.dataset.t; save(); applyTheme(); render(true); },
  move: (el) => {
    const m = MOVES.get(el.dataset.m);
    if (!m) return;
    const total = m.contrib.reduce((s, c) => s + c.abs, 0);
    sheet(`<h3>${m.dir === "up" ? "Largest rise" : "Largest fall"}: ${span(m)}</h3>
      <div class="readout"><div class="p num ${cls(m.abs)}">${moveAmt(m.abs, m.fmt)}</div><div class="d">${pct(m.pct)} over ${m.from === m.to ? "the day" : "the period"}</div></div>
      ${m.contrib.length ? `<h2>What drove it</h2><div class="card">${m.contrib.map((c) => row({ t: esc(c.name), m: `${((c.abs / total) * 100).toFixed(0)}% of the move`, v: `<span class="${cls(c.abs)}">${signed(c.abs, 0)}</span>` })).join("")}</div>
        <p class="note">Each holding's price change over the period × today's units. Cash, car and loan don't move on this chart.</p>` : `<p class="note">Price move for this holding only.</p>`}
      <button class="btn" data-act="close">Close</button>`);
  },
  cash: (el) => {
    const a = el.dataset.acct, c = store.fidelityCash[a] || {};
    form(`Fidelity cash — ${a}`, [{ k: "amount", label: "Cash balance (£)", type: "number", value: c.amount ?? 0 }],
      (d) => { store.fidelityCash[a] = { amount: d.amount || 0, asOf: today() }; });
  },
  crypto: (el) => {
    const c = store.crypto.find((x) => x.symbol === el.dataset.sym);
    form(`${c.symbol} balance`, [{ k: "units", label: `Units of ${c.symbol}`, type: "number", value: c.units }],
      (d) => { c.units = d.units || 0; c.asOf = today(); });
  },
  saving: (el) => {
    const id = el.dataset.id, s = store.savings.find((x) => x.id === id) || {};
    form(id ? s.name : "Add savings account", [
      { k: "name", label: "Name", value: s.name }, { k: "balance", label: "Balance (£)", type: "number", value: s.balance },
      { k: "aer", label: "AER (%)", type: "number", value: s.aer }],
    (d) => { if (id) Object.assign(s, d, { asOf: today() }); else store.savings.push({ id: "s" + Date.now(), ...d, asOf: today() }); },
    id ? `<button class="btn danger" type="button" data-act="delsaving" data-id="${esc(id)}">Remove account</button>` : "");
  },
  delsaving: (el) => { store.savings = store.savings.filter((x) => x.id !== el.dataset.id); save(); closeSheet(); render(true); },
  metal: (el) => {
    const id = el.dataset.id, m = store.metals.find((x) => x.id === id) || {};
    form(id ? "Edit metal holding" : "Add gold / silver", [
      { k: "metal", label: "Metal", options: ["Gold", "Silver"], value: m.metal },
      { k: "quantity", label: "Quantity", type: "number", value: m.quantity },
      { k: "unit", label: "Unit", options: ["ozt", "g"], value: m.unit },
      { k: "date", label: "Purchase date", type: "date", value: m.date },
      { k: "cost", label: "Cost (£)", type: "number", value: m.cost },
      { k: "platform", label: "Platform", value: m.platform ?? "BullionVault" },
      { k: "manualValue", label: "Current value (£) until a metals feed is added", type: "number", value: m.manualValue }],
    (d) => { d.manualAsOf = today(); if (id) Object.assign(m, d); else store.metals.push({ id: "m" + Date.now(), ...d }); });
  },
  car: () => {
    const c = store.car || {};
    form("Car value", [
      { k: "name", label: "Car", value: c.name ?? "" },
      { k: "value", label: "Estimated value (£)", type: "number", value: c.value },
      { k: "source", label: "Source of estimate", value: c.source }],
    (d) => { store.car = { ...d, asOf: today() }; });
  },
  loan: () => {
    const l = store.loan || {};
    form("Car loan", [
      { k: "startDate", label: "Start date", type: "date", value: l.startDate },
      { k: "principal", label: "Principal (£)", type: "number", value: l.principal },
      { k: "apr", label: "APR (%)", type: "number", value: l.apr },
      { k: "payment", label: "Monthly payment (£)", type: "number", value: l.payment },
      { k: "termMonths", label: "Term (months)", type: "number", value: l.termMonths },
      { k: "statementBalance", label: "Latest statement balance (£, optional)", type: "number", value: l.statementBalance },
      { k: "statementDate", label: "Statement date", type: "date", value: l.statementDate }],
    (d) => { if (!d.statementBalance) { d.statementBalance = null; d.statementDate = null; } store.loan = { ...l, ...d }; });
  },
  pickcsv: () => $("#fcsv").click(),
  pickjson: () => $("#fjson").click(),
  export: () => {
    const blob = new Blob([JSON.stringify(store, null, 1)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `networth-backup-${today()}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  refresh: async () => { await Promise.all([loadPrices(), loadHistory(), loadLiveCrypto()]); render(true); },
  wipe: () => sheet(`<h3>Delete all data?</h3><p>This removes holdings and snapshot history from this device. Export a backup first.</p>
    <button class="btn danger" data-act="wipe2">Delete everything</button><button class="btn ghost" data-act="close">Cancel</button>`),
  wipe2: () => { const theme = store.theme; store = { ...EMPTY, theme }; save(); closeSheet(); render(); },
};

document.addEventListener("click", (e) => {
  const navb = e.target.closest("[data-tab]");
  if (navb) { go(navb.dataset.tab); return; }
  const el = e.target.closest("[data-act]");
  if (el && ACTIONS[el.dataset.act]) ACTIONS[el.dataset.act](el);
});
$("#dlg").addEventListener("click", (e) => { if (e.target.id === "dlg") closeSheet(); });

document.addEventListener("submit", (e) => {
  if (e.target.id !== "ovf") return;
  e.preventDefault();
  const inp = e.target.querySelector("input"), p = parseFloat(inp.value), isin = inp.dataset.isin;
  if (p > 0) store.priceOverrides[isin] = { price: p, asOf: today() }; else delete store.priceOverrides[isin];
  save(); render(true);
});

document.addEventListener("change", async (e) => {
  if (e.target.id === "fcsv") {
    const msgs = [];
    for (const file of e.target.files) {
      try {
        const imp = C.parseFidelityHoldingsCsv(await file.text());
        const m = C.mergeFidelityImport(store.funds, imp);
        store.funds = m.funds;
        store.fidelityCash[imp.account] ??= { amount: 0, asOf: today() };
        store.lastImport = { asOf: imp.asOf, accounts: [...new Set([...(store.lastImport?.accounts || []), imp.account])] };
        msgs.push(`<b>${imp.account}</b>: ${imp.holdings.length} funds, ${money(imp.holdings.reduce((s, h) => s + h.fidelityValue, 0))} at Fidelity's prices.` +
          (m.added.length ? `<br>Added: ${m.added.map(esc).join(", ")}` : "") +
          (m.removed.length ? `<br>Removed: ${m.removed.map(esc).join(", ")}` : "") +
          (m.changed.length ? `<br>Units changed: ${m.changed.map(esc).join("; ")}` : ""));
      } catch (err) { msgs.push(`${esc(file.name)}: ${esc(err.message)}`); }
    }
    save(); e.target.value = ""; render(true); alertSheet(msgs.join("<br><br>"));
  }
  if (e.target.id === "fjson") {
    try {
      const d = JSON.parse(await e.target.files[0].text());
      if (!Array.isArray(d.funds)) throw new Error("Not a backup file");
      store = { ...EMPTY, ...d, theme: store.theme }; save(); applyTheme(); await loadLiveCrypto(); render(); alertSheet("Backup restored.");
    } catch (err) { alertSheet("Couldn't import: " + esc(err.message)); }
    e.target.value = "";
  }
});

window.addEventListener("hashchange", () => { const r = location.hash.slice(1) || "home"; if (r !== route) { route = r; render(); } });

render();
await Promise.all([loadPrices(), loadHistory(), loadLiveCrypto()]);
render(true);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
