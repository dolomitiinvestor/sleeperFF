// Sleeper Lineup Watch — client-side only. Everything below runs in the browser.

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
  header: document.querySelector('.app-header'),
  headerToggle: document.getElementById('header-toggle'),
  headerSummary: document.getElementById('header-summary'),
  form: document.getElementById('load-form'),
  input: document.getElementById('username-input'),
  loadBtn: document.getElementById('load-btn'),
  statusLine: document.getElementById('status-line'),
  emptyState: document.getElementById('empty-state'),
  seasonBanner: document.getElementById('season-banner'),
  leaguesContainer: document.getElementById('leagues-container'),
  leaguesDots: document.getElementById('leagues-dots'),
  refreshPlayersBtn: document.getElementById('refresh-players-btn'),
  playersUpdated: document.getElementById('players-updated'),
  tabNav: document.getElementById('tab-nav'),
  leaguesTab: document.getElementById('leagues-tab'),
  viewingTab: document.getElementById('viewing-tab'),
  viewingContainer: document.getElementById('viewing-container'),
};

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

els.headerToggle.addEventListener('click', () => {
  const collapsed = els.header.classList.toggle('collapsed');
  els.headerToggle.setAttribute('aria-expanded', String(!collapsed));
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
  els.header.classList.remove('collapsed');
  els.headerToggle.hidden = true;
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

    // Collect every player id we'll need to display, across all leagues —
    // including opponents' starters, so the Viewing tab can show their side too.
    const neededIds = new Set();
    for (const { myRoster, matchup } of leagueData) {
      if (!myRoster) continue;
      for (const id of myRoster.players || []) neededIds.add(id);
      if (matchup) for (const id of matchup.oppStarters || []) neededIds.add(id);
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

    // Projected week total per team, for the Viewing tab's per-team totals.
    for (const entry of leagueData) {
      if (!entry.myRoster || !entry.matchup) continue;
      entry.matchup.projMyTotal = sumProjected(entry.myRoster.starters, entry.league, projectionsById);
      entry.matchup.projOppTotal = sumProjected(entry.matchup.oppStarters, entry.league, projectionsById);
    }

    renderSeasonBanner(state, isRegularSeason);
    renderLeagues(leagueData, playersById, week, isRegularSeason, schedule, projectionsById);
    renderViewing(leagueData, playersById, week, isRegularSeason, schedule, projectionsById);
    els.tabNav.hidden = false;

    const loadedCount = leagueData.filter(l => l.myRoster).length;
    setStatus(`Loaded ${loadedCount} of ${leagueData.length} league${leagueData.length === 1 ? '' : 's'} for ${user.display_name || username}.`);
    updatePlayersFooter();

    els.headerSummary.textContent = `${user.display_name || username} · ${loadedCount} of ${leagueData.length} league${leagueData.length === 1 ? '' : 's'} loaded`;
    els.headerToggle.hidden = false;
    els.headerToggle.setAttribute('aria-expanded', 'false');
    els.header.classList.add('collapsed');
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
          kickoff: event.date,
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

// Once a player's real game has kicked off, Sleeper locks their roster slot —
// so any "swap this player" alert is stale and shouldn't keep showing.
function gameHasStarted(schedule, team) {
  const g = schedule && schedule.get(normalizeTeam(team));
  return !!g && g.state && g.state !== 'pre';
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
    oppStarters: opp ? (opp.starters || []) : [],
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

  const leagueCards = [];
  const decisionGroups = [];

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
      leagueCards.push(card);
      continue;
    }

    const owner = users.find((u) => u.user_id === myRoster.owner_id);
    const teamName = (myRoster.metadata && myRoster.metadata.team_name) || (owner && (owner.metadata && owner.metadata.team_name)) || (owner && owner.display_name) || 'My Team';
    const record = myRoster.settings || {};
    const recordText = `${record.wins ?? 0}-${record.losses ?? 0}${record.ties ? `-${record.ties}` : ''}`;

    const alerts = isRegularSeason
      ? analyzeRoster(league, myRoster, playersById, week, schedule, projectionsById)
      : { byeStarters: [], byeBench: [], injuryStarters: [], thursdayFlags: [], subRecommendations: [], flexOptimization: [] };

    const totalAlerts = alerts.byeStarters.length + alerts.injuryStarters.length + alerts.thursdayFlags.length + alerts.flexOptimization.length;
    if (totalAlerts > 0) {
      decisionGroups.push({ leagueName: league.name, teamName, alerts });
    }

    card.innerHTML = `
      <div class="league-card-header">
        <div class="league-title">
          <h2>${escapeHtml(league.name)}</h2>
          <div class="sub">${escapeHtml(teamName)}</div>
        </div>
        <div class="record-pill">${recordText}</div>
      </div>
    `;

    card.appendChild(renderAlerts(alerts));
    card.appendChild(renderRosterList(league, myRoster, playersById, week, schedule));
    leagueCards.push(card);
  }

  if (isRegularSeason) {
    els.leaguesContainer.appendChild(renderDecisionPointsCard(decisionGroups, leagueData.length));
  }
  for (const card of leagueCards) els.leaguesContainer.appendChild(card);

  updateLeagueDots();
}

// A leading summary card — a "quasi tab" that's always the first swipe stop
// on mobile — pooling every league's bye/injury/Thursday-lock alerts so you
// don't have to flip through each league to see what needs a decision.
function renderDecisionPointsCard(decisionGroups, totalLeagues) {
  const card = document.createElement('section');
  card.className = 'league-card decision-points-card';

  const summary = decisionGroups.length === 0
    ? `All clear across ${totalLeagues} league${totalLeagues === 1 ? '' : 's'}.`
    : `${decisionGroups.length} of ${totalLeagues} league${totalLeagues === 1 ? '' : 's'} need a lineup check.`;

  card.innerHTML = `
    <div class="league-card-header">
      <div class="league-title">
        <h2>Decision Points</h2>
        <div class="sub">${escapeHtml(summary)}</div>
      </div>
    </div>
  `;

  if (decisionGroups.length === 0) {
    const wrap = document.createElement('div');
    wrap.className = 'no-alerts';
    wrap.textContent = 'No bye, injury, or Thursday-lock issues across any of your leagues this week.';
    card.appendChild(wrap);
    return card;
  }

  for (const group of decisionGroups) {
    const groupWrap = document.createElement('div');
    groupWrap.className = 'decision-group';
    const heading = document.createElement('h3');
    heading.textContent = `${group.leagueName} · ${group.teamName}`;
    groupWrap.appendChild(heading);
    groupWrap.appendChild(renderAlerts(group.alerts));
    card.appendChild(groupWrap);
  }

  return card;
}

// ---------- Swipe-carousel position dots (mobile) ----------

let leagueDotsObserver = null;

function updateLeagueDots() {
  if (leagueDotsObserver) {
    leagueDotsObserver.disconnect();
    leagueDotsObserver = null;
  }

  const cards = Array.from(els.leaguesContainer.querySelectorAll('.league-card'));
  els.leaguesDots.innerHTML = '';
  els.leaguesDots.hidden = cards.length <= 1;
  if (cards.length <= 1) return;

  const dots = cards.map((card, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'dot';
    dot.setAttribute('aria-label', `Go to card ${i + 1} of ${cards.length}`);
    dot.addEventListener('click', () => card.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' }));
    els.leaguesDots.appendChild(dot);
    return dot;
  });
  dots[0].classList.add('active');

  leagueDotsObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = cards.indexOf(entry.target);
        if (idx === -1) continue;
        dots.forEach((d, i) => d.classList.toggle('active', i === idx));
      }
    },
    { root: els.leaguesContainer, threshold: 0.6 }
  );
  cards.forEach((card) => leagueDotsObserver.observe(card));
}

