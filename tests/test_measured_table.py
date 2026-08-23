"""The ratings the app publishes have to name a comparison that exists.

`deadpool/src/engine/measured.js` is what the settings screen prints beside
each way of picking -- a multiple of a fair share of the pot, from
`scripts/backtest.py`. The two are joined by nothing but a name, and a name is
exactly what drifts: rename a pair strategy here and the app goes on printing
the old number, which still looks like evidence and is now evidence of
nothing.

Read back rather than trusted, which is the same shape as
`scripts/check-palette.mjs` re-deriving every contrast ratio out of the
comments in the stylesheet. Nothing here runs the backtest; it asserts only
that every comparison the app cites is one this harness can still run.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from scripts.backtest import PAIR_STRATEGIES

MEASURED_JS = Path(__file__).resolve().parents[1] / "deadpool" / "src" / "engine" / "measured.js"

# `distinct: { xFair: 1.61, pair: 'distinct', ... }` -- the app's id and the
# backtest name it was measured under.
ENTRY = re.compile(
    r"^\s*(?P<id>[A-Za-z][\w-]*)\s*:\s*\{(?P<body>[^}]*)\}",
    re.M,
)
PAIR = re.compile(r"pair\s*:\s*'(?P<pair>[^']+)'")
XFAIR = re.compile(r"xFair\s*:\s*(?P<x>[0-9.]+)")


def entries():
    text = MEASURED_JS.read_text()
    # Only the table, not the RUN block above it.
    start = text.index("export const MEASURED")
    return [(m.group("id"), m.group("body")) for m in ENTRY.finditer(text[start:])]


def test_the_table_is_not_empty():
    # A silent empty table would make every assertion below vacuous, which is
    # the failure mode of a checker that only ever iterates.
    assert len(entries()) >= 4, "measured.js has almost nothing in it"


@pytest.mark.parametrize("case", entries(), ids=lambda c: c[0])
def test_every_rating_names_a_comparison_that_still_runs(case):
    app_id, body = case
    pair = PAIR.search(body)
    assert pair, f"{app_id} has a rating with no `pair:` saying how it was measured"
    assert pair.group("pair") in PAIR_STRATEGIES, (
        f"{app_id} cites pair strategy '{pair.group('pair')}', which backtest.py no longer has. "
        f"Available: {sorted(PAIR_STRATEGIES)}"
    )


@pytest.mark.parametrize("case", entries(), ids=lambda c: c[0])
def test_every_rating_is_a_plausible_multiple(case):
    app_id, body = case
    x = XFAIR.search(body)
    assert x, f"{app_id} has no xFair"
    value = float(x.group("x"))
    # Not a tolerance on the measurement -- a bound on what the units can mean.
    # A multiple of a fair share is positive, and anything past 10x on this
    # metric would be a transcription error rather than a strategy.
    assert 0 < value < 10, f"{app_id} is rated {value}x, which is not a multiple of a fair share"
