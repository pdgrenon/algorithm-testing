"""Reading the pool's pick sheet.

Written against the shape the sheet is expected to arrive in -- one row per
entry, a column per week, exported from Google Sheets -- and deliberately
tolerant of the ways a hand-filled sheet differs from that.
"""
import pytest

from data.pool_sheet import (
    AmbiguousTeam,
    UnknownTeam,
    load_pool_sheet,
    normalize_team,
    used_teams_by_entry,
)

SHEET = """Team Name,Elimination Status,Week 1 Pick,Week 2 Pick,Week 3 Pick
Gridiron Gang,Alive,KC,Bills,San Francisco
Ship of Theseus,Out - Week 3,Chiefs,SF,Jets
Nacho Average Team,Alive,Baltimore Ravens,DET,GB
Fourth and Long,ELIMINATED,Green Bay,BUF,
"""


def write(tmp_path, text=SHEET, name="pool.csv"):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


class TestNames:
    """A wrong name is silent, so this is where the care goes."""

    @pytest.mark.parametrize("raw,expected", [
        ("KC", "KC"), ("Chiefs", "KC"), ("Kansas City", "KC"), ("Kansas City Chiefs", "KC"),
        ("  chiefs  ", "KC"), ("49ers", "SF"), ("Niners", "SF"), ("San Francisco", "SF"),
    ])
    def test_the_same_team_written_several_ways(self, raw, expected):
        assert normalize_team(raw) == expected

    @pytest.mark.parametrize("raw,expected", [
        ("WAS", "WSH"), ("Washington", "WSH"), ("Commanders", "WSH"),
        ("JAC", "JAX"), ("LVR", "LV"), ("Oakland", "LV"),
        ("San Diego", "LAC"), ("St. Louis", "LAR"),
    ])
    def test_the_abbreviations_this_codebase_gets_wrong_elsewhere(self, raw, expected):
        """WSH not WAS, JAX not JAC, LV not LVR, LAR not LA.

        The four the parity suite already guards on the engine side. A sheet
        written by a person will use the other spelling, and it has to land.
        """
        assert normalize_team(raw) == expected

    @pytest.mark.parametrize("raw", ["LA", "Los Angeles", "NY", "New York"])
    def test_a_name_that_means_two_teams_is_refused_not_guessed(self, raw):
        """The whole reason this module has an exception type.

        Resolving "LA" to whichever came first in a dict would put an opponent
        on a team they never picked. That corrupts their inventory, which
        corrupts every popularity forecast built on it, and nothing about the
        output looks wrong.
        """
        with pytest.raises(AmbiguousTeam):
            normalize_team(raw)

    def test_something_that_is_not_a_team_is_refused(self):
        with pytest.raises(UnknownTeam):
            normalize_team("Sharks")

    def test_a_blank_cell_is_a_missing_pick_not_an_error(self):
        assert normalize_team("") is None
        assert normalize_team("   ") is None


