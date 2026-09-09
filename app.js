// Sleeper Lineup Watch — client-side only. Everything below runs in the browser.

const APP_VERSION = '3';

const SLEEPER_BASE = 'https://api.sleeper.app/v1';
const SLEEPER_PROJECTIONS_BASE = 'https://api.sleeper.app/projections/nfl';
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

const PLAYERS_CACHE_KEY = 'sff_players_cache_v1';
const USERNAME_KEY = 'sff_username';
const PLAYERS_CACHE_MAX_AGE_MS = 20 * 60 * 60 * 1000; // ~20h, Sleeper asks for at most daily refreshes
const PROJECTIONS_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1h — projections/status shift during the week

// Which real positions can fill each roster slot type.
const FLEX_ELIGIBILITY = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['WR', 'RB'],
  WRTE_FLEX: ['WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  RB_FLEX: ['RB'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
  DL: ['DL'], LB: ['LB'], DB: ['DB'], CB: ['DB'], S: ['DB'],
};

const BAD_INJURY_STATUSES = new Set(['Out', 'Doubtful', 'IR', 'PUP', 'Sus', 'NA']);

// Injury designation -> notice severity. Out/IR/PUP/Sus/NA are red (likely
// won't play), Doubtful is orange, Questionable is yellow.
function injurySeverity(status) {
  if (status === 'Questionable') return 'low';
  if (status === 'Doubtful') return 'mid';
  if (BAD_INJURY_STATUSES.has(status)) return 'high';
  return null;
}

// Slot types that give lineup flexibility — a Thursday lock there is worth a
// heads-up since you may have wanted to juggle it before kickoff.
const FLEX_SLOTS = new Set(['FLEX', 'WRRB_FLEX', 'WRTE_FLEX', 'REC_FLEX', 'RB_FLEX', 'SUPER_FLEX', 'IDP_FLEX']);

const els = {
  form: document.getElementById('load-form'),
  input: document.getElementById('username-input'),
  loadBtn: document.getElementById('load-btn'),
  statusLine: document.getElementById('status-line'),
  emptyState: document.getElementById('empty-state'),
  seasonBanner: document.getElementById('season-banner'),
  leaguesContainer: document.getElementById('leagues-container'),
  refreshPlayersBtn: document.getElementById('refresh-players-btn'),
  playersUpdated: document.getElementById('players-updated'),
  updateBanner: document.getElementById('update-banner'),
  updateReloadBtn: document.getElementById('update-reload-btn'),
  tabNav: document.getElementById('tab-nav'),
  leaguesTab: document.getElementById('leagues-tab'),
  viewingTab: document.getElementById('viewing-tab'),
  viewingContainer: document.getElementById('viewing-container'),
};

// ---------- Update check (so the deployed webapp doesn't get stuck stale,
// especially as an iOS "Add to Home Screen" app, which can otherwise launch
// straight from its cached snapshot for a long time without hitting the
// network). We fetch a tiny version.json with cache-busting + no-store, and
// if it doesn't match the version baked into the app.js that's currently
// running, prompt for a refresh. ----------

els.updateReloadBtn.addEventListener('click', () => {
  location.reload();
});

