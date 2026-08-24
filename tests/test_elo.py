"""The second opinion: the blend, the divergence, and staying out of the way.

The property most of this file is about is the boring one -- **off means
bit-identical**. Everything measured in this project was measured with the
blend off, so the day it was wired in it had to move nothing at all, and the
tests that check that are worth more than the ones that check the arithmetic.
"""
from __future__ import annotations

import math

import pytest

from data.models import Game, Odds, Team, WinProbability
from models import elo
from models.market_curve import home_share_from_spread_line, spread_line_from_home_share
from models.win_prob import resolve_team_win_probability


def make_game(home="NYG", away="DAL", season=2026, week=1, spread=-6.5,
              home_ml=-280, away_ml=230, probability=None):
    return Game(
        event_id="1", week=week, season_year=season,
        home=Team(abbreviation=home), away=Team(abbreviation=away),
        odds=Odds(spread=spread, home_moneyline=home_ml, away_moneyline=away_ml),
        probability=probability,
    )


# -- keys and parsing --------------------------------------------------------

def test_game_id_is_away_first_and_the_week_is_padded():
    """Both are easy to get backwards and neither fails loudly."""
    assert elo.nfelo_game_id(2026, 1, "DAL", "NYG") == "2026_01_DAL_NYG"
    assert elo.nfelo_game_id(2026, 12, "DAL", "NYG") == "2026_12_DAL_NYG"


def test_game_id_translates_the_three_relocated_franchises():
    """nfelo keeps one abbreviation per franchise; this app uses ESPN's."""
    assert elo.nfelo_game_id(2026, 1, "LV", "WSH") == "2026_01_OAK_WAS"
    assert elo.nfelo_game_id(2026, 1, "LAR", "KC") == "2026_01_LAR_KC"


def test_game_id_is_none_when_it_cannot_be_built():
    assert elo.nfelo_game_id(None, 1, "DAL", "NYG") is None
    assert elo.nfelo_game_id(2026, None, "DAL", "NYG") is None
    assert elo.nfelo_game_id(2026, 1, None, "NYG") is None


def test_parse_skips_rows_it_cannot_use_rather_than_defaulting_them():
    """A game absent from the table falls back to the market, which is right."""
    rows = [
        {"game_id": "2026_01_DAL_NYG", "nfelo_home_probability_close": "0.62"},
        {"game_id": "not-an-id", "nfelo_home_probability_close": "0.5"},
        {"game_id": "2026_01_KC_DEN", "nfelo_home_probability_close": ""},
        {"game_id": "2026_01_SF_SEA", "nfelo_home_probability_close": "NA"},
        {"game_id": "2026_01_GB_CHI", "nfelo_home_probability_close": "1.4"},
        {"game_id": "2026_01_TB_ATL", "nfelo_home_probability_close": "0"},
    ]
    assert elo.parse_nfelo_rows(rows) == {"2026_01_DAL_NYG": 0.62}


def test_home_win_share_misses_quietly():
    table = {"2026_01_DAL_NYG": 0.62}
    assert elo.home_win_share(table, 2026, 1, "DAL", "NYG") == 0.62
    assert elo.home_win_share(table, 2026, 2, "DAL", "NYG") is None
    assert elo.home_win_share({}, 2026, 1, "DAL", "NYG") is None
    assert elo.home_win_share(None, 2026, 1, "DAL", "NYG") is None


# -- the blend ---------------------------------------------------------------

def test_market_only_returns_the_original_share_untouched():
    """Not merely equal -- the same object's value, un-round-tripped.

    `compare_models` could return the market share by converting it to a
    spread and back, which agrees to about 1e-16. That is not good enough:
    "the blend is off" has to mean exactly the number the market gave, or
    every golden fixture moves the day this is wired in.
    """
    market = 0.8137
    result = elo.compare_models(market, 0.62, market_weight=1.0)
    assert result.blended_home_share == market
    assert result.blended is False


def test_no_elo_rating_leaves_the_market_share_alone_at_any_weight():
    market = 0.8137
    for weight in (0.0, 0.25, 0.5, 1.0):
        result = elo.compare_models(market, None, market_weight=weight)
        assert result.blended_home_share == market
        assert result.elo_spread is None
        assert result.divergence is None
        assert result.blended is False


def test_the_blend_happens_in_spread_points_not_in_probability():
    """The worked example from the module docstring, as a test.

    Market 92%, Elo 84%, half and half: probability space gives 88.0% and
    spread space gives 88.6%. If someone rewrites this as an average of the
    two probabilities, that 0.6 disappears and this fails.
    """
    result = elo.compare_models(0.92, 0.84, market_weight=0.5)
    assert result.blended_home_share == pytest.approx(0.8860, abs=5e-5)
    assert result.blended_home_share > (0.92 + 0.84) / 2, \
        "spread-space blending leans toward the more confident source"


def test_a_zero_market_weight_is_the_elo_model_alone():
    elo_share = 0.62
    result = elo.compare_models(0.92, elo_share, market_weight=0.0)
    assert result.blended_home_share == pytest.approx(elo_share, abs=1e-12)


def test_the_weight_is_clamped_rather_than_rejected():
    """This sits behind a slider; a stored value must not stop a render."""
    assert elo.compare_models(0.8, 0.6, market_weight=5.0).blended_home_share == 0.8
    assert elo.compare_models(0.8, 0.6, market_weight=-2.0).blended_home_share == \
        pytest.approx(0.6, abs=1e-12)


