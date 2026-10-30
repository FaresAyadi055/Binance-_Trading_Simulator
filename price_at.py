#!/usr/bin/env python3
"""Look up the Binance BTCUSDT price at a given epoch-ms timestamp and convert USDT -> BTC.

Usage:
    python3 price_at.py [timestamp_ms] [usdt_amount]

Defaults: timestamp 1793143398613, amount 20.466416 USDT.
"""
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = "https://api.binance.com"
SYMBOL = "BTCUSDT"
TS = int(sys.argv[1]) if len(sys.argv) > 1 else 1793143398613
USDT = float(sys.argv[2]) if len(sys.argv) > 2 else 20.466416


def get(path, **params):
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.load(r)


def main():
    utc = datetime.fromtimestamp(TS / 1000, timezone.utc)
    print(f"symbol  : {SYMBOL}")
    print(f"time    : {TS} ms  ({utc:%Y-%m-%d %H:%M:%S} UTC)")
    print(f"amount  : {USDT} USDT\n")

    # 1s candles covering the requested second. Binance returns the candles that
    # start at/after startTime, so ask a little early and pick the containing one.
    kl = get("/api/v3/klines", symbol=SYMBOL, interval="1s",
             startTime=TS - 2000, endTime=TS + 2000, limit=10)
    if not kl:
        sys.exit("no kline data returned")

    containing = [k for k in kl if int(k[0]) <= TS < int(k[0]) + 1000]
    k = (containing or kl)[-1]
    o, h, l, c = float(k[1]), float(k[2]), float(k[3]), float(k[4])
    print(f"1s kline: open={o:.2f}  high={h:.2f}  low={l:.2f}  close={c:.2f}"
          f"  ({int(k[8])} trades, vol={float(k[5]):.4f} BTC)")

    # 1m candle for the minute, so the 1s print can be put in context.
    kms = get("/api/v3/klines", symbol=SYMBOL, interval="1m",
              startTime=TS - (TS % 60000), endTime=TS, limit=1)
    if kms:
        km = kms[0]
        print(f"1m kline: open={float(km[1]):.2f}  high={float(km[2]):.2f}  "
              f"low={float(km[3]):.2f}  close={float(km[4]):.2f}")
    else:
        print("1m kline: no data returned")

    print()
    for label, price in (("close", c), ("low", l), ("high", h)):
        print(f"{USDT:.6f} USDT @ {label:5s} {price:10.2f} = {USDT / price:.12f} BTC")

    # Nearest real trades around the timestamp (the 1s candle may contain none).
    tr = get("/api/v3/aggTrades", symbol=SYMBOL, startTime=TS - 60000,
             endTime=TS + 60000, limit=1000)
    before = [t for t in tr if t["T"] <= TS]
    after = [t for t in tr if t["T"] > TS]
    for name, t in (("last trade before", before[-1] if before else None),
                    ("first trade after", after[0] if after else None)):
        if t:
            print(f"{name}: price={float(t['p']):.2f} at {t['T']} ms "
                  f"(Δ {t['T'] - TS:+d} ms)")

    print(f"\nBTCUSDT price source: GET {BASE}/api/v3/klines?symbol={SYMBOL}"
          f"&interval=1s&startTime={TS}")


if __name__ == "__main__":
    main()