async function checkForUpdate() {
  try {
    const res = await fetch(`version.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.version && data.version !== APP_VERSION) {
      els.updateBanner.hidden = false;
    }
  } catch {
    // offline or blocked — just skip this check, we'll try again later
  }
}

checkForUpdate();
setInterval(checkForUpdate, 10 * 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkForUpdate();
});

// ---------- Tabs ----------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const target = btn.dataset.tab;
    els.leaguesTab.hidden = target !== 'leagues-tab';
    els.viewingTab.hidden = target !== 'viewing-tab';
  });
});

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = els.input.value.trim();
  if (!username) return;
  localStorage.setItem(USERNAME_KEY, username);
  run(username);
});

els.refreshPlayersBtn.addEventListener('click', () => {
  localStorage.removeItem(PLAYERS_CACHE_KEY);
  const username = els.input.value.trim() || localStorage.getItem(USERNAME_KEY);
  if (username) run(username, { forcePlayers: true });
});

// Restore last-used username on load and auto-fetch, so the app doesn't ask
// for the username again on every refresh.
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem(USERNAME_KEY);
  if (saved) {
    els.input.value = saved;
    run(saved);
  }
});

function setStatus(msg, isError) {
  els.statusLine.hidden = !msg;
  els.statusLine.textContent = msg || '';
  els.statusLine.classList.toggle('error', !!isError);
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return res.json();
}

async function run(username, opts = {}) {
  els.loadBtn.disabled = true;
  els.emptyState.hidden = true;
  setStatus('Looking up your Sleeper account…');

  try {
    const state = await fetchJSON(`${SLEEPER_BASE}/state/nfl`);
    const user = await fetchJSON(`${SLEEPER_BASE}/user/${encodeURIComponent(username)}`);
    if (!user || !user.user_id) {
      throw new Error(`No Sleeper user found for "${username}". Check the spelling — it's your Sleeper username, not display name.`);
    }

    setStatus('Fetching your leagues…');
    const leagues = await fetchJSON(`${SLEEPER_BASE}/user/${user.user_id}/leagues/nfl/${state.season}`);

    if (!leagues || leagues.length === 0) {
      els.leaguesContainer.innerHTML = '';
      els.seasonBanner.hidden = true;
      setStatus(`No leagues found for "${username}" in the ${state.season} season.`, true);
      return;
    }

    setStatus(`Loading ${leagues.length} league${leagues.length === 1 ? '' : 's'}…`);

    const isRegularSeason = state.season_type === 'regular' || state.season_type === 'post';
    const week = state.week || state.leg;

    const leagueData = await Promise.all(leagues.map(async (league) => {
      const [detail, rosters, users, matchups] = await Promise.all([
        fetchJSON(`${SLEEPER_BASE}/league/${league.league_id}`),
        fetchJSON(`${SLEEPER_BASE}/league/${league.league_id}/rosters`),
        fetchJSON(`${SLEEPER_BASE}/league/${league.league_id}/users`),
        isRegularSeason ? getWeekMatchups(league.league_id, week).catch(() => null) : Promise.resolve(null),
      ]);
      const myRoster = (rosters || []).find(
        (r) => r.owner_id === user.user_id || (r.co_owners || []).includes(user.user_id)
      );
      const matchup = matchups ? findMatchupSummary(matchups, myRoster, rosters, users) : null;
      return { league: detail, rosters, users, myRoster, matchup };
    }));

    // Collect every player id we'll need to display, across all leagues.
    const neededIds = new Set();
    for (const { myRoster } of leagueData) {
      if (!myRoster) continue;
      for (const id of myRoster.players || []) neededIds.add(id);
    }

    setStatus('Loading player database (cached ~daily)…');
    const playersById = await getPlayersById(neededIds, opts.forcePlayers);

    let schedule = null;
    if (isRegularSeason) {
      setStatus('Checking this week\'s game schedule…');
      schedule = await getWeekSchedule(state.season, week).catch(() => null);
    }

    let projectionsById = null;
    if (isRegularSeason) {
      setStatus('Loading projections…');
      projectionsById = await getProjectionsById(state.season, week).catch(() => null);
    }

    renderSeasonBanner(state, isRegularSeason);
    renderLeagues(leagueData, playersById, week, isRegularSeason, schedule, projectionsById);
    renderViewing(leagueData, playersById, week, isRegularSeason, schedule, projectionsById);
    els.tabNav.hidden = false;

    setStatus(`Loaded ${leagueData.filter(l => l.myRoster).length} of ${leagueData.length} league${leagueData.length === 1 ? '' : 's'} for ${user.display_name || username}.`);
    updatePlayersFooter();
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Something went wrong.', true);
  } finally {
    els.loadBtn.disabled = false;
  }
}

// ---------- Player database (cached in localStorage, trimmed to needed ids) ----------

