import collections
import datetime as dt
import math
import re
import unicodedata

import pandas as pd

RARE = 80          # a word counts as evidence when at most this many titles carry it
NAME = 50          # unshared words this rare on both sides mean two different subjects
COMMON = 500       # words carried by more titles than this say nothing about the subject
NEAR = 0.6         # idf-weighted cosine at which titles read alike enough to pair without a rare word
SAME = 0.8         # cosine at which they read as the same sentence
DAYS = 3           # deadlines may differ by this, or 5% of the horizon, whichever is larger
LOOSE_DAYS = 120   # when the titles read as the same sentence: Kalshi often closes on the last possible day
PER_MARKET = 5     # candidates kept per Kalshi market, closest wording first
MIN_POINTS = 8     # aligned points needed before the paths are compared
STRONG_CORR = 0.75 # paths this correlated may sit up to MAX_GAP apart: venues disagree
MAX_GAP = 0.10
MIN_CORR = 0.6     # weaker co-movement passes only when the paths sit within TIGHT_GAP
TIGHT_GAP = 0.05
MAX_RATIO = 1.3    # mean levels within 30%: a subset of the bet sits systematically lower
MIN_COS = 0.4      # titles must read alike at least this much, or the co-movement is coincidence

STOP = set("will the be a an on in of by before after to at vs and or for is this that who what "
           "which than more less market markets yes no win wins".split())
MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec"
MONTH = re.compile(r"(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)")
DATE = re.compile(rf"\b(?:(?:{MONTHS})[a-z]*\.?\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,?\s*\d{{4}})?"
                  rf"|\d{{1,2}}\s+(?:{MONTHS})[a-z]*\.?|\d{{4}}-\d{{2}}-\d{{2}}|\d{{1,2}}\s*(?:am|pm))\b")
SEASON = re.compile(r"\b((?:19|20)\d{2})[-/]\d{2}\b")
NUMBER = re.compile(r"\$?(\d[\d,]*\.?\d*)\s*(k|m|b|t|million|billion|trillion)?\b")
UNIT = {"k": 1e3, "m": 1e6, "million": 1e6, "b": 1e9, "billion": 1e9, "t": 1e12, "trillion": 1e12}
WORD = re.compile(r"#\d[\d.]*|[^\W\d_][^\W\d_']+")
NEGATION = re.compile(r"\b(no|not|fail|fails|without|never)\b|n't\b")
DIRECTION = {
    "above": r"\b(above|over|exceed|exceeds|higher|at least|or more|or higher|more than)\b",
    "reach": r"\b(reach|reaches|hit|hits|touch)\b",
    "below": r"\b(below|under|lower|at most|or less|or lower|less than)\b",
    "dip": r"\b(dip|dips|fall|falls|drop|drops)\b",
    "between": r"\bbetween\b",
    "cut": r"\b(cut|cuts|decrease|decreases)\b",
    "hike": r"\b(hike|hikes|increase|increases|raise|raises)\b",
    "hold": r"\b(maintain|maintains|unchanged|no change|pause|pauses)\b",
}


def _number(m):
    v = float(m.group(1).replace(",", "")) * UNIT.get(m.group(2) or "", 1)
    v = round(v) if v >= 100 else round(v, 2)
    return " #%s " % (int(v) if v == int(v) else v)


def plain(text):
    """Lowercase without accents, so Nicolás and Nicolas are one word."""
    return "".join(c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c))


def tokens(text):
    """Words worth matching on; $109,999.99 and $110k both become #110000, years become y2026."""
    t = re.sub(r"(\d)([a-z])", r"\1 \2", plain(text))
    t = NUMBER.sub(_number, SEASON.sub(r"\1", DATE.sub(" ", t)))
    out = set()
    for w in WORD.findall(t):
        if w[0] == "#":
            n = float(w[1:])
            out.add("y%d" % n if 1900 <= n <= 2100 and n == int(n) else w)
        elif len(w.removesuffix("'s")) >= 3 and w not in STOP:
            w = w.removesuffix("'s")
            out.add(w[:3] if MONTH.fullmatch(w) else w)
    return out


def polarity(text):
    t = plain(text)
    negation = bool(NEGATION.search(re.sub(r"\bno change\b", "hold", t)))
    return negation, frozenset(k for k, rx in DIRECTION.items() if re.search(rx, t))


def text_of(m):
    return " ".join([m["event"], m["title"], m["outcome"], " ".join(m["sides"]) if m["sides"][0] != "Yes" else ""])


def ts(iso):
    return dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def frequencies(markets):
    docs = [tokens(text_of(m)) for m in markets]
    return collections.Counter(w for d in docs for w in d), len(docs)


def cosine(a, b, corpus):
    """idf-weighted cosine of two token sets over the words that say something about the subject."""
    df, n_docs = corpus
    va = {w: math.log(n_docs / df[w]) for w in a if 0 < df[w] <= COMMON}
    vb = {w: math.log(n_docs / df[w]) for w in b if 0 < df[w] <= COMMON}
    dot = sum(v * v for w, v in va.items() if w in vb)
    return dot / ((math.sqrt(sum(v * v for v in va.values())) or 1) * (math.sqrt(sum(v * v for v in vb.values())) or 1))