class TestReadingTheSheet:
    def test_it_reads_the_expected_shape(self, tmp_path):
        sheet = load_pool_sheet(write(tmp_path))
        assert [e.entry_name for e in sheet.entries] == [
            "Gridiron Gang", "Ship of Theseus", "Nacho Average Team", "Fourth and Long",
        ]
        assert sheet.weeks == [1, 2, 3]

    def test_the_entry_name_column_is_not_an_nfl_team(self, tmp_path):
        """The heading says "Team Name" and means the person's entry.

        Reading it as an NFL team would give a field of 250 franchises that do
        not exist, and every one of them would fail to normalise -- loudly, but
        for entirely the wrong reason.
        """
        sheet = load_pool_sheet(write(tmp_path))
        assert sheet.entries[0].entry_name == "Gridiron Gang"
        assert sheet.entries[0].picks[1] == "KC"

    def test_mixed_name_formats_in_one_column_all_resolve(self, tmp_path):
        sheet = load_pool_sheet(write(tmp_path))
        by_name = {e.entry_name: e for e in sheet.entries}
        assert by_name["Gridiron Gang"].picks == {1: "KC", 2: "BUF", 3: "SF"}
        assert by_name["Nacho Average Team"].picks == {1: "BAL", 2: "DET", 3: "GB"}

    def test_elimination_status_is_read_and_unknown_text_means_out(self, tmp_path):
        """A sheet says "Out - Week 3" in more ways than it says "Alive".

        So anything unrecognised is read as eliminated. That is the safe
        direction: treating an unknown status as alive inflates the field,
        which inflates the denominator you are dividing the pot by.
        """
        sheet = load_pool_sheet(write(tmp_path))
        by_name = {e.entry_name: e for e in sheet.entries}
        assert by_name["Gridiron Gang"].alive is True
        assert by_name["Ship of Theseus"].alive is False
        assert by_name["Fourth and Long"].alive is False
        assert len(sheet.alive) == 2

    @pytest.mark.parametrize(
        "heading", ["Team Name", "Team", "Entry", "Entry Name", "Name", "Player", "Owner"]
    )
    def test_the_entry_column_is_found_by_heading_wherever_it_sits(self, tmp_path, heading):
        """Nobody has seen the real export, so the parser accepts a range.

        Only "Team Name" was ever exercised, and only in the first column --
        where the unlabelled-sheet fallback below would have found it anyway.
        So narrowing the list to one heading passed everything. Put the column
        second and the two come apart: an unrecognised heading falls back to
        column 0 and reads the *status* as the entry's name, which is a pool of
        entries all called "Alive".
        """
        sheet = load_pool_sheet(write(tmp_path, f"""Status,{heading},Week 1 Pick
Alive,Gridiron Gang,KC
""", name=f"pool-{heading.replace(' ', '-')}.csv"))
        assert [e.entry_name for e in sheet.entries] == ["Gridiron Gang"], (
            f"a sheet headed {heading!r} did not find its entry column"
        )
        assert sheet.entries[0].picks == {1: "KC"}
        assert sheet.entries[0].alive is True

    def test_an_unlabelled_first_column_is_still_the_entry(self, tmp_path):
        # The documented fallback: the entry name is whatever is left of the
        # first week column, so a sheet nobody headed properly still reads.
        sheet = load_pool_sheet(write(tmp_path, """Nonsense,Status,Week 1 Pick
Gridiron Gang,Alive,KC
"""))
        assert [e.entry_name for e in sheet.entries] == ["Gridiron Gang"]
        assert sheet.entries[0].picks == {1: "KC"}

    def test_a_blank_status_means_still_in(self, tmp_path):
        """The one exception to "unrecognised means out", and the common case.

        A sheet is filled in when somebody goes out, so the status cell for
        everybody still playing is usually empty. `_ALIVE_WORDS` carries `""`
        for exactly that, and nothing held it: dropping the empty string left
        the whole suite green while reading a live pool as entirely eliminated
        -- which reaches /api/pool as `alive: 0` and is the "the sheet is
        empty" sentence that file exists to avoid.
        """
        sheet = load_pool_sheet(write(tmp_path, """Team Name,Status,Week 1 Pick
Still Playing,,KC
Also Playing,   ,BUF
Gone,Out - Week 1,SF
"""))
        by_name = {e.entry_name: e for e in sheet.entries}
        assert by_name["Still Playing"].alive is True
        assert by_name["Also Playing"].alive is True, "whitespace is a blank cell too"
        assert by_name["Gone"].alive is False
        assert len(sheet.alive) == 2

    def test_a_blank_week_is_simply_absent(self, tmp_path):
        sheet = load_pool_sheet(write(tmp_path))
        by_name = {e.entry_name: e for e in sheet.entries}
        assert 3 not in by_name["Fourth and Long"].picks

    def test_the_inventory_table_is_what_comes_out(self, tmp_path):
        # The thing every downstream calculation actually needs: exactly which
        # teams each opponent can no longer pick.
        inventories = used_teams_by_entry(load_pool_sheet(write(tmp_path)))
        assert inventories["Gridiron Gang"] == {"KC", "BUF", "SF"}
        entry = load_pool_sheet(write(tmp_path)).entries[0]
        assert "KC" not in entry.available()
        assert len(entry.available()) == 29