async function getPlayersById(neededIds, force) {
  if (!force) {
    const cached = readPlayersCache();
    if (cached && Date.now() - cached.ts < PLAYERS_CACHE_MAX_AGE_MS) {
      const hasAll = [...neededIds].every((id) => id in cached.data);
      if (hasAll) return cached.data;
    }
  }

  const full = await fetchJSON(`${SLEEPER_BASE}/players/nfl`);
  const trimmed = {};
  for (const id of neededIds) {
    const p = full[id];
    if (!p) continue;
    trimmed[id] = {
      full_name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || id,
      position: p.position,
      fantasy_positions: p.fantasy_positions || (p.position ? [p.position] : []),
      team: p.team,
      status: p.status,
      injury_status: p.injury_status || null,
      injury_body_part: p.injury_body_part || null,
    };
  }
  writePlayersCache(trimmed);
  return trimmed;
}

function readPlayersCache() {
  try {
    const raw = localStorage.getItem(PLAYERS_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writePlayersCache(data) {
  try {
    localStorage.setItem(PLAYERS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // localStorage full/unavailable — degrade silently, just re-fetch next time
  }
}

function updatePlayersFooter() {
  const cached = readPlayersCache();
  if (cached) {
    els.refreshPlayersBtn.hidden = false;
    els.playersUpdated.textContent = `Player data cached: ${new Date(cached.ts).toLocaleString()}`;
  }
}

// ---------- Weekly game schedule lookup (ESPN scoreboard, best-effort) ----------
//
// Returns a Map of normalized team abbreviation -> game info, built straight
// from each event's UTC kickoff timestamp. Everything (weekday, date, and
// clock time) is derived by formatting that single UTC instant in the
// America/New_York timezone, so DST (EST vs EDT) and international games
// (London/Munich/São Paulo kickoffs) all convert correctly automatically —
// there's no separate "away timezone" logic to get wrong.
const ET_WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
const ET_DATE_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric' });
const ET_TIME_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

function formatGameMeta(iso) {
  const d = new Date(iso);
  return {
    weekday: ET_WEEKDAY_FMT.format(d), // e.g. "Thu"
    monthDay: ET_DATE_FMT.format(d),   // e.g. "10/2"
    timeText: ET_TIME_FMT.format(d),   // e.g. "8:20 PM EDT" — Intl picks EST/EDT correctly for the date
  };
}

async function getWeekSchedule(season, week) {
  const url = `${ESPN_SCOREBOARD}?week=${week}&seasontype=2&year=${season}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const schedule = new Map();
  const games = [];
  for (const event of data.events || []) {
    const meta = formatGameMeta(event.date);
    const statusType = (event.status && event.status.type) || {};
    const state = statusType.state || 'pre'; // 'pre' | 'in' | 'post'
    for (const comp of event.competitions || []) {
      const competitors = comp.competitors || [];
      const venueObj = comp.venue || {};
      const address = venueObj.address || {};
      const venue = venueObj.fullName
        ? `${venueObj.fullName}${address.city ? `, ${address.city}` : ''}${address.state ? `, ${address.state}` : ''}`
        : null;
      const home = competitors.find((c) => c.homeAway === 'home');
      const away = competitors.find((c) => c.homeAway === 'away');

      for (const c of competitors) {
        const abbr = c.team && c.team.abbreviation;
        if (!abbr) continue;
        const opponent = competitors.find((o) => o !== c);
        schedule.set(normalizeTeam(abbr), {
          ...meta,
          opponent: opponent && opponent.team ? normalizeTeam(opponent.team.abbreviation) : null,
          homeAway: c.homeAway || null,
          venue,
          state,
          eventId: event.id,
        });
      }

      if (home && away) {
        games.push({
          id: event.id,
          ...meta,
          state,
          statusText: statusType.shortDetail || statusType.description || null,
          venue,
          home: {
            abbr: normalizeTeam(home.team && home.team.abbreviation),
            score: home.score != null ? Number(home.score) : null,
          },
          away: {
            abbr: normalizeTeam(away.team && away.team.abbreviation),
            score: away.score != null ? Number(away.score) : null,
          },
          kickoff: event.date,
        });
      }
    }
  }
  games.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  schedule.games = games;
  return schedule;
}

function isThursdayTeam(schedule, team) {
  const g = schedule && schedule.get(normalizeTeam(team));
  return !!g && g.weekday === 'Thu';
}

// ---------- Weekly matchups (who am I playing, what's the score) ----------

async function getWeekMatchups(leagueId, week) {
  return fetchJSON(`${SLEEPER_BASE}/league/${leagueId}/matchups/${week}`);
}

function findMatchupSummary(matchups, myRoster, rosters, users) {
  if (!myRoster) return null;
  const mine = (matchups || []).find((m) => m.roster_id === myRoster.roster_id);
  if (!mine || mine.matchup_id == null) return null;
  const opp = (matchups || []).find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== myRoster.roster_id);
  const oppRoster = opp ? (rosters || []).find((r) => r.roster_id === opp.roster_id) : null;
  const oppUser = oppRoster ? (users || []).find((u) => u.user_id === oppRoster.owner_id) : null;
  const oppTeamName = oppRoster
    ? (oppRoster.metadata && oppRoster.metadata.team_name) || (oppUser && (oppUser.metadata && oppUser.metadata.team_name)) || (oppUser && oppUser.display_name) || 'Opponent'
    : null;
  return {
    myPoints: mine.points || 0,
    oppPoints: opp ? (opp.points || 0) : null,
    oppTeamName,
  };
}

// ---------- Player projections (best-effort, unofficial Sleeper endpoint) ----------

function projectionsCacheKey(season, week) {
  return `sff_projections_cache_${season}_${week}`;
}

async function getProjectionsById(season, week) {
  const cacheKey = projectionsCacheKey(season, week);
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const cached = JSON.parse(raw);
      if (Date.now() - cached.ts < PROJECTIONS_CACHE_MAX_AGE_MS) return cached.data;
    }
  } catch {
    // ignore cache read errors, fall through to network
  }

  const url = `${SLEEPER_PROJECTIONS_BASE}/${season}/${week}?season_type=regular`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Projections request failed (${res.status})`);
  const list = await res.json();
  const byId = {};
  for (const entry of list || []) {
    if (!entry || !entry.player_id) continue;
    byId[entry.player_id] = entry.stats || {};
  }
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: byId }));
  } catch {
    // localStorage full/unavailable — degrade silently
  }
  return byId;
}

