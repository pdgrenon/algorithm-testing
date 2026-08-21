"""Static reference: the 32 NFL team abbreviations, as ESPN uses them.

This is the full league roster, used to compute each entry's remaining
pick pool (all teams minus the ones already used) -- unlike everything
else in ``data/``, this never changes mid-season, so it isn't fetched.
"""
NFL_TEAMS = [
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
    "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
    "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
    "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WSH",
]
