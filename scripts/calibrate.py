"""Measure the probability layer instead of trusting it.

Everything the engine decides is a function of the win-probability matrix, and
errors there compound multiplicatively across eighteen sequential picks. So
this answers, on real outcomes, the three questions the model layer cannot
answer about itself:

    python3 scripts/calibrate.py devig       # how much do the methods disagree?
    python3 scripts/calibrate.py spread      # which spread model is best?
    python3 scripts/calibrate.py reliability # is it calibrated where we live?
    python3 scripts/calibrate.py horizon     # how fast does an estimate rot?
    python3 scripts/calibrate.py all

Like `backtest.py` this fetches, so it lives in `scripts/`, is never imported
by the suite, and shares that script's cached copy of nflverse's results.

── The band that matters ───────────────────────────────────────────────────

Reliability is reported over the whole range and then again over **0.70-0.95**,
because that is where every survivor pick actually lives. A model that is well
calibrated on coin flips and 3 points optimistic on heavy favourites is, for
this purpose, a badly calibrated model -- and an aggregate score will not say
so, because the middle of the distribution has most of the games in it.
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from models.win_prob import (  # noqa: E402
    DEVIG_METHODS,
    SPREAD_LOGISTIC_INTERCEPT,
    SPREAD_LOGISTIC_SLOPE,
    TIE_PROBABILITY,
    devig,
    implied_prob_from_moneyline,
)
from scripts.backtest import load_rows, _number  # noqa: E402

# The normal-approximation spread model from the survivor literature, for
# comparison against the fitted logistic. sigma is the standard published
# figure for the spread of NFL margins around the line.
NORMAL_SIGMA = 13.3

_PHI = lambda z: 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def logistic_home_share(spread_line: float) -> float:
    """The shipped model. `spread_line` is positive when the home side is favoured."""
    z = SPREAD_LOGISTIC_INTERCEPT + SPREAD_LOGISTIC_SLOPE * spread_line
    return 1.0 / (1.0 + math.exp(-z))


def normal_home_share(spread_line: float) -> float:
    """Continuity-corrected normal, renormalised to exclude the tie.

    Reported conditional on no tie so it is compared like for like with the
    logistic, which was fitted on non-tie games.
    """
    win = _PHI((spread_line - 0.5) / NORMAL_SIGMA)
    lose = _PHI((-spread_line - 0.5) / NORMAL_SIGMA)
    total = win + lose
    return win / total if total > 0 else 0.5


def completed(rows: Sequence[dict], lo: int, hi: int) -> List[dict]:
    """Regular-season games with a posted line and a decided result."""
    out = []
    for r in rows:
        if r.get("game_type") != "REG":
            continue
        season = int(r["season"])
        if not lo <= season <= hi:
            continue
        result, spread = _number(r.get("result")), _number(r.get("spread_line"))
        if result is None or spread is None or result == 0:
            continue
        out.append(r)
    return out


# -- metrics ---------------------------------------------------------------

def log_loss(pairs: Sequence[Tuple[float, float]]) -> float:
    total = 0.0
    for p, y in pairs:
        p = min(max(p, 1e-12), 1 - 1e-12)
        total -= y * math.log(p) + (1 - y) * math.log(1 - p)
    return total / len(pairs)


def brier(pairs: Sequence[Tuple[float, float]]) -> float:
    return sum((p - y) ** 2 for p, y in pairs) / len(pairs)


def reliability(pairs: Sequence[Tuple[float, float]], edges: Sequence[float]) -> None:
    print(f"    {'bucket':>12} {'n':>6} {'predicted':>10} {'actual':>8} {'gap':>7}")
    for lo, hi in zip(edges, edges[1:]):
        band = [(p, y) for p, y in pairs if lo <= p < hi]
        if len(band) < 25:
            continue
        pred = sum(p for p, _ in band) / len(band)
        act = sum(y for _, y in band) / len(band)
        flag = "  <-- off" if abs(act - pred) > 0.03 else ""
        print(f"    {lo:.2f}-{hi:.2f} {len(band):6d} {pred*100:9.1f}% {act*100:7.1f}% "
              f"{(act-pred)*100:+6.1f}{flag}")


# -- the reports -----------------------------------------------------------

def report_devig(rows: Sequence[dict]) -> None:
    """How far apart the three methods are, on the prices we actually pick."""
    games = [r for r in completed(rows, 2015, 2024)
             if _number(r.get("home_moneyline")) and _number(r.get("away_moneyline"))]
    print(f"de-vig disagreement on {len(games)} priced games, 2015-2024\n")

    buckets: Dict[str, List[Tuple[float, float, float]]] = {}
    for r in games:
        hr = implied_prob_from_moneyline(_number(r["home_moneyline"]))
        ar = implied_prob_from_moneyline(_number(r["away_moneyline"]))
        if hr is None or ar is None or hr + ar <= 0:
            continue
        shares = {m: devig(hr, ar, m)[0] for m in DEVIG_METHODS}
        fav = max(shares["power"], 1 - shares["power"])
        key = ("50-65%" if fav < 0.65 else "65-75%" if fav < 0.75
               else "75-85%" if fav < 0.85 else "85%+")
        # Report the favourite's share under each method, whichever side it is.
        flip = shares["power"] < 0.5
        buckets.setdefault(key, []).append(tuple(
            (1 - shares[m]) if flip else shares[m] for m in ("multiplicative", "additive", "power")
        ))

    print(f"    {'favourite':>10} {'n':>6} {'mult':>8} {'additive':>9} {'power':>8} "
          f"{'power-mult':>11}")
    for key in ("50-65%", "65-75%", "75-85%", "85%+"):
        vals = buckets.get(key)
        if not vals:
            continue
        m = sum(v[0] for v in vals) / len(vals)
        a = sum(v[1] for v in vals) / len(vals)
        p = sum(v[2] for v in vals) / len(vals)
        print(f"    {key:>10} {len(vals):6d} {m*100:7.2f}% {a*100:8.2f}% {p*100:7.2f}% "
              f"{(p-m)*100:+10.2f}")
    print("\n    Positive means the multiplicative method was reading the favourite low.")
    print("    Survivor picks live in the bottom two rows, so that is the row to read.")


def report_spread(rows: Sequence[dict]) -> None:
    """Fitted logistic against the published normal approximation, out of sample."""
    train = completed(rows, 2015, 2021)
    test = completed(rows, 2022, 2025)
    print(f"spread models, fitted on {len(train)} games 2015-2021, "
          f"scored on {len(test)} games 2022-2025\n")

    models = {
        "fitted logistic (shipped)": logistic_home_share,
        f"normal, sigma={NORMAL_SIGMA}": normal_home_share,
    }
    print(f"    {'model':>28} {'log loss':>10} {'brier':>8}")
    scored = {}
    for name, fn in models.items():
        pairs = [(fn(_number(r["spread_line"])), 1.0 if _number(r["result"]) > 0 else 0.0)
                 for r in test]
        scored[name] = pairs
        print(f"    {name:>28} {log_loss(pairs):10.4f} {brier(pairs):8.4f}")
    coin = [(0.5, y) for _, y in next(iter(scored.values()))]
    print(f"    {'always 50%':>28} {log_loss(coin):10.4f} {brier(coin):8.4f}")
    print("\n    Lower is better on both. The difference between the two real models is\n"
          "    what decides whether the shipped one keeps its place.")


def report_reliability(rows: Sequence[dict]) -> None:
    test = completed(rows, 2015, 2025)
    pairs = []
    for r in test:
        hr = implied_prob_from_moneyline(_number(r.get("home_moneyline")))
        ar = implied_prob_from_moneyline(_number(r.get("away_moneyline")))
        y = 1.0 if _number(r["result"]) > 0 else 0.0
        if hr and ar and hr + ar > 0:
            pairs.append((devig(hr, ar)[0], y))
        else:
            pairs.append((logistic_home_share(_number(r["spread_line"])), y))

    print(f"reliability of the shipped layer, {len(pairs)} games 2015-2025\n")
    print("  full range, by decile:")
    reliability(pairs, [i / 10 for i in range(11)])
    print("\n  0.70-0.95 -- where every survivor pick lives:")
    reliability(pairs, [0.70, 0.75, 0.80, 0.85, 0.90, 0.95])
    print(f"\n    overall log loss {log_loss(pairs):.4f}   brier {brier(pairs):.4f}")


def report_horizon(rows: Sequence[dict]) -> None:
    """How fast a projection rots -- this is what sets the shrinkage tau.

    Proxied by holding a team's rating fixed at week w and scoring its games k
    weeks later. A season-long closing line is not available per-week
    historically, so the proxy is a season-average team strength, which is the
    same shape of claim a projected line makes.
    """
    print("horizon decay: a rating fitted through week w, scored k weeks later\n")
    seasons = range(2015, 2025)
    by_k: Dict[int, List[Tuple[float, float]]] = {}

    for season in seasons:
        games = [r for r in completed(rows, season, season)]
        by_week: Dict[int, List[dict]] = {}
        for r in games:
            by_week.setdefault(int(r["week"]), []).append(r)

        for cutoff in range(4, 14):
            margins: Dict[str, List[float]] = {}
            for w, gs in by_week.items():
                if w > cutoff:
                    continue
                for r in gs:
                    m = _number(r["result"])
                    margins.setdefault(r["home_team"], []).append(m)
                    margins.setdefault(r["away_team"], []).append(-m)
            rating = {t: sum(v) / len(v) for t, v in margins.items() if len(v) >= 3}

            for w, gs in by_week.items():
                k = w - cutoff
                if not 1 <= k <= 8:
                    continue
                for r in gs:
                    h, a = rating.get(r["home_team"]), rating.get(r["away_team"])
                    if h is None or a is None:
                        continue
                    edge = (h - a) / 2.0 + 1.75          # /2 avoids double-counting; HFA ~1.75
                    p = logistic_home_share(edge)
                    by_k.setdefault(k, []).append((p, 1.0 if _number(r["result"]) > 0 else 0.0))

    print(f"    {'weeks out':>10} {'n':>7} {'log loss':>10} {'vs 1 week':>11}")
    base = None
    for k in sorted(by_k):
        ll = log_loss(by_k[k])
        if base is None:
            base = ll
        print(f"    {k:10d} {len(by_k[k]):7d} {ll:10.4f} {ll - base:+10.4f}")
    print("\n    A rising column is the estimate rotting. Fit tau so that exp(-k/tau)\n"
          "    tracks the decay in usable signal rather than picking a round number.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("report", nargs="?", default="all",
                        choices=["devig", "spread", "reliability", "horizon", "all"])
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()

    rows = load_rows(refresh=args.refresh)
    reports = {
        "devig": report_devig, "spread": report_spread,
        "reliability": report_reliability, "horizon": report_horizon,
    }
    chosen = reports if args.report == "all" else {args.report: reports[args.report]}
    for i, (name, fn) in enumerate(chosen.items()):
        if i:
            print("\n" + "=" * 72 + "\n")
        fn(rows)


if __name__ == "__main__":
    main()