function renderAlerts(alerts) {
  const wrap = document.createElement('div');
  const totalAlerts = alerts.byeStarters.length + alerts.injuryStarters.length + alerts.thursdayFlags.length + alerts.flexOptimization.length;

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
  for (const item of alerts.flexOptimization) {
    wrap.appendChild(alertRow(
      'sev-grey',
      `${item.betterPlayer.full_name} (${item.betterSlot}, ${item.betterGame.weekday} ${item.betterGame.monthDay} ${item.betterGame.timeText}) plays later than ${item.flexPlayer.full_name} in your FLEX (${item.flexGame.weekday} ${item.flexGame.monthDay} ${item.flexGame.timeText}) — swap them into FLEX for maximum flexibility.`,
      null
    ));
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

// Sums projected points across a set of starters, for the "projected week
// total" shown per team in the Viewing tab. Returns null (rendered as
// "—") only when none of the starters have a projection yet.
function sumProjected(pids, league, projectionsById) {
  let total = 0;
  let any = false;
  for (const pid of pids || []) {
    if (!pid || pid === '0') continue;
    const pts = projectedPoints(pid, league, projectionsById);
    if (pts != null) {
      total += pts;
      any = true;
    }
  }
  return any ? total : null;
}

function analyzeRoster(league, roster, playersById, week, schedule, projectionsById) {
  const startingSlotTypes = (league.roster_positions || []).filter((p) => p !== 'BN');
  const starters = roster.starters || [];
  const reserve = new Set(roster.reserve || []);
  const taxi = new Set(roster.taxi || []);
  const benchIds = (roster.players || []).filter((id) => !starters.includes(id) && !reserve.has(id) && !taxi.has(id));

  const alerts = { byeStarters: [], byeBench: [], injuryStarters: [], thursdayFlags: [], subRecommendations: [], flexOptimization: [] };

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
    const started = gameHasStarted(schedule, p.team);

    if (sev) starterHasInjury = true;
    const projPts = projectedPoints(pid, league, projectionsById);
    if (projPts != null) lowestStarterProjPts = lowestStarterProjPts == null ? projPts : Math.min(lowestStarterProjPts, projPts);

    if (onBye) alerts.byeStarters.push({ slot, player: p });
    if (sev && !started) alerts.injuryStarters.push({ slot, player: p, severity: sev });
    // Thursday lock only matters for starters here when the slot is a flex
    // type — a single-position slot has no lineup flexibility to reconsider —
    // and only before that lock actually happens.
    if (onThursday && FLEX_SLOTS.has(slot) && !started) alerts.thursdayFlags.push({ slot, player: p, isBench: false, game: schedule.get(normalizeTeam(p.team)) });

    if (onBye || (injuryBad && !started)) {
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
    if (isThursdayTeam(schedule, p.team) && !gameHasStarted(schedule, p.team)) {
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

  // Flex-slot optimization: a fixed WR/RB/QB/TE slot only accepts a
  // same-position bench sub, but FLEX accepts any eligible position — so
  // keeping whichever eligible starter has the *latest* kickoff in FLEX
  // preserves the most last-minute swap options right up until the last of
  // them locks. Only compare same-position starters, though — swapping a WR
  // into FLEX ahead of an RB (or a QB ahead of anything, outside SUPER_FLEX)
  // isn't a like-for-like flexibility trade, it's a lineup change, so that's
  // out of scope for this alert.
  const flexSlotIndices = [];
  for (let i = 0; i < startingSlotTypes.length; i++) {
    if (FLEX_SLOTS.has(startingSlotTypes[i])) flexSlotIndices.push(i);
  }

  for (const flexIdx of flexSlotIndices) {
    const flexSlot = startingSlotTypes[flexIdx];
    const flexPid = starters[flexIdx];
    if (!flexPid || flexPid === '0') continue;
    const flexPlayer = playersById[flexPid];
    if (!flexPlayer || !flexPlayer.position) continue;
    const flexGame = schedule ? schedule.get(normalizeTeam(flexPlayer.team)) : null;
    // Once the FLEX starter's game has kicked off, that slot is locked —
    // nothing left to swap.
    if (!flexGame || !flexGame.kickoff || flexGame.state !== 'pre') continue;

    let latest = { player: flexPlayer, slot: flexSlot, game: flexGame };

    for (let i = 0; i < startingSlotTypes.length; i++) {
      if (i === flexIdx) continue;
      const slot = startingSlotTypes[i];
      // Same real position as whoever's in FLEX right now, and a genuine
      // fixed slot for that position (not another flex-type slot).
      if (FLEX_SLOTS.has(slot) || slot !== flexPlayer.position) continue;
      const pid = starters[i];
      if (!pid || pid === '0') continue;
      const p = playersById[pid];
      if (!p) continue;
      const game = schedule ? schedule.get(normalizeTeam(p.team)) : null;
      // A candidate whose game already started is locked into their own
      // slot and can't be moved into FLEX anymore.
      if (!game || !game.kickoff || game.state !== 'pre') continue;
      if (new Date(game.kickoff) > new Date(latest.game.kickoff)) {
        latest = { player: p, slot, game };
      }
    }

    if (latest.player !== flexPlayer) {
      alerts.flexOptimization.push({
        flexSlot,
        flexPlayer,
        flexGame,
        betterSlot: latest.slot,
        betterPlayer: latest.player,
        betterGame: latest.game,
      });
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
  const byGame = new Map(); // event id -> { game, rows: Map(leagueName -> {leagueName, mine, theirs}) }
  for (const g of schedule.games) {
    if (g.state === 'post') continue;
    byGame.set(g.id, { game: g, rows: new Map() });
  }

  for (const { league, myRoster, matchup } of leagueData) {
    if (!myRoster) continue;
    const startingSlotTypes = (league.roster_positions || []).filter((p) => p !== 'BN');
    const pointsNeeded = matchup && matchup.oppPoints != null ? Math.max(matchup.oppPoints - matchup.myPoints, 0) : null;

    addStartersToGames(byGame, 'mine', startingSlotTypes, myRoster.starters || [], playersById, schedule, league, projectionsById, {
      leagueName: league.name,
      pointsNeeded,
      myPoints: matchup ? matchup.myPoints : null,
      oppPoints: matchup ? matchup.oppPoints : null,
    });

    if (matchup && matchup.oppStarters && matchup.oppStarters.length) {
      addStartersToGames(byGame, 'theirs', startingSlotTypes, matchup.oppStarters, playersById, schedule, league, projectionsById, {
        leagueName: league.name,
      });
    }
  }

  const gamesWithPlayers = [...byGame.values()].filter((b) => b.rows.size > 0);

  if (!gamesWithPlayers.length) {
    container.innerHTML = `<div class="empty-state">None of your or your opponents' starters are in an upcoming game this week.</div>`;
  } else {
    for (const { game, rows } of gamesWithPlayers) {
      container.appendChild(renderGameCard(game, rows));
    }
  }

  container.appendChild(renderLeagueTotals(leagueData));
}

// One row per league at the bottom of the Viewing tab: the projected total
// for your whole roster vs. your opponent's, for the week — independent of
// which real games are shown above.
function renderLeagueTotals(leagueData) {
  const wrap = document.createElement('section');
  wrap.className = 'league-totals';
  wrap.appendChild(sectionHeading('Projected Week Totals'));

  for (const { league, matchup } of leagueData) {
    if (!matchup) continue;
    const row = document.createElement('div');
    row.className = 'league-total-row';
    const myText = matchup.projMyTotal != null ? `${matchup.projMyTotal.toFixed(1)}p` : '&mdash;';
    const oppText = matchup.projOppTotal != null ? `${matchup.projOppTotal.toFixed(1)}p` : '&mdash;';
    const oppLabel = escapeHtml(matchup.oppTeamName || 'Opponent');
    row.innerHTML = `
      <span class="league-total-name">${escapeHtml(league.name)}</span>
      <span class="league-total-score mine"><b>You</b>: ${myText}</span>
      <span class="league-total-score theirs"><b>${oppLabel}</b>: ${oppText}</span>
    `;
    wrap.appendChild(row);
  }

  return wrap;
}

// Walks one roster's starters and files each one (that's in an upcoming game)
// into that game's bucket, keyed by league so the mine/theirs sides of the
// same league end up as the same row — aligned head-to-head — regardless of
// how many other leagues/players are also in that game.
function addStartersToGames(byGame, side, startingSlotTypes, starters, playersById, schedule, league, projectionsById, leagueMeta) {
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

    let row = bucket.rows.get(leagueMeta.leagueName);
    if (!row) {
      row = { leagueName: leagueMeta.leagueName, mine: null, theirs: null };
      bucket.rows.set(leagueMeta.leagueName, row);
    }
    row[side] = { playerName: player.full_name, team: normalizeTeam(player.team), projPts, ...leagueMeta };
  }
}

function renderGameCard(game, rows) {
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

  const columns = document.createElement('div');
  columns.className = 'game-columns';

  const mineHeading = document.createElement('h4');
  mineHeading.className = 'col-heading mine';
  mineHeading.textContent = 'Your players';
  const theirsHeading = document.createElement('h4');
  theirsHeading.className = 'col-heading theirs';
  theirsHeading.textContent = 'Opponent players';
  columns.appendChild(mineHeading);
  columns.appendChild(theirsHeading);

  const sortedRows = [...rows.values()].sort((a, b) => a.leagueName.localeCompare(b.leagueName));
  for (const row of sortedRows) {
    columns.appendChild(renderViewingCell(row.leagueName, row.mine, 'mine'));
    columns.appendChild(renderViewingCell(row.leagueName, row.theirs, 'theirs'));
  }

  card.appendChild(columns);

  return card;
}

function renderViewingCell(leagueName, entry, side) {
  const cell = document.createElement('div');
  cell.className = `game-cell ${side}`;

  if (!entry) {
    cell.className += ' empty';
    return cell;
  }

  let statusText = '';
  let cls = '';
  if (side === 'mine' && entry.oppPoints != null) {
    const margin = entry.myPoints - entry.oppPoints;
    if (margin > 0) { statusText = `+${margin.toFixed(1)}`; cls = ' lead'; }
    else if (margin === 0) { statusText = 'tied'; }
    else { statusText = `need ${entry.pointsNeeded.toFixed(1)}`; cls = ' trail'; }
  }
  const projText = entry.projPts != null ? `${entry.projPts.toFixed(1)}p` : '&mdash;';

  cell.innerHTML = `
    <div class="cell-top">
      <span class="league-tag">${escapeHtml(leagueName)}</span>
      <span class="league-chip${cls}">${statusText ? `${statusText} &middot; ` : ''}${projText}</span>
    </div>
    <div class="viewing-player-name">${escapeHtml(entry.playerName)} <span class="player-meta">${escapeHtml(entry.team)}</span></div>
  `;
  return cell;
}
