"""Measure the probability layer instead of trusting it.

Everything the engine decides is a function of the win-probability matrix, and
errors there compound multiplicatively across eighteen sequential picks. So
this answers, on real outcomes, the three questions the model layer cannot
answer about itself:

    python3 scripts/calibrate.py devig       # how much do the methods disagree?
    python3 scripts/calibrate.py spread      # which spread model is best?
    python3 scripts/calibrate.py reliability # is it calibrated where we live?
    python3 scripts/calibrate.py horizon     # how fast does an estimate rot?
    python3 scripts/calibrate.py team-bias   # where has the market been wrong before?
    python3 scripts/calibrate.py all

`team-bias` is the odd one out: it *fits* the table shipped in
models/team_bias_table.json rather than scoring something already shipped,
and `--write` is what regenerates that file.

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
import json
import math
import sys
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from models.win_prob import (  # noqa: E402
    DEVIG_METHODS,
    SPREAD_LOGISTIC_INTERCEPT,
    SPREAD_LOGISTIC_SLOPE,
    devig,
    implied_prob_from_moneyline,
)
from models.team_bias import (  # noqa: E402
    AWAY,
    DEFAULT_DECAY_PER_SEASON,
    DEFAULT_MAX_ADJUSTMENT_PCT,
    DEFAULT_MIN_GAMES,
    HOME,
    JS_TABLE_PATH,
    TABLE_PATH,
    build_bias_table,
    table_summary,
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


def completed(rows: Sequence[dict], lo: int, hi: int, regular_only: bool = True) -> List[dict]:
    """Games with a posted line and a decided result.

    `regular_only` is the sample boundary and it is not cosmetic: the shipped
    spread constants were fitted over **every** game type, 2015-2025, which is
    3,018 games and reproduces them to four decimals. Regular season alone is
    2,885 and fits to -0.0453 / 0.1466 instead -- close enough to look like a
    rounding difference and not the same model. A report validating a constant
    has to score the sample the constant came from, so report_spread passes
    False and everything else keeps the default.
    """
    out = []
    for r in rows:
        if regular_only and r.get("game_type") != "REG":
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


def fit_logistic(games: Sequence[dict], iterations: int = 200) -> Tuple[float, float]:
    """Newton-Raphson for P(home wins) = logistic(b0 + b1 * spread_line).

    The same method that produced SPREAD_LOGISTIC_INTERCEPT and _SLOPE. It is
    here so a held-out score can be an actually held-out score: the shipped
    constants were fitted over 2015-2025, so scoring *them* on 2022-2025 reads
    the model its own training data back.
    """
    b0, b1 = 0.0, 0.1
    for _ in range(iterations):
        g0 = g1 = h00 = h01 = h11 = 0.0
        for row in games:
            x = _number(row["spread_line"])
            y = 1.0 if _number(row["result"]) > 0 else 0.0
            p = 1.0 / (1.0 + math.exp(-(b0 + b1 * x)))
            g0 += y - p
            g1 += (y - p) * x
            w = p * (1.0 - p)
            h00 += w
            h01 += w * x
            h11 += w * x * x
        det = h00 * h11 - h01 * h01
        if det == 0.0:
            break
        d0 = (h11 * g0 - h01 * g1) / det
        d1 = (-h01 * g0 + h00 * g1) / det
        b0 += d0
        b1 += d1
        if abs(d0) < 1e-12 and abs(d1) < 1e-12:
            break
    return b0, b1


def report_spread(rows: Sequence[dict]) -> None:
    """Fitted logistic against the published normal approximation, out of sample.

    ── Held out, which it was not ──────────────────────────────────────────

    This printed "fitted on 2015-2021, scored on 2022-2025" over a table that
    scored the **shipped** constants -- and those were fitted over 2015-2025,
    so the test years were inside the training window. `train` was computed and
    used for nothing but its own length in that header. The number it printed
    was close enough to the honest one that nobody would look twice, which is
    exactly why it lasted.

    So the training window is now actually fitted, and both rows are labelled
    for what they are: the held-out curve is the one that decides whether the
    shape is right, and the shipped row is in-sample here and is shown for
    comparison rather than as evidence.
    """
    train = completed(rows, 2015, 2021, regular_only=False)
    test = completed(rows, 2022, 2025, regular_only=False)
    b0, b1 = fit_logistic(train)
    held_out = lambda spread: 1.0 / (1.0 + math.exp(-(b0 + b1 * spread)))

    print(f"spread models, fitted on {len(train)} games 2015-2021, "
          f"scored on {len(test)} games 2022-2025\n")
    print(f"    refitted on the training window: intercept {b0:+.4f}  slope {b1:.4f}")
    print(f"    shipped (fitted on 2015-2025):   intercept {SPREAD_LOGISTIC_INTERCEPT:+.4f}  "
          f"slope {SPREAD_LOGISTIC_SLOPE:.4f}\n")

    models = {
        "fitted logistic, held out": held_out,
        "shipped constants (in sample)": logistic_home_share,
        f"normal, sigma={NORMAL_SIGMA}": normal_home_share,
    }
    print(f"    {'model':>30} {'log loss':>10} {'brier':>8}")
    scored = {}
    for name, fn in models.items():
        pairs = [(fn(_number(r["spread_line"])), 1.0 if _number(r["result"]) > 0 else 0.0)
                 for r in test]
        scored[name] = pairs
        print(f"    {name:>30} {log_loss(pairs):10.4f} {brier(pairs):8.4f}")
    old_rule = [(max(0.01, min(0.99, 0.50 + _number(r["spread_line"]) * 0.012)),
                 1.0 if _number(r["result"]) > 0 else 0.0) for r in test]
    print(f"    {'old rule, 50 + spread x 1.2':>30} {log_loss(old_rule):10.4f} {brier(old_rule):8.4f}")
    coin = [(0.5, y) for _, y in next(iter(scored.values()))]
    print(f"    {'always 50%':>30} {log_loss(coin):10.4f} {brier(coin):8.4f}")

    # The calibration claim in models/win_prob.py, printed rather than
    # remembered: a Brier score says the model is good on average and says
    # nothing about where it is wrong.
    print("\n  the held-out curve by decile, which is where it is wrong rather than how much:")
    reliability(scored["fitted logistic, held out"], [i / 10 for i in range(11)])

    print("\n    Lower is better on both. The difference between the two real models is\n"
          "    what decides whether the shipped one keeps its place, and the held-out\n"
          "    row is the one that decides it.")


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


def report_team_bias(rows: Sequence[dict], write: bool = False, seasons: int = 10) -> None:
    """Fit the per-team, per-venue market residual and optionally ship it.

    This is a *fitting* report rather than a validating one, which makes it the
    odd one out in this file and worth saying so. The other three score a
    constant that is already shipped against outcomes it did not see. This one
    produces the numbers -- so the honest thing it can report is not "the
    correction is worth x", which it cannot know, but how much of what it found
    survives the scepticism in models/team_bias.py, and whether the residuals
    look like a signal or like noise around zero.

    The out-of-sample question -- does correcting by these numbers pick better
    teams -- is not answered here and is not answered anywhere yet. It belongs
    to a paired replay of real seasons in scripts/backtest.py, which does not
    carry this option today; models/team_bias.py says what wiring it would
    take and why the --synthetic path is the wrong place for it.
    """
    hi = max(int(r["season"]) for r in rows if _number(r.get("season")) is not None)
    lo = hi - seasons + 1
    sample = [
        r for r in rows
        if r.get("game_type") == "REG"
        and _number(r.get("season")) is not None
        and lo <= int(r["season"]) <= hi
        and _number(r.get("home_score")) is not None
    ]

    table, cells, tau2 = build_bias_table(sample)
    entries = table_summary(table)

    print(f"per-team market residual, {len(sample)} regular season games {lo}-{hi}")
    print(f"  decay {DEFAULT_DECAY_PER_SEASON} / season   "
          f"min {DEFAULT_MIN_GAMES} games/cell   clamp +/-{DEFAULT_MAX_ADJUSTMENT_PCT} pts\n")

    # -- the variance decomposition, which is the actual finding -------------
    #
    # Printed before the table and not after it, because it is what decides
    # whether the table below means anything. Read in this order the numbers
    # tell you: here is how much the teams appear to differ, here is how much
    # they would appear to differ if the market were perfect, and the gap
    # between those two is all there is to attribute.
    n = len(cells)
    if n >= 2:
        mean = sum(c.residual for c in cells) / n
        observed = sum((c.residual - mean) ** 2 for c in cells) / (n - 1)
        sampling = sum(c.variance for c in cells) / n
        median_games = sorted(c.games for c in cells)[n // 2]

        print(f"  {n} team/venue cells, median {median_games} games each\n")
        print(f"    spread of observed cell residuals    sd {math.sqrt(observed)*100:5.2f} pts")
        print(f"    spread expected from sampling alone  sd {math.sqrt(sampling)*100:5.2f} pts")
        print(f"    implied true between-team spread     sd {math.sqrt(tau2)*100:5.2f} pts")

        typical = sorted(c.variance for c in cells)[n // 2]
        keep = tau2 / (tau2 + typical) if (tau2 + typical) > 0 else 0.0
        print(f"\n    empirical-Bayes shrink factor        {keep:.3f}"
              f"   (a cell keeps {keep*100:.1f}% of what it shows)")

        # What the ported implementation would have kept instead, so the
        # departure from it is a number on the page rather than a claim in a
        # docstring. `n / (n + 15)` at the median cell size.
        ported = median_games / (median_games + 15.0)
        ratio = f"   <-- {ported / keep:.0f}x more, on this sample" if keep > 0 else ""
        print(f"    a hardcoded n/(n+15) would keep       {ported:.3f}{ratio}")

    if entries:
        mean_abs = sum(abs(e[2]) for e in entries) / len(entries)
        clamped = [e for e in entries if abs(abs(e[2]) - DEFAULT_MAX_ADJUSTMENT_PCT) < 1e-9]
        print(f"\n  mean |adjustment| {mean_abs:.3f} pts   "
              f"largest {entries[0][2]:+.3f} ({entries[0][0]} {entries[0][1]})   "
              f"{len(clamped)} at the clamp\n")
        print("  ten largest:")
        for team, venue, points in entries[:10]:
            print(f"    {team:>4} {venue:<5} {points:+.3f}")

    if write:
        payload = {
            "_comment": (
                "Generated by `python3 scripts/calibrate.py team-bias --write`. "
                "Do not hand-edit -- regenerate. See models/team_bias.py for what "
                "these are, why the shrinkage is estimated rather than chosen, and "
                "why the correction is off by default."
            ),
            "seasons": [lo, hi],
            "games": len(sample),
            "cells": len(cells),
            "decay_per_season": DEFAULT_DECAY_PER_SEASON,
            "min_games": DEFAULT_MIN_GAMES,
            "max_adjustment_pct": DEFAULT_MAX_ADJUSTMENT_PCT,
            "between_team_sd_pct": round(math.sqrt(tau2) * 100.0, 6),
            "teams": {t: {k: round(v, 6) for k, v in sorted(c.items())}
                      for t, c in sorted(table.items())},
        }
        TABLE_PATH.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")
        print(f"\n  wrote {TABLE_PATH.relative_to(ROOT)}")

        # The browser gets the same fit as a JS module rather than fetching the
        # JSON. Two reasons, and neither is preference: JSON import assertions
        # are not portable enough to rely on across the browsers this has to
        # run in, and a fetched table would make an offline Week screen render
        # different numbers from an online one. Written from *this* run, in the
        # same command, so the two files cannot come from different fits --
        # and tests/test_team_bias.py asserts they agree, so a hand-edit to
        # either fails the suite rather than producing a silent JS/Python
        # divergence.
        js_table = ",\n".join(
            f"  {team}: {{ home: {contexts.get(HOME, 0.0):.6f}, away: {contexts.get(AWAY, 0.0):.6f} }}"
            for team, contexts in sorted(table.items())
        )
        JS_TABLE_PATH.write_text(
            "/**\n"
            " * Per-team, per-venue market residuals, in points of win probability.\n"
            " *\n"
            " * GENERATED — do not hand-edit. Regenerate with:\n"
            " *   python3 scripts/calibrate.py team-bias --write\n"
            " *\n"
            " * The twin of models/team_bias_table.json, written by the same command in\n"
            " * the same run. tests/test_team_bias.py asserts the two agree, so editing\n"
            " * one by hand fails the suite instead of quietly making the browser and\n"
            " * the oracle disagree about a team.\n"
            " *\n"
            f" * Fitted on {len(sample)} regular season games, {lo}-{hi}, {len(cells)} cells.\n"
            " * Shrunk by empirical Bayes, which on this sample keeps about 1% of each\n"
            " * raw residual — see models/team_bias.py for why that is the honest\n"
            " * factor and why this correction ships switched off.\n"
            " */\n\n"
            "export const TEAM_BIAS_TABLE = {\n" + js_table + ",\n};\n",
            encoding="utf-8",
        )
        print(f"  wrote {JS_TABLE_PATH.relative_to(ROOT)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("report", nargs="?", default="all",
                        choices=["devig", "spread", "reliability", "horizon", "team-bias", "all"])
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--write", action="store_true",
                        help="team-bias only: rewrite models/team_bias_table.json from this fit")
    args = parser.parse_args()

    rows = load_rows(refresh=args.refresh)
    reports = {
        "devig": report_devig, "spread": report_spread,
        "reliability": report_reliability, "horizon": report_horizon,
        "team-bias": lambda r: report_team_bias(r, write=args.write),
    }
    chosen = reports if args.report == "all" else {args.report: reports[args.report]}
    for i, (name, fn) in enumerate(chosen.items()):
        if i:
            print("\n" + "=" * 72 + "\n")
        fn(rows)


if __name__ == "__main__":
    main()
