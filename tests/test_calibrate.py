"""The sample boundary the shipped spread constants were fitted over.

`scripts/calibrate.py` had no tests, and the one flag in it that decides
whether a report validates a constant or merely resembles validating it is
`completed(..., regular_only=...)`. Its docstring is specific: every game type
over 2015-2025 is 3,018 games and reproduces `SPREAD_LOGISTIC_INTERCEPT` and
`_SLOPE` to four decimals, where the regular season alone is 2,885 and fits to
-0.0453 / 0.1466 -- "close enough to look like a rounding difference and not
the same model".

That is a reproducible claim about a number the engine ships, and nothing
checked it: switching the filter off entirely left the whole suite green. These
re-derive it from the file rather than trusting the comment, which is the same
posture as scripts/check-palette.mjs recomputing every contrast ratio out of
the stylesheet.

Skipped rather than failed when the CSV has not been downloaded, matching
tests/test_payout_and_field.py.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from models.win_prob import SPREAD_LOGISTIC_INTERCEPT, SPREAD_LOGISTIC_SLOPE  # noqa: E402
from scripts.backtest import CACHE, load_rows  # noqa: E402
from scripts.calibrate import completed, fit_logistic  # noqa: E402


@pytest.fixture(scope="module")
def rows():
    if not CACHE.exists():
        pytest.skip("nflverse results not cached; run scripts/backtest.py once")
    return load_rows()


class TestTheSampleBoundary:
    def test_every_game_type_is_a_bigger_sample_than_the_regular_season(self, rows):
        every = completed(rows, 2015, 2025, regular_only=False)
        regular = completed(rows, 2015, 2025, regular_only=True)
        assert len(every) > len(regular)
        assert all(r.get("game_type") == "REG" for r in regular)
        assert any(r.get("game_type") != "REG" for r in every), "the postseason is what the flag adds"

    def test_the_default_is_the_narrow_sample(self, rows):
        assert completed(rows, 2015, 2025) == completed(rows, 2015, 2025, regular_only=True)

    def test_the_window_is_inclusive_at_both_ends(self, rows):
        years = {int(r["season"]) for r in completed(rows, 2018, 2020)}
        assert min(years) == 2018 and max(years) == 2020

    def test_a_game_with_no_line_or_no_result_is_not_a_fitted_game(self, rows):
        for r in completed(rows, 2015, 2025, regular_only=False):
            assert r.get("spread_line") not in (None, "", "NA")
            assert r.get("result") not in (None, "", "NA")
            assert float(r["result"]) != 0.0, "a tie decides nothing about a spread"


class TestTheShippedConstantsAreReproducible:
    """The claim `models/win_prob.py` makes about where its numbers came from."""

    def test_fitting_the_whole_sample_reproduces_what_is_shipped(self, rows):
        intercept, slope = fit_logistic(completed(rows, 2015, 2025, regular_only=False))
        assert intercept == pytest.approx(SPREAD_LOGISTIC_INTERCEPT, abs=5e-5)
        assert slope == pytest.approx(SPREAD_LOGISTIC_SLOPE, abs=5e-5)

    def test_the_regular_season_alone_fits_a_different_model(self, rows):
        intercept, slope = fit_logistic(completed(rows, 2015, 2025, regular_only=True))
        assert intercept == pytest.approx(-0.0453, abs=5e-4)
        assert slope == pytest.approx(0.1466, abs=5e-4)
        assert intercept != pytest.approx(SPREAD_LOGISTIC_INTERCEPT, abs=1e-4), (
            "close enough to look like a rounding difference, and not the same model"
        )

    def test_the_slope_is_positive_so_a_bigger_line_is_a_bigger_favourite(self, rows):
        _intercept, slope = fit_logistic(completed(rows, 2015, 2025, regular_only=False))
        assert slope > 0
