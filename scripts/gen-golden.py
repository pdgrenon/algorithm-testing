"""Run the Python strategies over the frozen fixtures and write what they say.

This is the oracle half of the parity contract. The Python at the repository
root is the *definition* of what these algorithms do; this script records that
definition as data, and test/parity.test.js holds the JavaScript port to it.

What that buys, precisely:

  * "the algorithms were not changed in the port" stops being a claim and
    becomes a test. Every pick, every ordering and every sentence of reasoning
    is compared, not just the top answer.
  * a constant edited on one side and not the other goes red, rather than
    quietly producing a different Sunday.
  * and when a strategy *is* meant to change, CI forces the Python, the
    JavaScript and this golden output into the same commit.

Nothing here touches the network. The fixtures are read off disk and fed to
the real parser in data/espn_client.py, so the parsing is under test too.

    python3 scripts/gen-golden.py            # write fixtures/golden/*.json
    python3 scripts/gen-golden.py --check    # fail if they would change
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The Python lives at the repository root — it was moved up out of
# survivor-picker/ on main. This is the only path in the JavaScript half that
# has to know that, which is why it is one line rather than a convention.
sys.path.insert(0, str(ROOT))

from data.espn_client import ESPNClient                     # noqa: E402
from models.win_prob import build_win_probability_table     # noqa: E402
from picker import recommender                              # noqa: E402
from strategy import distinct, entry_a_value, entry_b_hedge, joint_optimizer, leverage, sequence_dp  # noqa: E402

FIXTURES = ROOT / "fixtures/weeks"
GOLDEN = ROOT / "fixtures/golden"
SPEC = json.loads((ROOT / "fixtures/parity-spec.json").read_text())

# Enough of the ranking to prove the ordering without carrying the whole board
# into every golden file. `order` below covers the rest: the full sequence of
# abbreviations, so a sort that is wrong anywhere is still caught.
TOP_N = 3


def weeks_of(name: str) -> dict[int, dict]:
    """A fixture as {week: bundle}, whether it holds a season or a single week."""
    raw = json.loads((FIXTURES / f"{name}.json").read_text())
    if "weeks" in raw:
        return {int(w): b for w, b in raw["weeks"].items()}
    return {int(raw["meta"]["week"]): {k: raw[k] for k in ("scoreboard", "probabilities", "odds")}}


def games_from(bundle: dict, client: ESPNClient) -> list:
    """Parse one bundle with the real client, exactly as a live fetch would."""
    games = client.parse_games(bundle["scoreboard"])
    for game in games:
        games_id = game.event_id
        game.probability = ESPNClient.parse_probability(bundle["probabilities"].get(games_id))
        game.odds = ESPNClient.parse_odds(bundle["odds"].get(games_id))
    return games


# -- serialisation ---------------------------------------------------------
#
# Explicit rather than dataclasses.asdict, and camelCase, so the golden file is
# the shape the JavaScript already produces and the test compares values rather
# than translating between two naming conventions on the way.

def candidate(c) -> dict | None:
    if c is None:
        return None
    return {
        "team": c.team_abbreviation,
        "opponent": c.opponent_abbreviation,
        "winPct": c.win_pct,
        "source": getattr(c, "win_pct_source", None)
                  or ("spread_estimate" if getattr(c, "win_pct_is_estimated", False) else None),
        "spread": c.spread_detail,
        "eventId": getattr(c, "event_id", None),
    }


def ranked_pick(p) -> dict | None:
    if p is None:
        return None
    d = candidate(p)
    # RankedPick is the one candidate dataclass in survivor-picker that carries
    # no event id — a real asymmetry between the four strategies' own types,
    # not something the port introduced. It is dropped from the comparison
    # rather than fabricated on one side, because a field neither engine uses
    # to decide anything is not part of the contract.
    d.pop("eventId", None)
    d.update({
        "futureValue": p.future_value,
        "penalty": p.future_value_penalty,
        "score": p.score,
    })
    return d


def order_of(items) -> list[str]:
    return [i.team_abbreviation for i in items]


# -- the runs --------------------------------------------------------------

def run_one(spec: dict, client: ESPNClient) -> dict:
    by_week = weeks_of(spec["fixture"])
    week = spec["week"]
    games = games_from(by_week[week], client)

    if spec["scheduleWeeks"] == "all":
        schedule_games = [g for w in sorted(by_week) for g in games_from(by_week[w], client)]
    else:
        schedule_games = games
    table = build_win_probability_table(schedule_games)

    used_a, used_b = spec["usedA"], spec["usedB"]
    out: dict = {"runId": spec["id"]}

    # 1. ranked — the only strategy main.py can actually reach.
    recs = recommender.recommend_for_entries(games, {"A": used_a, "B": used_b}, top_n=32)
    out["ranked"] = {
        "A": {"order": order_of(recs["A"]), "top": [candidate(c) for c in recs["A"][:TOP_N]]},
        "B": {"order": order_of(recs["B"]), "top": [candidate(c) for c in recs["B"][:TOP_N]]},
        "conflict": recommender.find_conflicts({k: v[:1] for k, v in recs.items()}),
    }

    # 2. value — win probability discounted by what the team is worth later.
    out["value"] = {}
    for entry, used in (("A", used_a), ("B", used_b)):
        r = entry_a_value.recommend(games, table, week, used_teams=used)
        ranked = ([r.pick] + r.alternatives) if r.pick else []
        out["value"][entry] = {
            "week": r.week,
            "pick": ranked_pick(r.pick),
            "reasoning": r.reasoning,
            "order": order_of(ranked),
            "top": [ranked_pick(p) for p in ranked[:TOP_N]],
        }

    # 3. hedge — Entry B against whatever Entry A just decided.
    a_pick = entry_a_value.recommend(games, table, week, used_teams=used_a).pick
    a_team = a_pick.team_abbreviation if a_pick else None
    h = entry_b_hedge.recommend(games, week, used_teams=used_b, entry_a_pick_team=a_team)
    h_ranked = ([h.pick] + h.alternatives) if h.pick else []
    out["hedge"] = {
        "entryAPick": a_team,
        "week": h.week,
        "pick": candidate(h.pick),
        "reasoning": h.reasoning,
        "floorRelaxed": h.floor_relaxed,
        "order": order_of(h_ranked),
        "top": [candidate(c) for c in h_ranked[:TOP_N]],
    }

    # 4. sequence — the multi-week plan, of which only step one is acted on.
    out["sequence"] = {}
    for entry, used in (("A", used_a), ("B", used_b)):
        r = sequence_dp.recommend(games, table, week, used_teams=used)
        out["sequence"][entry] = {
            "week": r.week,
            "pick": candidate(r.pick),
            "reasoning": r.reasoning,
            "survivalPct": r.survival_pct,
            # The plan itself, not just its first step. A port that agreed on
            # the pick and disagreed on the path would be a different algorithm
            # producing the same answer this week and a different one next.
            "path": [
                {"week": p.week, "team": p.team_abbreviation, "winPct": p.win_pct}
                for p in r.path
            ],
            "universe": r.candidate_universe,
        }

    # 5. joint — both entries chosen together.
    j = joint_optimizer.recommend(games, week, used_teams_a=used_a, used_teams_b=used_b)
    out["joint"] = {
        "week": j.week,
        "pickA": candidate(j.pick_a),
        "pickB": candidate(j.pick_b),
        "bothSurvivePct": j.both_survive_pct,
        "oneSurvivesPct": j.one_survives_pct,
        "bothEliminatedPct": j.both_eliminated_pct,
        "reasoning": j.reasoning,
        "floorRelaxed": j.floor_relaxed,
        "pairsConsidered": j.pairs_considered,
    }
    # 6. distinct — the same strategy for both entries, minus a collision.
    #    The picks alone are not enough: `collided` is the whole difference
    #    between this and running `sequence` twice, and a port that agreed on
    #    the teams while disagreeing on whether the rule bound would be a
    #    different strategy wearing the same answer.
    d = distinct.recommend(
        games, table, week,
        used_teams_by_entry={distinct.ENTRY_A_NAME: used_a, distinct.ENTRY_B_NAME: used_b},
    )
    out["distinct"] = {
        "week": d.week,
        "picks": {e: candidate(p) for e, p in d.picks.items()},
        "reasoning": d.reasoning,
        "collided": d.collided,
    }

    # 7. leverage -- `distinct` plus the field, when there is a field.
    #    The forecast itself is recorded, not just the picks: it is the whole
    #    new input, it is where the two implementations are most likely to
    #    drift (a logit, an exponent and a division, three times over), and a
    #    port that agreed on the pick while disagreeing on the forecast would
    #    be agreeing by luck on this week's board.
    #
    #    Runs with no `field` block are the other half of the test: there the
    #    picks must equal `distinct`'s exactly, which is the promise the
    #    strategy is shipped on.
    inventories = (spec.get("field") or {}).get("inventories") or {}
    lev = leverage.recommend(
        games, table, week,
        used_teams_by_entry={leverage.ENTRY_A_NAME: used_a, leverage.ENTRY_B_NAME: used_b},
        field_inventories=inventories,
    )
    out["leverage"] = {
        "week": lev.week,
        "picks": {e: candidate(p) for e, p in lev.picks.items()},
        "reasoning": lev.reasoning,
        "collided": lev.collided,
        "switched": {e: list(v) for e, v in lev.switched.items()},
        # Rounded, because this is a float crossing a language boundary and the
        # suite compares exactly. Twelve places is far past anything a pick
        # could turn on and far short of where the two would differ in the last
        # bit for reasons nobody can act on.
        "forecast": {t: round(v, 12) for t, v in sorted(lev.forecast.items())},
    }
    return out


# Values chosen to sit on rounding boundaries, where Python rounds half to even
# and JavaScript's toFixed rounds half away from zero. Written out here for the
# same reason as everything else in this file: Python defines the answer, and
# the JavaScript is held to it rather than to somebody's recollection of how
# Python rounds.
FMT_CASES = {
    "f1": [78.25, 78.35, 86.25, 0.5, 1.5, 2.5, -0.04, 99.99, 0.0, 12.345, 33.333, 100.0, 0.05, 0.15, 0.25],
    "f3": [0.6666, 1.9995, 0.0005, 1.0005, 2.0025, 0.44370531249999995],
    "f0": [65.0, 0.5, 1.5, 2.5, 3.5, 64.5, 99.5],
    "pct0": [0.345, 0.35, 0.125, 0.175, 0.005, 0.015, 0.35000000000000003],
}


def nfl_teams() -> str:
    """The league roster, so the JavaScript copy of it can be held to this one.

    data/teams.py and deadpool/src/data/teams.js are one fact written down
    twice — unavoidably, since the browser cannot import Python. A divergence
    would be silent in the worst way: an abbreviation that is right in one file
    and wrong in the other produces a board cell that never lights up and a
    team that can be picked twice, with nothing throwing.
    """
    from data.teams import NFL_TEAMS
    return json.dumps({
        "note": "Generated by scripts/gen-golden.py from data/teams.py. deadpool/src/data/teams.js is held to this.",
        "nflTeams": NFL_TEAMS,
    }, indent=2) + "\n"


def fmt_cases() -> str:
    spec = {
        "note": "Generated by scripts/gen-golden.py. Python is the oracle for number formatting too — see deadpool/src/engine/fmt.js.",
        "f1": {repr(v): f"{v:.1f}" for v in FMT_CASES["f1"]},
        "f3": {repr(v): f"{v:.3f}" for v in FMT_CASES["f3"]},
        "f0": {repr(v): f"{v:.0f}" for v in FMT_CASES["f0"]},
        "pct0": {repr(v): f"{v:.0%}" for v in FMT_CASES["pct0"]},
    }
    return json.dumps(spec, indent=2) + "\n"


def main() -> None:
    check = "--check" in sys.argv
    GOLDEN.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        # A real client, pointed at a throwaway cache. Nothing fetches: only
        # the parsing methods are called, and they are pure.
        client = ESPNClient(cache_dir=tmp)
        stale = []
        for spec in SPEC["runs"]:
            body = json.dumps(run_one(spec, client), indent=2, sort_keys=True) + "\n"
            path = GOLDEN / f"{spec['id']}.json"
            if check:
                if not path.exists() or path.read_text() != body:
                    stale.append(spec["id"])
            else:
                path.write_text(body)
                print(f"  {spec['id']}.json")

    for name, produce in (("test/fmt-cases.json", fmt_cases), ("test/nfl-teams.json", nfl_teams)):
        path = ROOT / name
        body = produce()
        if check:
            if not path.exists() or path.read_text() != body:
                stale.append(name)
        else:
            path.write_text(body)
            print(f"  {name}")

    if check:
        if stale:
            print(f"gen-golden --check: {len(stale)} golden file(s) out of date: {', '.join(stale)}")
            print("The Python changed without the golden output being regenerated. Run: npm run golden")
            sys.exit(1)
        print(f"gen-golden --check: ok — {len(SPEC['runs'])} runs match")
    else:
        print(f"\n  {len(SPEC['runs'])} runs → fixtures/golden/")


if __name__ == "__main__":
    main()
