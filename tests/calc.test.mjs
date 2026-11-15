// Synthetic fixtures only — no real holdings in this repo.
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../calc.js";

const CSV = [
  "Prices and valuations updated at 22:53 GMT on 13/11/2026",
  "Investment ISA -XX00000000",
  ",,,,,,,,,,,,,,,Your Returns",
  "Fidelity Fund Name,Fidelity Fund Code,ISIN,SEDOL,,Value (£),Units,Book Cost (£),Current Price (p),,Total Amount Invested (£),Total Withdrawn Incl. Income Paid (£),Total Income Paid Out (£),,Gain/loss Since Inception (£)",
  '"Example Fund, Z Acc","EXA","GB0000000001","-",,1500.00,1000.00,1200.00,150,,1200.00,0.00,0.00,,300.00',
  '"Big Price Fund Inc","BIG","GB0000000002","-",,2448.46,10.00,2000.00,24484.61,,2050.00,60.00,60.00,,448.46',
].join("\n");

test("toGbp handles pence and pounds", () => {
  assert.equal(C.toGbp(308.83, "GBX"), 3.0883);
  assert.equal(C.toGbp(2.44, "GBP"), 2.44);
  assert.throws(() => C.toGbp(1, "USD"));
});

test("CSV line parser handles quoted commas", () => {
  assert.deepEqual(C.parseCsvLine('"a, b",c,"d""e"'), ["a, b", "c", 'd"e']);
});

test("parse Fidelity holdings CSV", () => {
  const r = C.parseFidelityHoldingsCsv(CSV);
  assert.equal(r.account, "ISA");
  assert.equal(r.asOf, "2026-11-13T22:53:00Z");
  assert.equal(r.holdings.length, 2);
  const [a, b] = r.holdings;
  assert.equal(a.name, "Example Fund, Z Acc");
  assert.equal(a.shareClass, "Acc");
  assert.equal(a.fidelityPrice, 1.5);
  assert.equal(b.fidelityPrice, 244.8461);
  assert.equal(C.round2(b.units * b.fidelityPrice), b.fidelityValue);
  assert.equal(b.shareClass, "Inc");
  assert.equal(b.withdrawn, 60);
  assert.ok(!JSON.stringify(r).includes("XX00000000"), "account number must be dropped");
});

test("account types", () => {
  assert.equal(C.fidelityAccountType("Investment Account -AG1"), "GIA");
  assert.equal(C.fidelityAccountType("Investment ISA -AS1"), "ISA");
  assert.equal(C.fidelityAccountType("SIPP -1"), "SIPP");
});

test("merge import replaces only that account and reports changes", () => {
  const existing = [
    { account: "GIA", isin: "GB0000000009", name: "Other", units: 5 },
    { account: "ISA", isin: "GB0000000001", name: "Example Fund, Z Acc", units: 900 },
    { account: "ISA", isin: "GB0000000003", name: "Sold Fund", units: 3 },
  ];
  const m = C.mergeFidelityImport(existing, C.parseFidelityHoldingsCsv(CSV));
  assert.equal(m.funds.length, 3);
  assert.deepEqual(m.added, ["Big Price Fund Inc"]);
  assert.deepEqual(m.removed, ["Sold Fund"]);
  assert.equal(m.changed.length, 1);
  assert.ok(m.funds.some((f) => f.account === "GIA"));
});

test("reconcile shows differences and never plugs", () => {
  const funds = C.parseFidelityHoldingsCsv(CSV).holdings;
  const prices = { funds: { GB0000000001: { price_gbp: 1.5, as_of: "2026-11-13" },
                            GB0000000002: { price_gbp: 246.36, as_of: "2026-11-13" } } };
  const r = C.reconcile(funds, prices);
  assert.equal(r[0].diff, 0);
  assert.equal(r[1].diff, C.round2(10 * 246.36 - 2448.46));
  const r2 = C.reconcile(funds, { funds: {} });
  assert.equal(r2[0].appValue, null);
  assert.equal(r2[0].diff, null);
});

test("manual override beats feed", () => {
  const p = C.resolveFundPrice("X", { funds: { X: { price_gbp: 1, as_of: "2026-01-01" } } },
    { X: { price: 2, asOf: "2026-01-02" } });
  assert.equal(p.price, 2);
  assert.equal(p.manual, true);
});

