import math
import time

import pandas as pd
import requests

from engine.matching import ts

BASE = "https://external-api.kalshi.com/trade-api/v2"
_http = requests.Session()
_series = {}


def get(path, **params):
    """Backs off on 429 and on a dropped connection."""
    for wait in (0.5, 1, 2, 4, 8):  # the scan fetches thousands of histories and hits rate limits
        try:
            r = _http.get(BASE + path, params=params, timeout=10)
        except (requests.ConnectionError, requests.Timeout):
            time.sleep(wait)
            continue
        if r.status_code != 429:
            r.raise_for_status()
            return r.json()
        time.sleep(wait)
    raise requests.ConnectionError(f"{path}: kept failing")


def markets(min_volume=1000, log=print):
    """Open markets with volume, via /events so the parlay legs that flood /markets stay out."""
    out, cursor, pages = [], None, 0
    now = time.time()
    while True:
        page = get("/events", status="open", limit=200, with_nested_markets="true", cursor=cursor)
        for e in page["events"]:
            for m in e["markets"]:
                if m["status"] != "active" or float(m["volume_fp"]) < min_volume or ts(m["close_time"]) < now:
                    continue
                out.append(dict(
                    venue="kalshi", id=m["ticker"], series=e["series_ticker"],
                    event=e["title"], title=m.get("title") or e["title"], outcome=m.get("yes_sub_title", ""),
                    open=m["open_time"], close=m["close_time"],
                    volume=float(m["volume_fp"]),
                    yes_bid=float(m["yes_bid_dollars"]), yes_ask=float(m["yes_ask_dollars"]),
                    no_bid=float(m["no_bid_dollars"]), no_ask=float(m["no_ask_dollars"]),
                    rules=m["rules_primary"], sources=[s.get("name") or s.get("url", "") for s in e.get("settlement_sources", [])],
                    sides=("Yes", "No"),
                ))
        cursor, pages = page.get("cursor"), pages + 1
        if pages % 10 == 0:
            log(f"  kalshi page {pages}, {len(out)} markets kept")
        if not cursor:
            return out


def fee_rate(series):
    if series not in _series or time.time() - _series[series][0] > 300:
        s = get(f"/series/{series}")["series"]
        rate = 0.07 * float(s['fee_multiplier']) if s.get('fee_type') in ('quadratic', 'quadratic_with_maker_fees') else math.nan
        _series[series] = (time.time(), rate)
    return _series[series][1]


def book(ticker):
    """Asks on each side, best first: the API serves bids, and an ask is one minus the other side's bid."""
    ob = get(f"/markets/{ticker}/orderbook")["orderbook_fp"]
    flip = lambda side: sorted((round(1 - float(p), 4), float(q)) for p, q in side)
    return {"yes": flip(ob.get("no_dollars") or []), "no": flip(ob.get("yes_dollars") or [])}


def snapshot(m):
    market = get('/markets/' + m['id'])['market']
    rate = fee_rate(m['series'])
    asks = book(m['id'])
    quotes = {}
    for side, opposite in (('yes', 'no'), ('no', 'yes')):
        quotes[side + '_ask'] = asks[side][0][0] if asks[side] else math.nan
        quotes[side + '_bid'] = 1 - asks[opposite][0][0] if asks[opposite] else math.nan
    return dict(quotes=quotes, book=asks, rate=rate, observed=time.time(), timestamp=None,
                active=market.get('status') == 'active', minimum=0,
                rules=market.get('rules_primary', m['rules']))


def history(series, ticker, open_time):
    """Yes bid and ask closes from open to now."""
    start, now = int(ts(open_time)), int(time.time())
    age = now - start
    period = 1440 if age > 60 * 86400 else 60 if age > 2 * 86400 else 1
    cs = get(f"/series/{series}/markets/{ticker}/candlesticks",
             start_ts=start, end_ts=now, period_interval=period)["candlesticks"]
    df = pd.DataFrame({
        "t": pd.to_datetime([c["end_period_ts"] for c in cs], unit="s", utc=True),
        "bid": [float(c["yes_bid"]["close_dollars"]) for c in cs],
        "ask": [float(c["yes_ask"]["close_dollars"]) for c in cs],
    })
    df["p"] = (df.bid + df.ask) / 2
    return df
