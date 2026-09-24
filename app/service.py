import concurrent.futures as cf
import math
import threading
import time

import pandas as pd

import main
from engine import matching, pricing
from markets import kalshi, polymarket

POOL = cf.ThreadPoolExecutor(8)
SIZE = 1000  # contracts behind the net total


def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


class Store:
    def __init__(self, data=None):
        self.lock = threading.Lock()
        self.scanning = False
        self.error = ''
        self.data = data or dict(time=None, kalshi=[], polymarket=[], pairs=[])
        self.install(self.data)

    def install(self, data):
        markets = {(v, m['id']): m for v in ('kalshi', 'polymarket') for m in data[v]}
        partners = {}
        for q in sorted(data['pairs'], key=lambda q: (not q.get('primary'), -q['cosine'])):
            for v in ('kalshi', 'polymarket'):
                partners.setdefault((v, q[v]), []).append(q)
        index = [(key, matching.plain(' '.join([m['title'], m['event'], m['outcome'], m['id']])),
                  any(q.get('match') and q['match'].get('ok') for q in partners.get(key, [])),
                  matching.ts(m['close'])) for key, m in markets.items()]
        with self.lock:
            self.data, self.markets, self.partners, self.index = data, markets, partners, index

    def status(self):
        return dict(time=self.data['time'], count=len(self.markets), scanning=self.scanning, error=self.error)

    def rescan(self):
        with self.lock:
            if self.scanning:
                return
            self.scanning, self.error = True, ''
        def run():
            try:
                self.install(main.scan())
            except Exception as exc:
                self.error = str(exc)
            finally:
                self.scanning = False
        threading.Thread(target=run, daemon=True).start()

    def search(self, query):
        words = matching.plain(query).split()
        now, found = time.time(), []
        for key, text, paired, close in self.index:
            if all(w in text for w in words):
                found.append((close <= now, not paired, -self.markets[key]['volume'], key))
        return [dict(venue=key[0], id=key[1], title=self.markets[key]['title'], outcome=self.markets[key]['outcome'],
                     paired=not unpaired, volume=-volume, closed=closed)
                for closed, unpaired, volume, key in sorted(found)[:16]]

    def selection(self, venue, ident):
        other = 'polymarket' if venue == 'kalshi' else 'kalshi'
        q = next((q for q in self.partners.get((venue, ident), []) if q.get('match') and q['match']['ok']), None)
        selected = {venue: self.markets[(venue, ident)]}
        if q:
            selected[other] = self.markets[(other, q[other])]
        return selected, q

    def detail(self, venue, ident):
        selected, pair = self.selection(venue, ident)
        jobs = {v: POOL.submit(live, m) for v, m in selected.items()}
        markets = {v: job.result() for v, job in jobs.items()}
        rows, curves = [], {}

        def add(key, label, a, b, y, no):
            one, _ = evaluate(a, b, y, no, 1)
            bulk, curves[key] = evaluate(a, b, y, no, SIZE)
            rows.append(dict(one, key=key, label=label, bulk=bulk, status=bulk['status'], eligible=bulk['eligible'],
                             rates=[a['rate'], b['rate']], cents=[a['venue'] == 'kalshi', b['venue'] == 'kalshi'],
                             depth=[sum(q for _, q in a['book'][y]), sum(q for _, q in b['book'][no])]))
            return rows[-1]

        for v, m in markets.items():
            add(v, v.title() + ' · both outcomes', m, m, 'yes', 'no')
        flip = bool(pair and pair['match']['flip'])
        if len(markets) == 2:
            k, p = markets['kalshi'], markets['polymarket']
            py, pn = ('no', 'yes') if flip else ('yes', 'no')
            for key, a, b, y, no, label in (
                ('kalshi_yes', k, p, 'yes', pn, 'Kalshi Yes + Poly ' + p['sides'][1 if pn == 'no' else 0]),
                ('polymarket_yes', p, k, py, 'no', 'Poly ' + p['sides'][0 if py == 'yes' else 1] + ' + Kalshi No')):
                row = add(key, label, a, b, y, no)
                if row['eligible']:
                    row['status'] += ' · rules unverified'
        return clean(dict(markets=markets, pair=pair, flip=flip, rows=rows, curves=curves,
                          caveats=matching.caveats(selected['kalshi'], selected['polymarket']) if len(selected) == 2 else [],
                          time=time.time(), costs=dict(n=SIZE)))

    def histories(self, venue, ident):
        selected, pair = self.selection(venue, ident)
        jobs = {v: POOL.submit(main.history if v == 'kalshi' else main.asks, m) for v, m in selected.items()}
        ms = lambda t: int(t.timestamp() * 1000)
        single = {}
        for v, job in jobs.items():
            try:
                h = job.result()
            except (ValueError, KeyError, OSError):
                continue
            if h is None or h.empty:
                continue
            if v == 'kalshi':
                single[v] = [[ms(r.t), r.ask, r.bid] for r in h.sort_values('t').drop_duplicates('t').itertuples()]
            else:
                single[v] = {side: [[ms(r.t), r.p] for r in g.itertuples()] for side, g in h.groupby('side')}
        span = {v: [ms(pd.Timestamp(m['open'])), ms(pd.Timestamp(m['close']))] for v, m in selected.items()}
        return clean(dict(single=single, span=span, flip=bool(pair and pair['match']['flip'])))


def live(m):
    started = time.time()
    try:
        s = (kalshi if m['venue'] == 'kalshi' else polymarket).snapshot(m)
        s['latency'] = time.time() - started
        s['error'] = ''
        s['rules'] = s.get('rules', m['rules'])
    except (ValueError, KeyError, TypeError, kalshi.requests.RequestException) as exc:
        s = dict(quotes={k: m.get(k, math.nan) for k in ('yes_bid', 'yes_ask', 'no_bid', 'no_ask')},
                 book=dict(yes=[], no=[]), rate=math.nan, observed=None, timestamp=None,
                 active=False, minimum=0, latency=time.time() - started, error=type(exc).__name__)
    return dict(m, **s)


def evaluate(a, b, y, no, n):
    ya = dict(asks=a['book'][y], rate=a['rate'], cents=a['venue'] == 'kalshi')
    na = dict(asks=b['book'][no], rate=b['rate'], cents=b['venue'] == 'kalshi')
    r = pricing.executable(ya, na, n)
    valid = all(not m['error'] and m['active'] and m['latency'] <= 10 and
                time.time() - (m['observed'] or 0) <= 15 and
                (m['timestamp'] is None or 0 <= time.time() - m['timestamp'] <= 15) for m in (a, b))
    valid = valid and abs((a['observed'] or 0) - (b['observed'] or 0)) <= 3
    minimum = r['n'] > 0 and all(r['n'] >= m['minimum'] for m in (a, b))
    r['eligible'] = bool(valid and minimum and math.isfinite(r['edge']))
    r['status'] = ('Positive estimate' if r['edge'] > 0 else 'No net edge') if r['eligible'] else (
        'No liquidity' if not r['n'] else 'Below venue minimum' if not minimum else 'Data / fees unverified')
    r['labels'] = [a['venue'].title() + ' ' + a['sides'][0 if y == 'yes' else 1] + ' + fee',
                   '$1 − ' + b['venue'].title() + ' ' + b['sides'][0 if no == 'yes' else 1] + ' − fee']
    curve = []
    for size in sorted(set([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, n])):
        point = pricing.executable(ya, na, size)
        if point['n'] > 0 and (not curve or point['n'] != curve[-1][0]):
            curve.append([point['n'], point['yes'] + point['fee_yes'], 1 - point['no'] - point['fee_no']])
    return r, curve