# -- divergence --------------------------------------------------------------

def test_divergence_is_signed_and_says_which_way():
    """"Three points apart" is much less useful than knowing who likes whom."""
    likes_home = elo.compare_models(0.60, 0.75)
    likes_away = elo.compare_models(0.75, 0.60)
    assert likes_home.divergence > 0
    assert likes_away.divergence < 0


def test_divergence_is_reported_even_with_the_blend_switched_off():
    """It is information, not a decision, and costs nothing to compute."""
    result = elo.compare_models(0.75, 0.60, market_weight=1.0)
    assert result.divergence is not None
    assert result.blended_home_share == 0.75


def test_divergence_is_the_gap_between_the_two_implied_lines():
    market, elo_share = 0.75, 0.60
    result = elo.compare_models(market, elo_share)
    assert result.market_spread == pytest.approx(spread_line_from_home_share(market))
    assert result.elo_spread == pytest.approx(spread_line_from_home_share(elo_share))
    assert result.divergence == pytest.approx(result.elo_spread - result.market_spread)


# -- through the real resolver -----------------------------------------------

def test_the_same_game_gives_one_divergence_whichever_side_is_asked_about():
    """Home-relative rather than team-relative, deliberately.

    Otherwise one disagreement reads as +3 evaluating one team and -3
    evaluating the other, and somebody comparing two candidates in the same
    game sees a contradiction.
    """
    game = make_game()
    table = {"2026_01_DAL_NYG": 0.60}
    home = resolve_team_win_probability(game, True, elo_table=table, market_weight=0.5)
    away = resolve_team_win_probability(game, False, elo_table=table, market_weight=0.5)
    assert home.divergence == away.divergence
    assert home.market_spread == away.market_spread


def test_wiring_the_elo_table_in_at_full_market_weight_moves_nothing():
    """The property the whole default rests on."""
    game = make_game()
    table = {"2026_01_DAL_NYG": 0.60}
    for is_home in (True, False):
        before = resolve_team_win_probability(game, is_home)
        after = resolve_team_win_probability(game, is_home, elo_table=table, market_weight=1.0)
        assert after.win_pct == before.win_pct
        # ...and the divergence still comes through, which is the point of
        # computing it independently of the weight.
        assert after.divergence is not None


def test_the_blend_moves_the_two_sides_by_the_same_amount_in_opposite_directions():
    """A game's two rows have to keep summing the way they did before."""
    game = make_game()
    table = {"2026_01_DAL_NYG": 0.60}

    plain = [resolve_team_win_probability(game, h).win_pct for h in (True, False)]
    blended = [
        resolve_team_win_probability(game, h, elo_table=table, market_weight=0.5).win_pct
        for h in (True, False)
    ]
    assert sum(blended) == pytest.approx(sum(plain), abs=1e-9)
    assert blended[0] != plain[0], "the blend should actually have done something"


def test_a_game_nfelo_has_not_rated_is_untouched_while_its_neighbour_blends():
    """The ordinary September case: most of the schedule is not in the file."""
    rated = make_game(home="NYG", away="DAL", week=1)
    unrated = make_game(home="KC", away="DEN", week=1)
    table = {"2026_01_DAL_NYG": 0.60}

    r = resolve_team_win_probability(rated, True, elo_table=table, market_weight=0.5)
    u = resolve_team_win_probability(unrated, True, elo_table=table, market_weight=0.5)
    plain = resolve_team_win_probability(unrated, True)

    assert r.divergence is not None
    assert u.divergence is None
    assert u.win_pct == plain.win_pct


def test_the_espn_probability_rung_is_put_on_the_same_no_tie_scale():
    """ESPN publishes a three-way split; a two-way price does not.

    Comparing the raw home figure against an Elo probability would compare a
    number that includes the tie against one that does not.
    """
    game = make_game(probability=WinProbability(home_win_pct=0.70, away_win_pct=0.28, tie_pct=0.02))
    resolved = resolve_team_win_probability(game, True)
    # 0.70 / (0.70 + 0.28) = 0.7142..., not 0.70
    assert resolved.market_spread == pytest.approx(
        spread_line_from_home_share(0.70 / 0.98), abs=1e-9
    )


def test_a_game_with_no_market_basis_reports_no_spread_rather_than_a_made_up_one():
    game = Game(
        event_id="1", week=1, season_year=2026,
        home=Team(abbreviation="NYG"), away=Team(abbreviation="DAL"),
    )
    resolved = resolve_team_win_probability(game, True)
    assert resolved.win_pct is None
    assert resolved.market_spread is None
    assert resolved.divergence is None


# -- the curve the whole thing hangs on --------------------------------------

def test_the_spread_curve_round_trips():
    for share in (0.5, 0.6, 0.75, 0.9, 0.99):
        assert home_share_from_spread_line(spread_line_from_home_share(share)) == \
            pytest.approx(share, abs=1e-12)


def test_certainty_is_clamped_rather_than_infinite():
    """The logit of 0 or 1 is infinite, and a model that certain has a bug."""
    assert math.isfinite(spread_line_from_home_share(0.0))
    assert math.isfinite(spread_line_from_home_share(1.0))