test("staleness", () => {
  const now = new Date("2026-11-16T12:00:00Z"); // Monday
  assert.equal(C.isStale("fund", "2026-11-13", now), false); // Friday price on Monday
  assert.equal(C.isStale("fund", "2026-11-10", now), true);
  assert.equal(C.isStale("crypto", "2026-11-15T11:00:00Z", now), true);
  assert.equal(C.isStale("crypto", "2026-11-16T05:00:00Z", now), false);
});

test("loan: 18k, 6.9% APR, 60m gives £353.80 and amortises to zero", () => {
  assert.equal(C.round2(C.annuityPayment(18000, 6.9, 60)), 353.8);
  assert.ok(C.balanceAfter(18000, 6.9, C.annuityPayment(18000, 6.9, 60), 60) < 0.01);
});

test("loan position from schedule and from statement", () => {
  const loan = { principal: 18000, apr: 6.9, payment: 353.8, termMonths: 60, startDate: "2023-03-15" };
  const p = C.loanPosition(loan, "2026-11-13");
  assert.equal(p.paymentsMade, 43);
  assert.equal(p.paymentsLeft, 17);
  assert.equal(p.payoffDate, "2028-03-15");
  assert.equal(p.balance, C.round2(C.balanceAfter(18000, 6.9, 353.8, 43)));
  assert.equal(p.interestPaid, C.round2(353.8 * 43 - (18000 - p.balance)));
  const s = C.loanPosition({ ...loan, statementBalance: 6000, statementDate: "2026-10-20" }, "2026-11-20");
  assert.equal(s.balance, C.round2(C.balanceAfter(6000, 6.9, 353.8, 1)));
});

test("monthsBetween and addMonths", () => {
  assert.equal(C.monthsBetween("2023-03-15", "2026-11-14"), 43);
  assert.equal(C.monthsBetween("2023-03-15", "2026-11-15"), 44);
  assert.equal(C.addMonths("2023-03-15", 60), "2028-03-15");
});

test("valuation totals by group and net worth", () => {
  const store = {
    funds: [{ account: "ISA", isin: "A", name: "A", units: 10 }],
    fidelityCash: { ISA: { amount: 0, asOf: "2026-11-13" } },
    crypto: [{ symbol: "BTC", units: 0.1 }],
    savings: [{ id: "s1", name: "Saver", balance: 100.5, asOf: "2026-11-13" }],
    car: { name: "Car", value: 9000, asOf: "2026-11-13" },
    loan: { principal: 18000, apr: 6.9, payment: 353.8, termMonths: 60, startDate: "2023-03-15" },
  };
  const prices = { funds: { A: { price_gbp: 2, as_of: "2026-11-13" } },
                   crypto: { BTC: { price_gbp: 50000, as_of: "2026-11-13T12:00:00Z" } } };
  const v = C.valuation(store, prices, new Date("2026-11-13T13:00:00Z"));
  const loanBal = C.loanPosition(store.loan, "2026-11-13").balance;
  assert.equal(v.totals.Investments, 20);
  assert.equal(v.totals.Crypto, 5000);
  assert.equal(v.total, C.round2(20 + 5000 + 100.5 + 9000 - loanBal));
  assert.deepEqual(v.missing, []);
});

test("missing price shows as missing, not zero-plugged", () => {
  const v = C.valuation({ funds: [{ account: "ISA", isin: "Z", name: "Z", units: 1 }] }, { funds: {} });
  assert.deepEqual(v.missing, ["Z"]);
});

test("snapshots: upsert per day and change vs previous", () => {
  let s = C.upsertSnapshot([], "2026-11-12", 100, {});
  s = C.upsertSnapshot(s, "2026-11-13", 110, {});
  s = C.upsertSnapshot(s, "2026-11-13", 115, {});
  assert.equal(s.length, 2);
  assert.deepEqual(C.changeVsPrevious(s, "2026-11-13", 115), { amount: 15, since: "2026-11-12" });
  assert.equal(C.windowSnapshots(s, "1M", "2026-12-13").length, 1);
});

test("xirr: 10% over one year", () => {
  const r = C.xirr([{ date: "2025-01-01", amount: -1000 }, { date: "2026-01-01", amount: 1100 }]);
  assert.ok(Math.abs(r - 0.1) < 1e-6);
});

