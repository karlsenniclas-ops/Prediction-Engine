import math


def fee(rate, p, n=1.0, cents=False):
    if not all(math.isfinite(x) for x in (rate, p, n)):
        return math.nan
    if rate < 0 or not 0 <= p <= 1 or n < 0:
        raise ValueError('Invalid fee inputs')
    f = rate * n * p * (1 - p)
    return math.ceil(f * 100 - 1e-9) / 100 if cents else f


def levels(asks):
    if any(not math.isfinite(p) or not math.isfinite(q) or not 0 <= p <= 1 or q < 0 for p, q in asks):
        raise ValueError('Invalid order-book level')
    return sorted((p, q) for p, q in asks if q > 0)


def walk(asks, n):
    if not math.isfinite(n) or n < 0:
        raise ValueError('Invalid contract count')
    fills, left = [], n
    for p, q in levels(asks):
        if left <= 0:
            break
        take = min(q, left)
        fills.append((p, take))
        left -= take
    filled = n - left
    price = sum(p * q for p, q in fills) / filled if filled else math.nan
    return price, filled, fills


def walk_fee(rate, fills, cents=False):
    f = sum(fee(rate, p, q) for p, q in fills)
    return math.ceil(f * 100 - 1e-9) / 100 if cents and math.isfinite(f) else f


def executable(yes_leg, no_leg, n):
    if not math.isfinite(n) or n < 0:
        raise ValueError('Invalid contract count')
    ya, na = levels(yes_leg['asks']), levels(no_leg['asks'])
    requested = n
    n = min(n, sum(q for _, q in ya), sum(q for _, q in na))
    if yes_leg['cents'] or no_leg['cents']:
        n = math.floor(n)
    result = dict(requested=requested, n=n, partial=n < requested)
    if n <= 0:
        return dict(result, **{k: math.nan for k in ('yes', 'no', 'fee_yes', 'fee_no', 'slippage', 'edge', 'profit', 'cost', 'roi')})
    py, _, fy = walk(ya, n)
    pn, _, fn = walk(na, n)
    fee_yes = walk_fee(yes_leg['rate'], fy, yes_leg['cents']) / n
    fee_no = walk_fee(no_leg['rate'], fn, no_leg['cents']) / n
    k = py + pn + fee_yes + fee_no
    return dict(result, yes=py, no=pn, fee_yes=fee_yes, fee_no=fee_no, slippage=py + pn - ya[0][0] - na[0][0],
                edge=1 - k, profit=n * (1 - k), cost=n * k, roi=(1 - k) / k)
