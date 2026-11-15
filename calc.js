// Pure calculation functions. No DOM, no storage — tested in tests/calc.test.mjs.

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

// ---------- prices ----------

/** Convert a raw quote to GBP. GBX/GBp are pence. */
export function toGbp(value, currency) {
  if (currency === "GBX" || currency === "GBp" || currency === "GBx") return value / 100;
  if (currency === "GBP") return value;
  throw new Error(`Unexpected currency ${currency}`);
}

/** Age in days between an ISO date/datetime and `now`. */
export function ageDays(asOf, now = new Date()) {
  if (!asOf) return Infinity;
  const t = new Date(asOf.length === 10 ? asOf + "T00:00:00Z" : asOf).getTime();
  return (now.getTime() - t) / 86400000;
}

/**
 * Stale rules: daily-priced funds are stale if older than 4 calendar days
 * (covers weekends and a bank holiday). Crypto stale after 24 hours.
 */
export function isStale(kind, asOf, now = new Date()) {
  const d = ageDays(asOf, now);
  if (kind === "fund") return d > 4;
  if (kind === "crypto") return d > 1;
  return d > 4;
}

/**
 * Resolve the price for a fund: manual override wins, then feed.
 * Returns {price, asOf, source, manual} or null.
 */
export function resolveFundPrice(isin, prices, overrides = {}) {
  const o = overrides[isin];
  if (o && o.price > 0) return { price: o.price, asOf: o.asOf, source: "manual", manual: true };
  const f = prices?.funds?.[isin];
  if (f && f.price_gbp > 0) return { price: f.price_gbp, asOf: f.as_of, source: `ft`, manual: false };
  return null;
}

// ---------- Fidelity CSV ----------

/** Minimal RFC4180 CSV line parser (quotes, commas). */
export function parseCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const num = (s) => {
  const v = parseFloat(String(s).replace(/[£,+]/g, ""));
  return Number.isFinite(v) ? v : 0;
};

/** Account type from Fidelity's second line, e.g. "Investment ISA -AS1…". */
export function fidelityAccountType(label) {
  const l = label.toLowerCase();
  if (l.includes("isa")) return "ISA";
  if (l.includes("sipp") || l.includes("pension")) return "SIPP";
  if (l.includes("investment account")) return "GIA";
  return "Other";
}

/**
 * Parse a Fidelity "holdings" CSV export.
 * Returns {account, asOf, holdings:[…]}. Account number is deliberately dropped.
 */
export function parseFidelityHoldingsCsv(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const m = lines[0].match(/(\d{2}):(\d{2}) GMT on (\d{2})\/(\d{2})\/(\d{4})/);
  const asOf = m ? `${m[5]}-${m[4]}-${m[3]}T${m[1]}:${m[2]}:00Z` : null;
  const account = fidelityAccountType(lines[1] || "");
  const hi = lines.findIndex((l) => l.startsWith("Fidelity Fund Name"));
  if (hi < 0) throw new Error("Not a Fidelity holdings file: header row not found");
  const head = parseCsvLine(lines[hi]);
  const col = (name) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`Column missing: ${name}`);
    return i;
  };
  const C = {
    name: col("Fidelity Fund Name"), isin: col("ISIN"), value: col("Value (£)"),
    units: col("Units"), book: col("Book Cost (£)"), price: col("Current Price (p)"),
    invested: col("Total Amount Invested (£)"),
    withdrawn: col("Total Withdrawn Incl. Income Paid (£)"),
    income: col("Total Income Paid Out (£)"),
  };
  const holdings = [];
  for (const line of lines.slice(hi + 1)) {
    if (!line.trim()) continue;
    const r = parseCsvLine(line);
    if (!r[C.isin] || !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(r[C.isin])) continue;
    holdings.push({
      isin: r[C.isin], name: r[C.name], account,
      units: num(r[C.units]),
      fidelityPrice: num(r[C.price]) / 100, // pence -> £
      fidelityValue: num(r[C.value]),
      bookCost: num(r[C.book]),
      invested: num(r[C.invested]),
      withdrawn: num(r[C.withdrawn]),
      incomePaid: num(r[C.income]),
      shareClass: /\binc\b/i.test(r[C.name]) ? "Inc" : /\bacc\b/i.test(r[C.name]) ? "Acc" : "",
    });
  }
  return { account, asOf, holdings };
}

/**
 * Merge an imported account into the store's fund list. Funds for that account
 * are replaced; other accounts are untouched. Returns {funds, added, removed, changed}.
 */
