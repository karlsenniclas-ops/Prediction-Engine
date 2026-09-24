# Prediction Engine

A small tool I made to find the same bet on Kalshi and Polymarket and check if you can buy both sides for less than the $1 they pay out. It checks one market at a time (Yes and No on the same site) and across the two sites.

The idea came from three papers on arbitrage in prediction markets, listed at the bottom.

## How to run it

You need Python 3.10 or newer.

```
python -m pip install -r requirements.txt
python main.py
```

The first time there is no market list yet, so it scans both sites in the background and that takes a while

## What is in the folder

- `main.py` starts everything, scans the markets and caches price history
- `markets/` talks to the Kalshi and Polymarket APIs
- `engine/` matches the same bet across the two sites and does the pricing math
- `app/` is the local web page and the small server behind it
- `cache/` holds the market list and price history. You can delete it, but then the next start has to scan again.

## Using it

- the live bid and ask on both sites
- two single market charts with the Yes ask against $1 minus the No ask over the life of the bet
- a cross market chart that does the same with Yes on one site and No on the other

## The math

All prices are in dollars per contract.

```
n     = min(contracts wanted, depth on the yes book, depth on the no book)
p     = sum(price * size) / n        average price when walking the ask book
fee   = rate * sum(size * price * (1 - price))
K     = p_yes + p_no + (fee_yes + fee_no) / n
net   = 1 - K                        per pair
total = n * net
ROI   = net / K
```

Kalshi rounds the fee on every order up to a whole cent, so one contract can come out negative while 1,000 contracts don't. If a fee rate is unknown the result is left empty instead of counted as free.

## Keep in mind

The matching uses the titles and how the prices moved, so it can pair two bets that don't settle the same way. Read the rules on both sites before trusting a cross market result. Green in the history charts shows where it looked possible back then, not a trade you could have made. Polymarket's trade feed only goes back 11,000 trades, so its chart starts late for busy markets.

## Sources

- Saguillo, Ghafouri, Kiffer & Suarez-Tangil (2025), [Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets](https://arxiv.org/abs/2508.03474)
- Gebele, Mutzel & Matthes (2026), [Executable Arbitrage and Market Efficiency in Prediction Markets](https://arxiv.org/abs/2608.00666)
- Cheng, Yang & Zou (2026), [Arbitrage Analysis in Polymarket NBA Markets](https://arxiv.org/abs/2605.00864)
- [Polymarket fees](https://docs.polymarket.com/trading/fees) and the [Kalshi fee schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf)
