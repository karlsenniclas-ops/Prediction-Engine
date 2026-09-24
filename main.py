import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import time

import pandas as pd
import requests

from engine import matching
from markets import kalshi, polymarket

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
HIST = os.path.join(CACHE, "history")
SCAN = os.path.join(CACHE, "scan.json")
MAX_CONFIRM = 6000     # candidate pairs sent to the data stage, highest volume first
HIST_TTL = 6 * 3600


def log(msg):
    print(msg, flush=True)


def cached(m, fetch, tag=""):
    """fetch() kept on disk for HIST_TTL."""
    os.makedirs(HIST, exist_ok=True)
    path = os.path.join(HIST, f"{m['venue']}{tag}_{m['id'][:40]}_{hashlib.md5(m['id'].encode()).hexdigest()[:8]}.csv")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < HIST_TTL:
        h = pd.read_csv(path)
    else:
        try:
            h = fetch()
        except (requests.RequestException, ValueError, KeyError):
            return None
        h.to_csv(path + ".part", index=False)
        os.replace(path + ".part", path)
    h["t"] = pd.to_datetime(h["t"], utc=True)
    return h


def history(m):
    return cached(m, lambda: kalshi.history(m["series"], m["id"], m["open"]) if m["venue"] == "kalshi"
                  else polymarket.history(m["yes"], m["open"]))


def asks(m):
    """Polymarket Yes and No ask paths; Kalshi's come with history()."""
    return cached(m, lambda: polymarket.asks(m), "_asks")


def scan():
    t0 = time.time()
    with cf.ThreadPoolExecutor(2) as ex:
        fk, fp = ex.submit(kalshi.markets, log=log), ex.submit(polymarket.markets, log=log)
        K, P = fk.result(), fp.result()
    log(f"{len(K)} kalshi and {len(P)} polymarket markets with volume, {time.time() - t0:.0f}s")

    pairs, funnel = matching.candidates(K, P)
    km, pm = {m["id"]: m for m in K}, {m["id"]: m for m in P}
    pairs.sort(key=lambda q: -min(km[q["kalshi"]]["volume"], pm[q["polymarket"]]["volume"]))
    if len(pairs) > MAX_CONFIRM:
        log(f"  {len(pairs) - MAX_CONFIRM} lowest-volume candidates left unconfirmed")
        pairs = pairs[:MAX_CONFIRM]
    funnel["sent to the data stage"] = len(pairs)

    hist = {}
    fetch = lambda m: hist.__setitem__((m["venue"], m["id"]), history(m))
    kids, pids = {q["kalshi"] for q in pairs}, {q["polymarket"] for q in pairs}
    log(f"fetching {len(kids)} kalshi and {len(pids)} polymarket histories")
    with cf.ThreadPoolExecutor(8) as ek, cf.ThreadPoolExecutor(8) as ep:
        jobs = [ek.submit(fetch, km[i]) for i in kids] + [ep.submit(fetch, pm[i]) for i in pids]
        for n, j in enumerate(cf.as_completed(jobs), 1):
            j.result()
            if n % 500 == 0:
                log(f"  {n}/{len(jobs)} histories, {time.time() - t0:.0f}s")

    funnel.update({"histories on both sides": 0, "enough overlap": 0, "price paths agree": 0})
    for q in pairs:
        hk, hp = hist[("kalshi", q["kalshi"])], hist[("polymarket", q["polymarket"])]
        q["match"] = None
        if hk is None or hp is None or hk.empty or hp.empty:
            continue
        funnel["histories on both sides"] += 1
        q["match"] = matching.confirm(hk, hp, q["cosine"])
        funnel["enough overlap"] += q["match"]["points"] >= matching.MIN_POINTS
        funnel["price paths agree"] += q["match"]["ok"]
    confirmed = [q for q in pairs if q["match"] and q["match"]["ok"]]

    # one partner per market: the others are usually a related bet whose gap only looks like an edge
    taken = set()
    for q in sorted(confirmed, key=lambda q: (-q["cosine"], q["deadline_gap_h"])):
        q["primary"] = q["kalshi"] not in taken and q["polymarket"] not in taken
        if q["primary"]:
            taken.update((q["kalshi"], q["polymarket"]))
    funnel["one partner per market"] = sum(q["primary"] for q in confirmed)

    for name, n in funnel.items():
        log(f"  {name:28} {n}")
    log(f"{len(confirmed)} confirmed pairs, {time.time() - t0:.0f}s")
    data = dict(time=time.time(), kalshi=K, polymarket=P, pairs=pairs, funnel=funnel)
    os.makedirs(CACHE, exist_ok=True)
    with open(SCAN + '.part', 'w') as f:
        json.dump(data, f)
    os.replace(SCAN + '.part', SCAN)
    return data


def load():
    return json.load(open(SCAN))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh", action="store_true", help="scan before opening")
    ap.add_argument("--no-app", action="store_true", help="scan only")
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--no-browser', action='store_true')
    args = ap.parse_args()
    if args.fresh or args.no_app:
        scan()
    if not args.no_app:
        from app.server import serve
        serve(args.port, not args.no_browser)
