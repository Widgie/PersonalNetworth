"""Fetch public prices for the configured instruments and write data/prices.json.

Stdlib only. Each fund is tried against every source so the feed report shows
coverage side by side; the first successful source in SOURCE_ORDER is used as
the primary price. All fund prices are normalised to GBP per unit.
"""
import datetime as dt
import json
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
TIMEOUT = 20


def get(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8", "replace")


def to_gbp(value, currency):
    """Normalise a price to GBP. GBp/GBX are pence."""
    if currency in ("GBp", "GBX", "GBx"):
        return value / 100.0
    if currency == "GBP":
        return value
    raise ValueError(f"unexpected currency {currency!r}")


# ---------------------------------------------------------------- sources

def src_yahoo(isin):
    s = json.loads(get(
        "https://query2.finance.yahoo.com/v1/finance/search?"
        + urllib.parse.urlencode({"q": isin, "quotesCount": 5, "newsCount": 0})))
    quotes = s.get("quotes") or []
    if not quotes:
        raise LookupError("ISIN not found")
    sym = quotes[0]["symbol"]
    c = json.loads(get(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?range=5d&interval=1d"))
    meta = c["chart"]["result"][0]["meta"]
    raw, cur = meta["regularMarketPrice"], meta["currency"]
    as_of = dt.datetime.fromtimestamp(meta["regularMarketTime"], dt.timezone.utc).date().isoformat()
    return {"price_gbp": to_gbp(raw, cur), "raw": raw, "currency": cur, "as_of": as_of, "ref": sym}


FT_PRICE = re.compile(r"Price \((\w{3})\)</span>\s*<span[^>]*>([\d,\.]+)<")
FT_DATE = re.compile(r"as of ([A-Z][a-z]{2} \d{1,2} \d{4})")


FT_SEARCH_HIT = re.compile(r"/data/funds/tearsheet/summary\?s=([A-Z0-9]+:[A-Z]{3})")


def src_ft(isin):
    sym = f"{isin}:GBP"
    html = get(f"https://markets.ft.com/data/funds/tearsheet/summary?s={sym}")
    m = FT_PRICE.search(html)
    if not m:  # fall back to FT search to find the listed symbol for this ISIN
        hits = FT_SEARCH_HIT.findall(get(f"https://markets.ft.com/data/search?query={isin}"))
        hits = [h for h in dict.fromkeys(hits) if h.startswith(isin)]
        if not hits:
            raise LookupError("price not found on page; no search hit")
        sym = hits[0]
        html = get(f"https://markets.ft.com/data/funds/tearsheet/summary?s={sym}")
        m = FT_PRICE.search(html)
        if not m:
            raise LookupError(f"price not found for search hit {sym}")
    cur, raw = m.group(1), float(m.group(2).replace(",", ""))
    d = FT_DATE.search(html)
    as_of = dt.datetime.strptime(d.group(1), "%b %d %Y").date().isoformat() if d else None
    return {"price_gbp": to_gbp(raw, cur), "raw": raw, "currency": cur, "as_of": as_of, "ref": sym}


SOURCES = {"ft": src_ft, "yahoo": src_yahoo}
SOURCE_ORDER = ["ft", "yahoo"]


def fetch_crypto(coins):
    ids = ",".join(c["coingecko_id"] for c in coins)
    d = json.loads(get(
        "https://api.coingecko.com/api/v3/simple/price?"
        + urllib.parse.urlencode({"ids": ids, "vs_currencies": "gbp", "include_last_updated_at": "true"})))
    out = {}
    for c in coins:
        row = d.get(c["coingecko_id"])
        if not row:
            out[c["symbol"]] = {"error": "not returned"}
            continue
        out[c["symbol"]] = {
            "price_gbp": row["gbp"],
            "as_of": dt.datetime.fromtimestamp(row["last_updated_at"], dt.timezone.utc).isoformat(),
            "source": "coingecko",
        }
    return out


def main():
    cfg = json.load(open(os.path.join(ROOT, "config", "instruments.json")))
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    funds, report = {}, []
    for f in cfg["funds"]:
        cands = {}
        for name, fn in SOURCES.items():
            try:
                cands[name] = fn(f["isin"])
            except Exception as e:  # report every failure, never hide it
                cands[name] = {"error": f"{type(e).__name__}: {e}"[:200]}
        primary = next((s for s in SOURCE_ORDER if "price_gbp" in cands[s]), None)
        entry = {"name": f["name"], "candidates": cands}
        if primary:
            p = cands[primary]
            entry.update(price_gbp=p["price_gbp"], as_of=p["as_of"], source=primary)
        funds[f["isin"]] = entry
        cells = [f"{c['raw']} {c['currency']} @ {c['as_of']}" if "raw" in c else "FAIL" for c in cands.values()]
        report.append(f"| {f['isin']} | {f['name']} | " + " | ".join(cells) + " |")

    try:
        crypto = fetch_crypto(cfg["crypto"])
    except Exception as e:
        crypto = {"error": f"{type(e).__name__}: {e}"[:200]}

    out = {"generated_at": now, "funds": funds, "crypto": crypto}
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "prices.json"), "w") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)

    head = "| ISIN | Fund | " + " | ".join(SOURCES) + " |\n|---|---|" + "---|" * len(SOURCES)
    ok = sum(1 for v in funds.values() if "price_gbp" in v)
    md = (f"# Feed report\n\nGenerated {now}\n\nFunds priced: {ok}/{len(funds)}\n\n"
          + head + "\n" + "\n".join(report)
          + "\n\n## Crypto\n\n```\n" + json.dumps(crypto, indent=1) + "\n```\n")
    with open(os.path.join(ROOT, "data", "feed_report.md"), "w") as fh:
        fh.write(md)
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