// Sleeper's scoring_settings keys are the same stat-category keys used in the
// stats/projections payloads (e.g. "rec": 1, "pass_td": 4), so a plain dot
// product reproduces the league's own custom scoring.
function computeFantasyPoints(stats, scoringSettings) {
  if (!stats || !scoringSettings) return 0;
  let total = 0;
  for (const key of Object.keys(scoringSettings)) {
    const weight = scoringSettings[key];
    const value = stats[key];
    if (typeof weight === 'number' && typeof value === 'number') total += weight * value;
  }
  if (total === 0 && stats.pts_ppr != null) {
    // Fallback for stat categories that didn't line up 1:1 (rare) — pick the
    // closest generic scoring type based on this league's reception value.
    const recWeight = scoringSettings.rec || 0;
    if (recWeight >= 1) return stats.pts_ppr;
    if (recWeight >= 0.5) return stats.pts_half_ppr != null ? stats.pts_half_ppr : stats.pts_ppr;
    return stats.pts_std != null ? stats.pts_std : stats.pts_ppr;
  }
  return total;
}

// ---------- Rendering ----------

function renderSeasonBanner(state, isRegularSeason) {
  els.seasonBanner.hidden = false;
  if (isRegularSeason) {
    els.seasonBanner.textContent = `${state.season} season — Week ${state.week}.`;
  } else {
    els.seasonBanner.textContent = `${state.season} season hasn't kicked off yet (currently: ${state.season_type}). Rosters are shown below; bye/injury/Thursday alerts turn on once Week 1 starts.`;
  }
}

