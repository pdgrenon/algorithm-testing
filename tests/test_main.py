from unittest.mock import patch

from main import _confirm, cmd_weekly


class TestConfirm:
    def test_yes_variants_confirm(self):
        for answer in ("y", "Y", "yes", "YES", " y "):
            with patch("builtins.input", return_value=answer):
                assert _confirm("prompt: ") is True

    def test_no_or_blank_declines(self):
        for answer in ("n", "no", "", "whatever"):
            with patch("builtins.input", return_value=answer):
                assert _confirm("prompt: ") is False

    def test_eof_declines_without_raising(self):
        with patch("builtins.input", side_effect=EOFError):
            assert _confirm("prompt: ") is False

    def test_keyboard_interrupt_declines_without_raising(self):
        with patch("builtins.input", side_effect=KeyboardInterrupt):
            assert _confirm("prompt: ") is False


class TestCmdWeeklyNoData:
    def test_exits_cleanly_when_no_game_data(self, capsys):
        args = type(
            "Args",
            (),
            {"week": None, "lookahead_weeks": 3, "min_win_prob_floor_b": 65.0, "held_back_limit": 10, "yes": False},
        )()
        with patch("main.build_weekly_report", return_value=None):
            try:
                cmd_weekly(args)
                assert False, "expected SystemExit"
            except SystemExit as exc:
                assert exc.code == 1
        assert "No game data available" in capsys.readouterr().out