test("seriesWindow and windowChange", () => {
  const s = { "2026-01-01": 1, "2026-10-01": 2, "2026-11-10": 3, "2026-11-13": 4 };
  assert.deepEqual(C.seriesWindow(s, "1W").map((p) => p[0]), ["2026-11-10", "2026-11-13"]);
  assert.equal(C.seriesWindow(s, "1Y").length, 4);
  assert.deepEqual(C.windowChange(C.seriesWindow(s, "1W")), { abs: 1, pct: (4 / 3 - 1) * 100, from: "2026-11-10", to: "2026-11-13" });
  assert.equal(C.windowChange([["a", 1]]), null);
});

test("dayChange uses the last two closes", () => {
  assert.equal(C.dayChange({ "2026-11-12": 10, "2026-11-13": 11 }).pct.toFixed(4), "10.0000");
  assert.equal(C.dayChange({ "2026-11-13": 11 }), null);
});

test("holdingsSeries starts when all legs priced and forward-fills gaps", () => {
  const a = { series: { "2026-11-09": 1, "2026-11-10": 2, "2026-11-12": 3 }, units: 10 };
  const b = { series: { "2026-11-10": 100, "2026-11-11": 110, "2026-11-12": 120 }, units: 1 };
  assert.deepEqual(C.holdingsSeries([a, b]), [
    ["2026-11-10", 120], ["2026-11-11", 130], ["2026-11-12", 150]]);
  assert.deepEqual(C.holdingsSeries([]), []);
});

test("thin keeps endpoints and size", () => {
  const pts = Array.from({ length: 1000 }, (_, i) => [String(i), i]);
  const t = C.thin(pts, 100);
  assert.equal(t.length, 100);
  assert.deepEqual(t[0], pts[0]);
  assert.deepEqual(t.at(-1), pts.at(-1));
});

test("pointsBetween is inclusive and handles open bounds", () => {
  const pts = [["2026-01-01", 1], ["2026-02-01", 2], ["2026-03-01", 3]];
  assert.deepEqual(C.pointsBetween(pts, "2026-02-01", "2026-03-01").map((p) => p[1]), [2, 3]);
  assert.equal(C.pointsBetween(pts, "", "2026-01-31").length, 1);
  assert.equal(C.pointsBetween(pts, "2026-04-01", "").length, 0);
});

test("priceOn forward-fills", () => {
  const s = { "2026-01-01": 1, "2026-01-05": 2 };
  assert.equal(C.priceOn(s, "2026-01-04"), 1);
  assert.equal(C.priceOn(s, "2026-01-05"), 2);
  assert.equal(C.priceOn(s, "2025-12-31"), null);
});

test("biggestMoves finds largest k-step rise and fall", () => {
  const pts = [["d1", 100], ["d2", 90], ["d3", 95], ["d4", 120], ["d5", 110]];
  const m = C.biggestMoves(pts, 1);
  assert.deepEqual(m.up, { from: "d3", to: "d4", abs: 25, pct: (25 / 95) * 100 });
  assert.equal(m.down.abs, -10);
  assert.equal(m.down.from, "d1");
  assert.equal(C.biggestMoves([["a", 1], ["b", 2]], 1).down, null);
});

test("moveStep scales with window length", () => {
  assert.equal(C.moveStep([["2026-01-01", 1], ["2026-01-20", 1]]), 1);
  assert.equal(C.moveStep([["2025-01-01", 1], ["2026-01-01", 1]]), 5);
  assert.equal(C.moveStep([["2021-01-01", 1], ["2026-01-01", 1]]), 20);
});

test("contributions attribute a move to legs and sum to it", () => {
  const legs = [
    { name: "A", units: 10, series: { "2026-01-01": 1, "2026-01-02": 1.5 } },
    { name: "B", units: 1, series: { "2026-01-01": 100, "2026-01-02": 98 } },
    { name: "C", units: 5, series: { "2026-01-01": 2, "2026-01-02": 2 } },
  ];
  const c = C.contributions(legs, "2026-01-01", "2026-01-02");
  assert.deepEqual(c, [{ name: "A", abs: 5 }, { name: "B", abs: -2 }]);
  const port = C.holdingsSeries(legs);
  assert.equal(C.round2(port[1][1] - port[0][1]), C.round2(c.reduce((s, x) => s + x.abs, 0)));
});

test("windowChange on a liability: shrinking debt is a positive %", () => {
  const c = C.windowChange([["a", -15000], ["b", -11000]]);
  assert.equal(c.abs, 4000);
  assert.ok(Math.abs(c.pct - 26.6667) < 1e-3);
});