function renderLeagues(leagueData, playersById, week, isRegularSeason, schedule, projectionsById) {
  els.leaguesContainer.innerHTML = '';

  for (const { league, users, myRoster } of leagueData) {
    const card = document.createElement('section');
    card.className = 'league-card';

    if (!myRoster) {
      card.innerHTML = `
        <div class="league-card-header">
          <div class="league-title">
            <h2>${escapeHtml(league.name)}</h2>
            <div class="sub">Couldn't find your roster in this league.</div>
          </div>
        </div>`;
      els.leaguesContainer.appendChild(card);
      continue;
    }

    const owner = users.find((u) => u.user_id === myRoster.owner_id);
    const teamName = (myRoster.metadata && myRoster.metadata.team_name) || (owner && (owner.metadata && owner.metadata.team_name)) || (owner && owner.display_name) || 'My Team';
    const record = myRoster.settings || {};
    const recordText = `${record.wins ?? 0}-${record.losses ?? 0}${record.ties ? `-${record.ties}` : ''}`;

    const alerts = isRegularSeason
      ? analyzeRoster(league, myRoster, playersById, week, schedule, projectionsById)
      : { byeStarters: [], byeBench: [], injuryStarters: [], thursdayFlags: [], subRecommendations: [] };

    card.innerHTML = `
      <div class="league-card-header">
        <img class="league-avatar" src="${league.avatar ? `https://sleepercdn.com/avatars/thumbs/${league.avatar}` : ''}" onerror="this.style.visibility='hidden'" alt="" />
        <div class="league-title">
          <h2>${escapeHtml(league.name)}</h2>
          <div class="sub">${escapeHtml(teamName)}</div>
        </div>
        <div class="record-pill">${recordText}</div>
      </div>
    `;

    card.appendChild(renderAlerts(alerts));
    card.appendChild(renderRosterList(league, myRoster, playersById, week, schedule));
    els.leaguesContainer.appendChild(card);
  }
}

function renderAlerts(alerts) {
  const wrap = document.createElement('div');
  const totalAlerts = alerts.byeStarters.length + alerts.injuryStarters.length + alerts.thursdayFlags.length;

  if (totalAlerts === 0) {
    wrap.className = 'no-alerts';
    wrap.textContent = 'No bye, injury, or Thursday-lock issues in your starting lineup.';
    return wrap;
  }

  wrap.className = 'alerts';

  for (const item of alerts.byeStarters) {
    wrap.appendChild(alertRow('sev-high', `${item.player.full_name} (${item.slot}) is on BYE — Week off, 0 points guaranteed.`, findSubs(alerts, item.player)));
  }
  for (const item of alerts.injuryStarters) {
    const sevClass = item.severity === 'high' ? 'sev-high' : item.severity === 'mid' ? 'sev-mid' : 'sev-low';
    wrap.appendChild(alertRow(sevClass, `${item.player.full_name} (${item.slot}) is ${item.player.injury_status}${item.player.injury_body_part ? ` — ${item.player.injury_body_part}` : ''}.`, item.severity === 'high' ? findSubs(alerts, item.player) : null));
  }
  for (const item of alerts.thursdayFlags) {
    const where = item.isBench ? 'on your bench' : `starting at ${item.slot}`;
    const when = item.game ? ` (${item.game.monthDay}, ${item.game.timeText})` : '';
    wrap.appendChild(alertRow('sev-grey', `${item.player.full_name} plays Thursday Night${when} — ${where}. Set your final lineup before kickoff, that slot locks early.`, null));
  }

  return wrap;
}

function findSubs(alerts, player) {
  const rec = alerts.subRecommendations.find((r) => r.outPlayer === player);
  return rec ? rec.candidates : null;
}

function alertRow(sevClass, text, candidates) {
  const row = document.createElement('div');
  row.className = `alert ${sevClass}`;
  const candHtml = candidates
    ? (candidates.length
        ? `<div class="sub-list">Bench options: ${candidates.map((c) => `<span class="cand">${escapeHtml(c.full_name)} (${c.position}${c.team ? ' · ' + c.team : ''})</span>`).join('')}</div>`
        : `<div class="sub-list">No eligible healthy bench replacement for this slot.</div>`)
    : '';
  row.innerHTML = `<div>${text}</div>${candHtml}`;
  return row;
}

function renderRosterList(league, roster, playersById, week, schedule) {
  const wrap = document.createElement('div');
  wrap.className = 'roster-section';

  const startingSlotTypes = (league.roster_positions || []).filter((p) => p !== 'BN');
  const starters = roster.starters || [];
  const reserve = new Set(roster.reserve || []);
  const taxi = new Set(roster.taxi || []);
  const benchIds = (roster.players || []).filter((id) => !starters.includes(id) && !reserve.has(id) && !taxi.has(id));

  wrap.appendChild(sectionHeading('Starters'));
  for (let i = 0; i < startingSlotTypes.length; i++) {
    const pid = starters[i];
    wrap.appendChild(playerRow(startingSlotTypes[i], pid ? playersById[pid] : null, week, schedule));
  }

  if (benchIds.length) {
    wrap.appendChild(sectionHeading('Bench'));
    for (const pid of benchIds) {
      wrap.appendChild(playerRow('BN', playersById[pid], week, schedule));
    }
  }

  if (roster.reserve && roster.reserve.length) {
    wrap.appendChild(sectionHeading('IR'));
    for (const pid of roster.reserve) {
      wrap.appendChild(playerRow('IR', playersById[pid], week, schedule));
    }
  }

  return wrap;
}

function sectionHeading(text) {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
}

function playerRow(slot, player, week, schedule) {
  const row = document.createElement('div');
  row.className = 'player-row';

  if (!player) {
    row.innerHTML = `<span class="slot-tag">${slot}</span><span class="player-name player-meta">Empty</span>`;
    return row;
  }

  const bye = getByeWeek(player.team);
  const onBye = !!(bye && week && bye === week);
  const game = !onBye && schedule ? schedule.get(normalizeTeam(player.team)) : null;
  const nonSunday = game && game.weekday !== 'Sun';

  let gameChip = '';
  if (onBye) {
    gameChip = `<span class="badge bye">BYE</span>`;
  } else if (game) {
    gameChip = `<span class="badge game${nonSunday ? ' grey' : ''}">${escapeHtml(game.weekday)} ${escapeHtml(game.monthDay)} · ${escapeHtml(game.timeText)}</span>`;
  } else if (schedule) {
    // schedule loaded successfully but this team has no game this week (bye
    // not in our static table, postponed, etc.) — say so instead of guessing
    gameChip = `<span class="badge unknown">No game found</span>`;
  }

  let statusBadges = '';
  const sev = injurySeverity(player.injury_status);
  if (sev === 'low') statusBadges += `<span class="badge badge-yellow">Q</span>`;
  else if (sev === 'mid') statusBadges += `<span class="badge badge-orange">${escapeHtml(player.injury_status)}</span>`;
  else if (sev === 'high') statusBadges += `<span class="badge badge-red">${escapeHtml(player.injury_status)}</span>`;

  row.innerHTML = `
    <span class="slot-tag">${slot}</span>
    <div class="player-info">
      <div class="player-name-line">${escapeHtml(player.full_name)} <span class="player-meta">${player.position || ''}${player.team ? ' · ' + player.team : ' · FA'}</span></div>
      <div class="player-badges-line">${gameChip}${statusBadges}</div>
    </div>
  `;
  return row;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Analysis ----------

function projectedPoints(pid, league, projectionsById) {
  if (!projectionsById) return null;
  const stats = projectionsById[pid];
  if (!stats) return null;
  return computeFantasyPoints(stats, league.scoring_settings);
}

function analyzeRoster(league, roster, playersById, week, schedule, projectionsById) {
  const startingSlotTypes = (league.roster_positions || []).filter((p) => p !== 'BN');
  const starters = roster.starters || [];
  const reserve = new Set(roster.reserve || []);
  const taxi = new Set(roster.taxi || []);
  const benchIds = (roster.players || []).filter((id) => !starters.includes(id) && !reserve.has(id) && !taxi.has(id));

  const alerts = { byeStarters: [], byeBench: [], injuryStarters: [], thursdayFlags: [], subRecommendations: [] };

  // Track whether any starter has an injury designation or the lowest
  // starter projection, to decide whether a Thursday bench player is worth
  // flagging (see bench loop below).
  let starterHasInjury = false;
  let lowestStarterProjPts = null;

  for (let i = 0; i < startingSlotTypes.length; i++) {
    const slot = startingSlotTypes[i];
    const pid = starters[i];
    if (!pid || pid === '0') continue;
    const p = playersById[pid];
    if (!p) continue;

    const bye = getByeWeek(p.team);
    const onBye = !!(bye && bye === week);
    const injuryBad = BAD_INJURY_STATUSES.has(p.injury_status);
    const sev = injurySeverity(p.injury_status);
    const onThursday = isThursdayTeam(schedule, p.team);

    if (sev) starterHasInjury = true;
    const projPts = projectedPoints(pid, league, projectionsById);
    if (projPts != null) lowestStarterProjPts = lowestStarterProjPts == null ? projPts : Math.min(lowestStarterProjPts, projPts);

    if (onBye) alerts.byeStarters.push({ slot, player: p });
    if (sev) alerts.injuryStarters.push({ slot, player: p, severity: sev });
    // Thursday lock only matters for starters here when the slot is a flex
    // type — a single-position slot has no lineup flexibility to reconsider.
    if (onThursday && FLEX_SLOTS.has(slot)) alerts.thursdayFlags.push({ slot, player: p, isBench: false, game: schedule.get(normalizeTeam(p.team)) });

    if (onBye || injuryBad) {
      const eligiblePositions = FLEX_ELIGIBILITY[slot] || [slot];
      const candidates = benchIds
        .map((id) => playersById[id])
        .filter(Boolean)
        .filter((bp) => {
          const posOk = (bp.fantasy_positions || [bp.position]).some((pos) => eligiblePositions.includes(pos));
          if (!posOk) return false;
          const bpBye = getByeWeek(bp.team);
          if (bpBye && bpBye === week) return false;
          if (BAD_INJURY_STATUSES.has(bp.injury_status)) return false;
          return true;
        })
        .sort((a, b) => (a.injury_status === 'Questionable' ? 1 : 0) - (b.injury_status === 'Questionable' ? 1 : 0));

      alerts.subRecommendations.push({ reason: onBye ? 'bye' : 'injury', slot, outPlayer: p, candidates });
    }
  }

  for (const id of benchIds) {
    const p = playersById[id];
    if (!p) continue;
    const bye = getByeWeek(p.team);
    if (bye && bye === week) alerts.byeBench.push({ player: p });
    if (isThursdayTeam(schedule, p.team)) {
      // Only worth a notice if it's actionable before the Thursday lock: a
      // starter already carries an injury designation, or this bench player
      // projects for more points than your lowest starter.
      const benchProjPts = projectedPoints(id, league, projectionsById);
      const outscoresStarter = benchProjPts != null && lowestStarterProjPts != null && benchProjPts > lowestStarterProjPts;
      if (starterHasInjury || outscoresStarter) {
        alerts.thursdayFlags.push({ slot: 'BN', player: p, isBench: true, game: schedule.get(normalizeTeam(p.team)) });
      }
    }
  }

  return alerts;
}

// ---------- Viewing tab: real games this week, grouped by which of my
// starters (across leagues) are in them, with the points I need from that
// matchup and each player's projection. ----------

function renderViewing(leagueData, playersById, week, isRegularSeason, schedule, projectionsById) {
  const container = els.viewingContainer;
  container.innerHTML = '';

  if (!isRegularSeason) {
    container.innerHTML = `<div class="empty-state">Viewing info turns on once the regular season starts.</div>`;
    return;
  }
  if (!schedule || !schedule.games || !schedule.games.length) {
    container.innerHTML = `<div class="empty-state">Couldn't load this week's game schedule right now.</div>`;
    return;
  }

  // Only games that haven't finished yet — once a game is final there's
  // nothing left to watch for.
  const byGame = new Map(); // event id -> { game, players: Map(pid -> { playerName, team, leagues }) }
  for (const g of schedule.games) {
    if (g.state === 'post') continue;
    byGame.set(g.id, { game: g, players: new Map() });
  }

  for (const { league, myRoster, matchup } of leagueData) {
    if (!myRoster) continue;
    const startingSlotTypes = (league.roster_positions || []).filter((p) => p !== 'BN');
    const starters = myRoster.starters || [];
    const pointsNeeded = matchup && matchup.oppPoints != null ? Math.max(matchup.oppPoints - matchup.myPoints, 0) : null;

    for (let i = 0; i < startingSlotTypes.length; i++) {
      const pid = starters[i];
      if (!pid || pid === '0') continue;
      const player = playersById[pid];
      if (!player || !player.team) continue;
      const gameInfo = schedule.get(normalizeTeam(player.team));
      if (!gameInfo || gameInfo.eventId == null) continue; // bye week or unknown

      const bucket = byGame.get(gameInfo.eventId);
      if (!bucket) continue; // game already final, or unknown

      const projStats = projectionsById ? projectionsById[pid] : null;
      const projPts = projStats ? computeFantasyPoints(projStats, league.scoring_settings) : null;

      if (!bucket.players.has(pid)) {
        bucket.players.set(pid, { playerName: player.full_name, team: normalizeTeam(player.team), leagues: [] });
      }
      bucket.players.get(pid).leagues.push({
        leagueName: league.name,
        projPts,
        pointsNeeded,
        myPoints: matchup ? matchup.myPoints : null,
        oppPoints: matchup ? matchup.oppPoints : null,
      });
    }
  }

  const gamesWithPlayers = [...byGame.values()].filter((b) => b.players.size > 0);

  if (!gamesWithPlayers.length) {
    container.innerHTML = `<div class="empty-state">None of your starters are in an upcoming game this week.</div>`;
    return;
  }

  for (const { game, players } of gamesWithPlayers) {
    container.appendChild(renderGameCard(game, players));
  }
}

function renderGameCard(game, players) {
  const card = document.createElement('section');
  card.className = 'game-card';

  const liveScore = game.state === 'in' && game.away.score != null && game.home.score != null
    ? ` &middot; ${game.away.score}-${game.home.score}`
    : '';

  card.innerHTML = `
    <div class="game-card-header">
      <span class="game-teams">${escapeHtml(game.away.abbr)} @ ${escapeHtml(game.home.abbr)}</span>
      <span class="game-meta">${escapeHtml(game.weekday)} ${escapeHtml(game.monthDay)} &middot; ${escapeHtml(game.timeText)}${liveScore}</span>
    </div>
  `;

  const list = document.createElement('div');
  list.className = 'game-players';

  for (const { playerName, team, leagues } of players.values()) {
    const row = document.createElement('div');
    row.className = 'viewing-row';

    const chips = leagues.map((l) => {
      let statusText = '';
      let cls = '';
      if (l.oppPoints != null) {
        const margin = l.myPoints - l.oppPoints;
        if (margin > 0) { statusText = `+${margin.toFixed(1)}`; cls = ' lead'; }
        else if (margin === 0) { statusText = 'tied'; }
        else { statusText = `need ${l.pointsNeeded.toFixed(1)}`; cls = ' trail'; }
      }
      const projText = l.projPts != null ? `${l.projPts.toFixed(1)}p` : '&mdash;';
      return `<span class="league-chip${cls}"><b>${escapeHtml(l.leagueName)}</b>${statusText ? ` &middot; ${statusText}` : ''} &middot; ${projText}</span>`;
    }).join('');

    row.innerHTML = `<span class="viewing-player-name">${escapeHtml(playerName)} <span class="player-meta">${escapeHtml(team)}</span></span><span class="viewing-chips">${chips}</span>`;
    list.appendChild(row);
  }

  card.appendChild(list);
  return card;
}