class TestItSurvivesTheSheetChanging:
    def test_a_column_is_added_each_week(self, tmp_path):
        """Nothing may hardcode eighteen weeks. A four-week sheet in week four
        is a correct sheet, and week five's column appears without warning."""
        four = SHEET.replace("Week 3 Pick", "Week 3 Pick,Week 4 Pick").replace(
            ",San Francisco", ",San Francisco,MIN"
        )
        sheet = load_pool_sheet(write(tmp_path, four))
        assert 4 in sheet.weeks
        assert sheet.entries[0].picks[4] == "MIN"

    @pytest.mark.parametrize("headers", [
        "Entry,Status,Week 1 Pick,Week 2 Pick,Week 3 Pick",
        "Team Name,Elimination Status,Wk 1,Wk 2,Wk 3",
        "Player,Alive,W1,W2,W3",
        "Team Name,Status,1,2,3",
    ])
    def test_headings_it_should_still_recognise(self, tmp_path, headers):
        body = "\n".join(SHEET.splitlines()[1:])
        sheet = load_pool_sheet(write(tmp_path, headers + "\n" + body))
        assert sheet.weeks == [1, 2, 3]
        assert len(sheet.entries) == 4

    def test_one_bad_cell_does_not_cost_the_other_rows(self, tmp_path):
        broken = SHEET.replace("Nacho Average Team,Alive,Baltimore Ravens",
                               "Nacho Average Team,Alive,Sharks")
        sheet = load_pool_sheet(write(tmp_path, broken))
        assert len(sheet.entries) == 4, "one typo in row 180 must not lose the other 249"
        assert any("Sharks" in p for p in sheet.problems)

    def test_strict_mode_raises_for_a_test_to_catch(self, tmp_path):
        broken = SHEET.replace("Baltimore Ravens", "Sharks")
        with pytest.raises(UnknownTeam):
            load_pool_sheet(write(tmp_path, broken), strict=True)


class TestItSaysWhenTheSheetContradictsItself:
    def test_a_team_spent_twice_is_reported(self, tmp_path):
        # Readable, but cannot be true. Worth surfacing because the engine is
        # about to treat this as ground truth about 250 people.
        doubled = SHEET.replace("Gridiron Gang,Alive,KC,Bills,San Francisco",
                                "Gridiron Gang,Alive,KC,Bills,Chiefs")
        sheet = load_pool_sheet(write(tmp_path, doubled))
        assert any("only be spent once" in p for p in sheet.problems)

    def test_an_empty_sheet_says_so_rather_than_returning_nothing(self, tmp_path):
        sheet = load_pool_sheet(write(tmp_path, "", "empty.csv"))
        assert sheet.problems and not sheet.entries

    def test_a_sheet_with_no_week_columns_says_so(self, tmp_path):
        sheet = load_pool_sheet(write(tmp_path, "Team Name,Status\nA,Alive\n"))
        assert any("no week columns" in p for p in sheet.problems)


class TestObservedPopularity:
    def test_it_reports_what_the_field_actually_did(self, tmp_path):
        """The number the popularity model is meant to predict.

        Having it for past weeks is what makes fitting that model against *this*
        pool possible, rather than borrowing a national average from a field
        with different rules and different people.
        """
        sheet = load_pool_sheet(write(tmp_path))
        week1 = sheet.popularity(1)
        assert week1["KC"] == pytest.approx(0.5), "two of four took Kansas City"
        assert week1["BAL"] == pytest.approx(0.25)
        assert week1["GB"] == pytest.approx(0.25)
        assert sum(week1.values()) == pytest.approx(1.0)

    def test_a_week_nobody_has_played_is_empty_rather_than_wrong(self, tmp_path):
        assert load_pool_sheet(write(tmp_path)).popularity(9) == {}