export function mergeFidelityImport(funds, imp) {
  const key = (f) => `${f.account}|${f.isin}`;
  const old = new Map(funds.filter((f) => f.account === imp.account).map((f) => [key(f), f]));
  const next = funds.filter((f) => f.account !== imp.account);
  const added = [], changed = [];
  for (const h of imp.holdings) {
    const prev = old.get(key(h));
    if (!prev) added.push(h.name);
    else if (Math.abs(prev.units - h.units) > 1e-9) changed.push(`${h.name}: ${prev.units} → ${h.units}`);
    old.delete(key(h));
    next.push({ ...h, importedAt: imp.asOf });
  }
  const removed = [...old.values()].map((f) => f.name);
  return { funds: next, added, removed, changed };
}

/**
 * Line-by-line reconciliation of app value vs Fidelity value at Fidelity's prices
 * and at app prices. Never plugs a difference.
 */
export function reconcile(funds, prices, overrides = {}) {
  return funds.map((f) => {
    const p = resolveFundPrice(f.isin, prices, overrides);
    const appValue = p ? round2(f.units * p.price) : null;
    return {
      isin: f.isin, name: f.name, account: f.account,
      fidelityValue: f.fidelityValue ?? null,
      fidelityPrice: f.fidelityPrice ?? null,
      appPrice: p?.price ?? null, appAsOf: p?.asOf ?? null,
      appValue,
      diff: appValue != null && f.fidelityValue != null ? round2(appValue - f.fidelityValue) : null,
      priceDiffPct: p && f.fidelityPrice ? (p.price / f.fidelityPrice - 1) * 100 : null,
    };
  });
}

// ---------- loan ----------

/** Monthly rate from APR (APR is an effective annual rate). */
export const monthlyRateFromApr = (aprPct) => Math.pow(1 + aprPct / 100, 1 / 12) - 1;

export function annuityPayment(principal, aprPct, months) {
  const r = monthlyRateFromApr(aprPct);
  return r === 0 ? principal / months : (principal * r) / (1 - Math.pow(1 + r, -months));
}

/** Balance after k payments. */
export function balanceAfter(principal, aprPct, payment, k) {
  const r = monthlyRateFromApr(aprPct);
  let b = principal;
  for (let i = 0; i < k; i++) b = b * (1 + r) - payment;
  return Math.max(0, b);
}

/** Whole months from a to b (ISO dates), counting a payment on the same day-of-month. */
export function monthsBetween(a, b) {
  const A = new Date(a + "T00:00:00Z"), B = new Date(b + "T00:00:00Z");
  let m = (B.getUTCFullYear() - A.getUTCFullYear()) * 12 + (B.getUTCMonth() - A.getUTCMonth());
  if (B.getUTCDate() < A.getUTCDate()) m -= 1;
  return Math.max(0, m);
}

