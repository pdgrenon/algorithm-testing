/**
 * Per-team, per-venue market residuals, in points of win probability.
 *
 * GENERATED — do not hand-edit. Regenerate with:
 *   python3 scripts/calibrate.py team-bias --write
 *
 * The twin of models/team_bias_table.json, written by the same command in
 * the same run. tests/test_team_bias.py asserts the two agree, so editing
 * one by hand fails the suite instead of quietly making the browser and
 * the oracle disagree about a team.
 *
 * Fitted on 2383 regular season games, 2017-2026, 64 cells.
 * Shrunk by empirical Bayes, which on this sample keeps about 1% of each
 * raw residual — see models/team_bias.py for why that is the honest
 * factor and why this correction ships switched off.
 */

export const TEAM_BIAS_TABLE = {
  ARI: { home: -0.137767, away: 0.015118 },
  ATL: { home: -0.061256, away: -0.036820 },
  BAL: { home: -0.072075, away: 0.054817 },
  BUF: { home: 0.108945, away: 0.014781 },
  CAR: { home: 0.007546, away: -0.057888 },
  CHI: { home: 0.013029, away: -0.001960 },
  CIN: { home: -0.064030, away: 0.011871 },
  CLE: { home: 0.018285, away: -0.108992 },
  DAL: { home: 0.024225, away: -0.029785 },
  DEN: { home: 0.033289, away: -0.027038 },
  DET: { home: -0.025064, away: 0.056538 },
  GB: { home: 0.040170, away: 0.002412 },
  HOU: { home: -0.000538, away: 0.061775 },
  IND: { home: -0.005754, away: -0.028920 },
  JAX: { home: -0.006497, away: -0.034725 },
  KC: { home: 0.049140, away: 0.000030 },
  LAC: { home: -0.054725, away: 0.033032 },
  LAR: { home: 0.033082, away: 0.018822 },
  LV: { home: -0.040099, away: -0.046967 },
  MIA: { home: 0.108403, away: -0.054614 },
  MIN: { home: 0.053197, away: 0.086592 },
  NE: { home: -0.078794, away: 0.073718 },
  NO: { home: -0.030664, away: 0.043393 },
  NYG: { home: -0.027706, away: -0.067308 },
  NYJ: { home: -0.052665, away: -0.096360 },
  PHI: { home: 0.024047, away: 0.055424 },
  PIT: { home: 0.089184, away: 0.080285 },
  SEA: { home: -0.025115, away: 0.170166 },
  SF: { home: -0.071981, away: 0.043759 },
  TB: { home: -0.048962, away: 0.011307 },
  TEN: { home: -0.050117, away: 0.004969 },
  WSH: { home: -0.063088, away: 0.047126 },
};
