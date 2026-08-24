// Bye week schedule, keyed by NFL team abbreviation (matches Sleeper's `team` field).
// Update this table once a year when the new NFL schedule is released.
const BYE_WEEKS = {
  season: 2026,
  weeks: {
    CAR: 5, KC: 5,
    CIN: 6, DET: 6, MIA: 6, MIN: 6,
    BUF: 7, JAX: 7, LAC: 7, WAS: 7,
    HOU: 8, NO: 8, NYG: 8, SF: 8,
    PIT: 9, TEN: 9,
    CHI: 10, DEN: 10, PHI: 10, TB: 10,
    ATL: 11, CLE: 11, GB: 11, LAR: 11, NE: 11, SEA: 11,
    BAL: 13, IND: 13, LV: 13, NYJ: 13,
    ARI: 14, DAL: 14,
  },
};

// ESPN uses a couple of different abbreviations than Sleeper for the same team.
const TEAM_ALIASES = {
  WSH: 'WAS',
  JAC: 'JAX',
  LA: 'LAR',
};

function normalizeTeam(abbr) {
  if (!abbr) return abbr;
  const up = abbr.toUpperCase();
  return TEAM_ALIASES[up] || up;
}

function getByeWeek(teamAbbr) {
  const team = normalizeTeam(teamAbbr);
  return BYE_WEEKS.weeks[team] || null;
}