def candidates(kalshi, poly, now=None, corpus=None):
    """Text stage: pairs that share a rare word or read alike, with deadline, thresholds and polarity agreeing."""
    now = now or dt.datetime.now(dt.timezone.utc).timestamp()
    docs = {m["id"]: dict(toks=tokens(text_of(m)), pol=polarity(m["title"] + " " + m["outcome"]), t=ts(m["close"]))
            for m in kalshi + poly}
    df, n_docs = corpus or frequencies(kalshi + poly)
    idf = {w: math.log(n_docs / df[w]) for d in docs.values() for w in d["toks"] if df[w]}
    for d in docs.values():
        d["vec"] = {w: idf[w] for w in d["toks"] if 0 < df[w] <= COMMON}
        d["norm"] = math.sqrt(sum(v * v for v in d["vec"].values())) or 1
        d["nums"] = {w for w in d["toks"] if w[0] == "#" and (float(w[1:]) >= 10 or "." in w)}
        d["rare"] = {w for w in d["toks"] if 0 < df[w] <= RARE and (w[0] != "#" or w in d["nums"])}
        d["names"] = {w for w in d["toks"] if 0 < df[w] <= NAME and w[0] != "#"}
    index = collections.defaultdict(list)
    for p in poly:
        for w in docs[p["id"]]["vec"]:
            index[w].append(p["id"])
    funnel = collections.OrderedDict([("kalshi markets", len(kalshi)), ("polymarket markets", len(poly)),
                                      ("share a rare word or read alike", 0), ("deadline within window", 0),
                                      ("thresholds agree", 0), ("polarity agrees", 0), ("no conflicting name", 0),
                                      (f"within the {PER_MARKET} closest per market", 0)])
    pairs = []
    for k in kalshi:
        dk, dots = docs[k["id"]], collections.defaultdict(float)
        for w, v in dk["vec"].items():
            for pid in index[w]:
                dots[pid] += v * v
        kept = []
        for pid, dot in dots.items():
            dp = docs[pid]
            cos = dot / (dk["norm"] * dp["norm"])
            if cos < NEAR and not dk["rare"] & dp["rare"]:
                continue
            funnel["share a rare word or read alike"] += 1
            gap = abs(dk["t"] - dp["t"])
            window = LOOSE_DAYS * 86400 if cos >= SAME else max(DAYS * 86400, 0.05 * max(1, min(dk["t"], dp["t"]) - now))
            if gap > window:
                continue
            funnel["deadline within window"] += 1
            if dk["nums"] and dp["nums"] and not dk["nums"] & dp["nums"]:
                continue
            funnel["thresholds agree"] += 1
            if dk["pol"] != dp["pol"]:
                continue
            funnel["polarity agrees"] += 1
            if dk["names"] - dp["names"] and dp["names"] - dk["names"]:
                continue
            funnel["no conflicting name"] += 1
            kept.append((cos, pid, gap))
        for cos, pid, gap in sorted(kept, key=lambda c: (-c[0], c[2]))[:PER_MARKET]:
            funnel[f"within the {PER_MARKET} closest per market"] += 1
            pairs.append(dict(kalshi=k["id"], polymarket=pid, cosine=cos, shared=sorted(dk["toks"] & docs[pid]["toks"]),
                              deadline_gap_h=gap / 3600))
    return pairs, funnel


def align(hk, hp):
    """Both paths on one grid, the coarser of the two steps, carried forward where a venue was silent."""
    step = lambda h: h.t.diff().median() if len(h) > 1 else pd.Timedelta(0)
    rule = "D" if max(step(hk), step(hp)) >= pd.Timedelta(hours=12) else "h"
    a = hk.set_index("t").p.resample(rule, label='right', closed='right').last().ffill(limit=1)
    b = hp.set_index("t").p.resample(rule, label='right', closed='right').last().ffill(limit=1)
    return pd.concat([a, b], axis=1, join="inner", keys=["k", "p"]).dropna()


def agree(j, cosine=1.0):
    """Data stage: the paths move together and sit at one level; flip means Kalshi YES tracks Polymarket NO."""
    out = dict(points=len(j), corr=math.nan, gap=math.nan, ratio=math.nan, flip=False, flat=False, ok=False)
    if len(j) < MIN_POINTS:
        return out
    out["flat"] = bool(j.k.std() < 0.01 or j.p.std() < 0.01)
    if out["flat"]:
        return out
    for flip, q in ((False, j.p), (True, 1 - j.p)):
        corr = j.k.corr(q)
        if math.isnan(out["corr"]) or corr > out["corr"]:
            lo, hi = sorted((j.k.mean(), q.mean()))
            out.update(corr=corr, gap=(j.k - q).abs().mean(), ratio=hi / lo if lo > 0 else math.inf, flip=flip)
    out["ok"] = bool(cosine >= MIN_COS and out["ratio"] <= MAX_RATIO and (
        (out["corr"] >= STRONG_CORR and out["gap"] <= MAX_GAP) or (out["corr"] >= MIN_CORR and out["gap"] <= TIGHT_GAP)))
    return out


def confirm(hk, hp, cosine=1.0):
    return agree(align(hk, hp), cosine)


def dates_in(text):
    return sorted({m.group(0) for m in DATE.finditer(text.lower()) if not re.fullmatch(r"\d{1,2}\s*(am|pm)", m.group(0))})


def sources_in(m):
    if m["sources"]:
        return "; ".join(m["sources"])
    return " ".join(s.strip() for s in re.split(r"(?<=[.!?])\s+", m["rules"])
                    if re.search(r"source|according to|based on", s.lower()))


def caveats(k, p):
    """Where the windows and the settlement sources differ."""
    hours = abs(ts(k["close"]) - ts(p["close"])) / 3600
    return [
        ("Closes", k["close"], p["close"], f"{hours:.0f} h apart"),
        ("Listed", k["open"], p["open"], "listing dates are not observation windows"),
        ("Settlement source", sources_in(k) or "none named", sources_in(p) or "none named", "compare the named sources"),
        ("Dates named in the rules", ", ".join(dates_in(k["rules"])) or "none",
         ", ".join(dates_in(p["rules"])) or "none", "the window each market counts over"),
    ]