export function addMonths(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Loan position on `today`. If a statement balance+date is held, roll forward
 * from it; otherwise use the amortisation schedule from the start date.
 * Payments assumed on the start date's day-of-month, first one month after start.
 */
export function loanPosition(loan, today) {
  const { principal, apr, payment, termMonths, startDate } = loan;
  const paidByToday = Math.min(termMonths, monthsBetween(startDate, today));
  let balance, basis;
  if (loan.statementBalance != null && loan.statementDate) {
    const k = Math.max(0, paidByToday - Math.min(termMonths, monthsBetween(startDate, loan.statementDate)));
    balance = balanceAfter(loan.statementBalance, apr, payment, k);
    basis = `statement ${loan.statementDate} rolled forward ${k} payment(s)`;
  } else {
    balance = balanceAfter(principal, apr, payment, paidByToday);
    basis = "estimated from schedule";
  }
  const remaining = termMonths - paidByToday;
  const totalPaid = payment * paidByToday;
  const interestPaid = totalPaid - (principal - balance);
  return {
    balance: round2(balance), paymentsMade: paidByToday, paymentsLeft: remaining,
    payoffDate: addMonths(startDate, termMonths),
    interestPaid: round2(interestPaid),
    interestRemaining: round2(payment * remaining - balance),
    basis,
  };
}

// ---------- net worth ----------

/**
 * Value every line. Returns {lines, totals, total}. Each line:
 * {group, id, name, value, asOf, source, stale, kind}
 */
export function valuation(store, prices, now = new Date()) {
  const lines = [];
  const ov = store.priceOverrides || {};
  for (const f of store.funds || []) {
    const p = resolveFundPrice(f.isin, prices, ov);
    lines.push({
      group: "Investments", kind: "fund", id: `${f.account}|${f.isin}`, name: f.name, account: f.account,
      units: f.units, price: p?.price ?? null,
      value: p ? round2(f.units * p.price) : null,
      asOf: p?.asOf ?? null, source: p?.source ?? "no price", manual: !!p?.manual,
      stale: p ? isStale("fund", p.asOf, now) : true,
      bookCost: f.bookCost, invested: f.invested, withdrawn: f.withdrawn, isin: f.isin,
    });
  }
  for (const [acct, bal] of Object.entries(store.fidelityCash || {})) {
    lines.push({ group: "Investments", kind: "cash", id: `cash|${acct}`, name: `Fidelity cash (${acct})`,
      value: round2(bal.amount || 0), asOf: bal.asOf, source: "manual", stale: false });
  }
  for (const c of store.crypto || []) {
    const live = store._liveCrypto?.[c.symbol];
    const feed = prices?.crypto?.[c.symbol];
    const q = live || feed;
    lines.push({
      group: "Crypto", kind: "crypto", id: `crypto|${c.symbol}`, name: c.symbol, units: c.units,
      price: q?.price_gbp ?? null, value: q ? round2(c.units * q.price_gbp) : null,
      asOf: q?.as_of ?? null, source: q ? (live ? "CoinGecko (live)" : "CoinGecko (scheduled)") : "no price",
      stale: q ? isStale("crypto", q.as_of, now) : true,
    });
  }
  for (const m of store.metals || []) {
    const ozt = m.unit === "g" ? m.quantity / 31.1034768 : m.quantity;
    const q = prices?.metals?.[m.metal];
    lines.push({
      group: "Gold & silver", kind: "metal", id: `metal|${m.id}`, name: `${m.metal} (${m.platform || ""})`,
      units: ozt, price: q?.price_gbp_ozt ?? null, value: q ? round2(ozt * q.price_gbp_ozt) : (m.manualValue ?? null),
      asOf: q?.as_of ?? m.manualAsOf ?? null, source: q?.basis ?? "manual", stale: false,
    });
  }
  for (const s of store.savings || []) {
    lines.push({ group: "Cash savings", kind: "savings", id: `sav|${s.id}`, name: s.name,
      value: round2(s.balance), asOf: s.asOf, source: "manual", stale: false, rate: s.aer });
  }
  if (store.car) {
    lines.push({ group: "Car", kind: "car", id: "car", name: store.car.name, value: round2(store.car.value),
      asOf: store.car.asOf, source: store.car.source || "manual estimate", stale: false, estimate: true });
  }
  if (store.loan) {
    const lp = loanPosition(store.loan, now.toISOString().slice(0, 10));
    lines.push({ group: "Car loan", kind: "loan", id: "loan", name: store.loan.name || "Car loan",
      value: -lp.balance, asOf: now.toISOString().slice(0, 10), source: lp.basis, stale: false,
      estimate: store.loan.statementBalance == null, loan: lp });
  }
  const totals = {};
  for (const l of lines) totals[l.group] = round2((totals[l.group] || 0) + (l.value || 0));
  const total = round2(Object.values(totals).reduce((a, b) => a + b, 0));
  const missing = lines.filter((l) => l.value == null).map((l) => l.name);
  return { lines, totals, total, missing };
}

/** Upsert today's snapshot (one per day, latest wins). */
export function upsertSnapshot(snaps, date, total, totals) {
  const rest = (snaps || []).filter((s) => s.date !== date);
  rest.push({ date, total, totals });
  rest.sort((a, b) => a.date.localeCompare(b.date));
  return rest;
}

/** Change vs the latest snapshot strictly before `date`. */
export function changeVsPrevious(snaps, date, total) {
  const prev = [...(snaps || [])].filter((s) => s.date < date).pop();
  return prev ? { amount: round2(total - prev.total), since: prev.date } : null;
}

/** Filter snapshots to a window: "1M", "1Y", "ALL". */
export function windowSnapshots(snaps, range, today) {
  if (range === "ALL") return snaps;
  const from = addMonths(today, range === "1M" ? -1 : -12);
  return snaps.filter((s) => s.date >= from);
}

// ---------- XIRR (for when transaction history is loaded) ----------

/** flows: [{date:'YYYY-MM-DD', amount}] — investments negative, current value positive. */
export function xirr(flows) {
  const t0 = new Date(flows[0].date).getTime();
  const yrs = flows.map((f) => (new Date(f.date).getTime() - t0) / (365 * 86400000));
  const f = (r) => flows.reduce((s, c, i) => s + c.amount / Math.pow(1 + r, yrs[i]), 0);
  let lo = -0.99, hi = 10;
  if (f(lo) * f(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// ---------- price history ----------

export const RANGES = { "1W": 7, "1M": 31, "3M": 92, "1Y": 366, "5Y": 1827, "ALL": Infinity };

/** series: {iso: price}. Returns [[iso, price]] within the range ending at the last point. */
export function seriesWindow(series, range) {
  const pts = Object.entries(series || {}).sort((a, b) => a[0].localeCompare(b[0]));
  if (!pts.length || range === "ALL") return pts;
  const end = new Date(pts.at(-1)[0] + "T00:00:00Z");
  const from = new Date(end.getTime() - RANGES[range] * 86400000).toISOString().slice(0, 10);
  return pts.filter(([d]) => d >= from);
}

/** Change from first to last point of a window. */
export function windowChange(pts) {
  if (!pts || pts.length < 2) return null;
  const a = pts[0][1], b = pts.at(-1)[1];
  // % of the starting magnitude, so a shrinking liability (−15k → −11k) reads as a positive change
  return { abs: b - a, pct: a ? ((b - a) / Math.abs(a)) * 100 : null, from: pts[0][0], to: pts.at(-1)[0] };
}

/** Last close vs the previous close. */
export function dayChange(series) {
  const pts = Object.entries(series || {}).sort((a, b) => a[0].localeCompare(b[0]));
  return pts.length < 2 ? null : windowChange(pts.slice(-2));
}

/**
 * Value of fixed holdings over time: sum(units × price), forward-filling each
 * series across days it has no price (weekends, holidays), starting on the first
 * date every series has a price. legs: [{series, units}]. Returns [[iso, value]].
 */
export function holdingsSeries(legs, range = "ALL") {
  const live = legs.filter((l) => l.units && Object.keys(l.series || {}).length);
  if (!live.length) return [];
  const starts = live.map((l) => Object.keys(l.series).sort()[0]);
  const start = starts.sort().at(-1);
  const dates = [...new Set(live.flatMap((l) => Object.keys(l.series)))].filter((d) => d >= start).sort();
  const last = live.map(() => null), sorted = live.map((l) => l.series);
  const out = [];
  for (const d of dates) {
    let total = 0;
    live.forEach((l, i) => { if (sorted[i][d] != null) last[i] = sorted[i][d]; total += (last[i] ?? 0) * l.units; });
    out.push([d, round2(total)]);
  }
  return seriesWindow(Object.fromEntries(out), range);
}

/** Down-sample to at most n points, keeping first and last (for phone-sized SVGs). */
export function thin(pts, n = 240) {
  if (pts.length <= n) return pts;
  const step = (pts.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => pts[Math.round(i * step)]);
}

/** Points between two ISO dates inclusive; either bound may be empty. */
export function pointsBetween(pts, from, to) {
  return pts.filter(([d]) => (!from || d >= from) && (!to || d <= to));
}

// ---------- moves & attribution ----------

/** Last price on or before `date` (forward-fill), or null. */
export function priceOn(series, date) {
  let best = null, bd = "";
  for (const [d, p] of Object.entries(series || {})) if (d <= date && d > bd) { bd = d; best = p; }
  return best;
}

/** Look-back in points used to find "big moves", scaled to the window length. */
export function moveStep(pts) {
  if (pts.length < 2) return 1;
  const days = (new Date(pts.at(-1)[0]) - new Date(pts[0][0])) / 86400000;
  return days <= 45 ? 1 : days <= 400 ? 5 : 20;
}

/**
 * Largest rise and largest fall over `k` points within pts ([[iso, value]]).
 * Returns {up, down}; each {from, to, abs, pct} or null when no move that way.
 */
export function biggestMoves(pts, k = moveStep(pts)) {
  let up = null, down = null;
  for (let i = k; i < pts.length; i++) {
    const a = pts[i - k][1], b = pts[i][1], abs = b - a;
    const m = { from: pts[i - k][0], to: pts[i][0], abs, pct: a ? (abs / a) * 100 : 0 };
    if (abs > 0 && (!up || abs > up.abs)) up = m;
    if (abs < 0 && (!down || abs < down.abs)) down = m;
  }
  return { up, down };
}

/** Each leg's £ contribution between two dates at fixed units. legs: [{name, series, units}]. */
export function contributions(legs, from, to) {
  return legs.map((l) => {
    const a = priceOn(l.series, from), b = priceOn(l.series, to);
    return { name: l.name, abs: a != null && b != null ? round2((b - a) * l.units) : 0 };
  }).filter((c) => c.abs !== 0).sort((x, y) => Math.abs(y.abs) - Math.abs(x.abs));
}
