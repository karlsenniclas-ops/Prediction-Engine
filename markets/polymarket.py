import concurrent.futures as cf
import datetime as dt
import json
import math
import time

import pandas as pd
import requests

GAMMA = "https://gamma-api.polymarket.com"
DATA = "https://data-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
_http = requests.Session()


def _call(method, url, **kw):
    """Backs off on 429 and on a dropped connection."""
    for wait in (0.5, 1, 2):
        try:
            r = _http.request(method, url, timeout=10, **kw)
        except (requests.ConnectionError, requests.Timeout):
            time.sleep(wait)
            continue
        if r.status_code != 429:
            return r
        time.sleep(wait)
    raise requests.ConnectionError(f"{url}: kept failing")


def _json(method, url, **kw):
    r = _call(method, url, **kw)
    r.raise_for_status()
    return r.json()


def ts(iso):
    return dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def markets(min_volume=1000, log=print):
    """Markets taking orders, via /events by volume since only events carry tags; the offset stops at 2100."""
    out, offset, now = [], 0, time.time()
    while True:
        r = _call("GET", GAMMA + "/events", params=dict(active="true", closed="false", order="volume",
                                                       ascending="false", limit=100, offset=offset))
        if r.status_code == 422 or not r.json():
            return out
        r.raise_for_status()
        for e in r.json():
            for m in e.get("markets", []):
                close = m.get("endDate") or e.get("endDate")
                if not m.get("acceptingOrders") or (m.get("volumeNum") or 0) < min_volume or not m.get("clobTokenIds") or not close or ts(close) < now:
                    continue
                ids = json.loads(m["clobTokenIds"])
                if len(ids) != 2:
                    continue
                yes, no = ids
                sides = tuple(json.loads(m.get("outcomes") or '["Yes", "No"]'))
                out.append(dict(
                    venue="polymarket", id=m["slug"], yes=yes, no=no,
                    event=e["title"], title=m["question"],
                    outcome=m.get("groupItemTitle") or (sides[0] if sides[0] != "Yes" else ""),
                    open=m.get("startDate") or e.get("startDate") or m["createdAt"],
                    close=close,
                    volume=float(m.get("volumeNum") or 0),
                    yes_bid=float(m.get("bestBid") or 0), yes_ask=float(m.get("bestAsk") or 1),
                    rules=m.get("description", ""), sources=[], sides=sides,
                ))
        offset += 100
        if offset % 500 == 0:
            log(f"  polymarket offset {offset}, {len(out)} markets kept")


def fee_rate(m):
    if m.get('feesEnabled') is False:
        return 0.0
    schedule = m.get('feeSchedule') or {}
    if m.get('feesEnabled') is not True or schedule.get('exponent', 1) != 1:
        return math.nan
    return float(schedule['rate']) if schedule.get('rate') is not None else math.nan


def snapshot(m):
    from engine.pricing import levels
    meta = _json('GET', GAMMA + '/markets/slug/' + m['id'])
    raw = _json('POST', CLOB + '/books', json=[{'token_id': m['yes']}, {'token_id': m['no']}])
    by_id = {b['asset_id']: b for b in raw}
    asks, quotes, timestamps = {}, {}, []
    for side in ('yes', 'no'):
        b = by_id.get(m[side], {})
        asks[side] = levels([(float(l['price']), float(l['size'])) for l in b.get('asks', [])])
        bids = levels([(float(l['price']), float(l['size'])) for l in b.get('bids', [])])
        quotes[side + '_ask'] = asks[side][0][0] if asks[side] else math.nan
        quotes[side + '_bid'] = bids[-1][0] if bids else math.nan
        timestamps.append(float(b['timestamp']) / 1000 if b.get('timestamp') else 0)
    return dict(quotes=quotes, book=asks, rate=fee_rate(meta), observed=time.time(),
                timestamp=min(timestamps), active=bool(meta.get('acceptingOrders') and not meta.get('closed')),
                minimum=float(meta.get('orderMinSize') or 0), rules=meta.get('description', m['rules']))


def history(token, open_time):
    """The traded price over the whole life; interval=max serves 31 days unless fidelity is at least 720."""
    age = time.time() - ts(open_time)
    fidelity = 720 if age > 30 * 86400 else 60
    h = _json("GET", CLOB + "/prices-history", params=dict(market=token, interval="max", fidelity=fidelity))["history"]
    return pd.DataFrame({"t": pd.to_datetime([x["t"] for x in h], unit="s", utc=True), "p": [float(x["p"]) for x in h]})


def asks(m):
    """What takers paid per token, volume weighted per hour; the API serves only the latest 11,000 trades."""
    market = _json("GET", GAMMA + "/markets/slug/" + m["id"])["conditionId"]
    page = lambda offset: _json("GET", DATA + "/trades", params=dict(market=market, limit=1000, offset=offset, takerOnly="true"))
    with cf.ThreadPoolExecutor(6) as ex:
        trades = [t for p in ex.map(page, range(0, 10001, 1000)) for t in p]
    side = {m["yes"]: "yes", m["no"]: "no"}
    df = pd.DataFrame([(t["timestamp"], side[t["asset"]], float(t["price"]) * float(t["size"]), float(t["size"])) for t in trades
                       if t.get("side") == "BUY" and t.get("asset") in side], columns=["t", "side", "paid", "size"])
    df["t"] = pd.to_datetime(df.t, unit="s", utc=True).dt.floor("h")
    df = df.groupby(["side", "t"], as_index=False)[["paid", "size"]].sum()
    return df.assign(p=df.paid / df["size"])[["t", "side", "p"]]
