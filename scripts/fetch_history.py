"""Build data/history.json: daily closing prices in GBP per fund and crypto.

Funds: FT historical prices (backfilled up to BACKFILL_YEARS, then topped up).
Crypto: CoinGecko daily market chart (free tier: last 365 days).
Existing history is kept and merged, so the file grows over time.
"""
import datetime as dt
import html as htmllib
import json
import os
import re
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_prices import ROOT, get, to_gbp  # noqa: E402

BACKFILL_YEARS = 5
XID = re.compile(r"xid(?:&quot;|\")\s*:\s*(?:&quot;|\")(\d+)")
ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
CELL = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
TAG = re.compile(r"<[^>]+>")
DATE_LONG = re.compile(r"([A-Z][a-z]+day), ([A-Z][a-z]+ \d{1,2}, \d{4})")


def parse_ft_rows(fragment, currency):
    """FT returns table rows: date, open, high, low, close, volume. Returns {iso: gbp}."""
    out = {}
    for r in ROW.findall(fragment):
        cells = CELL.findall(r)
        if len(cells) < 5:
            continue
        m = DATE_LONG.search(cells[0])
        if not m:
            continue
        d = dt.datetime.strptime(m.group(2), "%B %d, %Y").date().isoformat()
        txt = TAG.sub("", htmllib.unescape(cells[4])).strip().replace(",", "")
        try:
            out[d] = round(to_gbp(float(txt), currency), 6)
        except ValueError:
            continue
    return out


def ft_history(sym, currency, start, end):
    page = get(f"https://markets.ft.com/data/funds/tearsheet/historical?s={urllib.parse.quote(sym)}")
    m = XID.search(page)
    if not m:
        raise LookupError("xid not found")
    xid = m.group(1)
    out = {}
    s = start
    while s < end:
        e = min(end, s + dt.timedelta(days=364))
        url = ("https://markets.ft.com/data/equities/ajax/get-historical-prices?"
               + urllib.parse.urlencode({"startDate": s.strftime("%Y/%m/%d"),
                                         "endDate": e.strftime("%Y/%m/%d"), "symbol": xid}))
        out.update(parse_ft_rows(json.loads(get(url)).get("html", ""), currency))
        s = e + dt.timedelta(days=1)
        time.sleep(0.4)
    return out


def coingecko_history(cid):
    d = json.loads(get(f"https://api.coingecko.com/api/v3/coins/{cid}/market_chart?vs_currency=gbp&days=365&interval=daily"))
    out = {}
    for ts, p in d.get("prices", []):
        out[dt.datetime.fromtimestamp(ts / 1000, dt.timezone.utc).date().isoformat()] = round(p, 2)
    return out


def main():
    cfg = json.load(open(os.path.join(ROOT, "config", "instruments.json")))
    prices = json.load(open(os.path.join(ROOT, "data", "prices.json")))
    path = os.path.join(ROOT, "data", "history.json")
    hist = json.load(open(path)) if os.path.exists(path) else {"funds": {}, "crypto": {}}
    today = dt.date.today()
    log = []
    for f in cfg["funds"]:
        isin = f["isin"]
        ft = prices["funds"].get(isin, {}).get("candidates", {}).get("ft", {})
        if "ref" not in ft:
            log.append(f"{isin}: no FT symbol, skipped")
            continue
        series = hist["funds"].get(isin, {})
        backfill = len(series) < 200
        start = today - dt.timedelta(days=365 * BACKFILL_YEARS if backfill else 21)
        try:
            new = ft_history(ft["ref"], ft["currency"], start, today)
            series.update(new)
            # make sure today's scheduled price is included
            p = prices["funds"][isin]
            if p.get("as_of") and p.get("price_gbp"):
                series[p["as_of"]] = round(p["price_gbp"], 6)
            hist["funds"][isin] = dict(sorted(series.items()))
            log.append(f"{isin}: +{len(new)} rows from {start}, {len(series)} total, {min(series) if series else '-'} → {max(series) if series else '-'}")
        except Exception as e:
            log.append(f"{isin}: FAIL {type(e).__name__}: {e}"[:200])
    for c in cfg["crypto"]:
        series = hist["crypto"].get(c["symbol"], {})
        try:
            series.update(coingecko_history(c["coingecko_id"]))
            q = prices.get("crypto", {}).get(c["symbol"])
            if q and "price_gbp" in q:
                series[q["as_of"][:10]] = q["price_gbp"]
            hist["crypto"][c["symbol"]] = dict(sorted(series.items()))
            log.append(f"{c['symbol']}: {len(series)} days")
        except Exception as e:
            log.append(f"{c['symbol']}: FAIL {type(e).__name__}: {e}"[:200])
    hist["generated_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    with open(path, "w") as fh:
        json.dump(hist, fh, separators=(",", ":"))
    print("## History\n\n" + "\n".join(f"- {x}" for x in log))


if __name__ == "__main__":
    main()
