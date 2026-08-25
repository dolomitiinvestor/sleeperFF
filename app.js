// Sleeper Lineup Watch — client-side only. Everything below runs in the browser.

const SLEEPER_BASE = 'https://api.sleeper.app/v1';
const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

const PLAYERS_CACHE_KEY = 'sff_players_cache_v1';
const USERNAME_KEY = 'sff_username';
const PLAYERS_CACHE_MAX_AGE_MS = 20 * 60 * 60 * 1000; // ~20h, Sleeper asks for at most daily refreshes

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
};

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

// Restore last-used username on load, but don't auto-fetch (avoid surprise data use on cellular).
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem(USERNAME_KEY);
  if (saved) els.input.value = saved;
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

    const leagueData = await Promise.all(leagues.map(async (league) => {
      const [detail, rosters, users] = await Promise.all([
        fetchJSON(`${SLEEPER_BASE}/league/${league.league_id}`),
        fetchJSON(`${SLEEPER_BASE}/league/${league.league_id}/rosters`),
        fetchJSON(`${SLEEPER_BASE}/league/${league.league_id}/users`),
      ]);
      const myRoster = (rosters || []).find(
        (r) => r.owner_id === user.user_id || (r.co_owners || []).includes(user.user_id)
      );
      return { league: detail, rosters, users, myRoster };
    }));

    // Collect every player id we'll need to display, across all leagues.
    const neededIds = new Set();
    for (const { myRoster } of leagueData) {
      if (!myRoster) continue;
      for (const id of myRoster.players || []) neededIds.add(id);
    }

    setStatus('Loading player database (cached ~daily)…');
    const playersById = await getPlayersById(neededIds, opts.forcePlayers);

    const isRegularSeason = state.season_type === 'regular' || state.season_type === 'post';
    const week = state.week || state.leg;

    let schedule = null;
    if (isRegularSeason) {
      setStatus('Checking this week\'s game schedule…');
      schedule = await getWeekSchedule(state.season, week).catch(() => null);
    }

    renderSeasonBanner(state, isRegularSeason);
    renderLeagues(leagueData, playersById, week, isRegularSeason, schedule);

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
  for (const event of data.events || []) {
    const meta = formatGameMeta(event.date);
    for (const comp of event.competitions || []) {
      const competitors = comp.competitors || [];
      for (const c of competitors) {
        const abbr = c.team && c.team.abbreviation;
        if (!abbr) continue;
        const opponent = competitors.find((o) => o !== c);
        schedule.set(normalizeTeam(abbr), {
          ...meta,
          opponent: opponent && opponent.team ? normalizeTeam(opponent.team.abbreviation) : null,
          homeAway: c.homeAway || null,
        });
      }
    }
  }
  return schedule;
}

function isThursdayTeam(schedule, team) {
  const g = schedule && schedule.get(normalizeTeam(team));
  return !!g && g.weekday === 'Thu';
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

function renderLeagues(leagueData, playersById, week, isRegularSeason, schedule) {
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
      ? analyzeRoster(league, myRoster, playersById, week, schedule)
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
    wrap.textContent = '✓ No bye, injury, or Thursday-lock issues in your starting lineup.';
    return wrap;
  }

  wrap.className = 'alerts';

  for (const item of alerts.byeStarters) {
    wrap.appendChild(alertRow('sev-high', '🛌', `${item.player.full_name} (${item.slot}) is on BYE — Week off, 0 points guaranteed.`, findSubs(alerts, item.player)));
  }
  for (const item of alerts.injuryStarters) {
    const sev = item.severity === 'high' ? 'sev-high' : 'sev-mid';
    const icon = item.severity === 'high' ? '🚑' : '⚠️';
    wrap.appendChild(alertRow(sev, icon, `${item.player.full_name} (${item.slot}) is ${item.player.injury_status}${item.player.injury_body_part ? ` — ${item.player.injury_body_part}` : ''}.`, item.severity === 'high' ? findSubs(alerts, item.player) : null));
  }
  for (const item of alerts.thursdayFlags) {
    const where = item.isBench ? 'on your bench' : `starting at ${item.slot}`;
    const when = item.game ? ` (${item.game.monthDay}, ${item.game.timeText})` : '';
    wrap.appendChild(alertRow('sev-info', '📅', `${item.player.full_name} plays Thursday Night${when} — ${where}. Set your final lineup before kickoff, that slot locks early.`, null));
  }

  return wrap;
}

function findSubs(alerts, player) {
  const rec = alerts.subRecommendations.find((r) => r.outPlayer === player);
  return rec ? rec.candidates : null;
}

function alertRow(sevClass, icon, text, candidates) {
  const row = document.createElement('div');
  row.className = `alert ${sevClass}`;
  const candHtml = candidates
    ? (candidates.length
        ? `<div class="sub-list">Bench options: ${candidates.map((c) => `<span class="cand">${escapeHtml(c.full_name)} (${c.position}${c.team ? ' · ' + c.team : ''})</span>`).join('')}</div>`
        : `<div class="sub-list">No eligible healthy bench replacement for this slot.</div>`)
    : '';
  row.innerHTML = `<span class="icon">${icon}</span><div><div>${text}</div>${candHtml}</div>`;
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
  const onThursday = game && game.weekday === 'Thu';

  let gameChip = '';
  if (onBye) {
    gameChip = `<span class="badge bye">BYE</span>`;
  } else if (game) {
    gameChip = `<span class="badge game${onThursday ? ' thu' : ''}">${escapeHtml(game.weekday)} ${escapeHtml(game.monthDay)} · ${escapeHtml(game.timeText)}</span>`;
  } else if (schedule) {
    // schedule loaded successfully but this team has no game this week (bye
    // not in our static table, postponed, etc.) — say so instead of guessing
    gameChip = `<span class="badge unknown">No game found</span>`;
  }

  let statusBadges = '';
  if (player.injury_status === 'Questionable') statusBadges += `<span class="badge quest">Q</span>`;
  else if (BAD_INJURY_STATUSES.has(player.injury_status)) statusBadges += `<span class="badge out">${escapeHtml(player.injury_status)}</span>`;

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

function analyzeRoster(league, roster, playersById, week, schedule) {
  const startingSlotTypes = (league.roster_positions || []).filter((p) => p !== 'BN');
  const starters = roster.starters || [];
  const reserve = new Set(roster.reserve || []);
  const taxi = new Set(roster.taxi || []);
  const benchIds = (roster.players || []).filter((id) => !starters.includes(id) && !reserve.has(id) && !taxi.has(id));

  const alerts = { byeStarters: [], byeBench: [], injuryStarters: [], thursdayFlags: [], subRecommendations: [] };

  for (let i = 0; i < startingSlotTypes.length; i++) {
    const slot = startingSlotTypes[i];
    const pid = starters[i];
    if (!pid || pid === '0') continue;
    const p = playersById[pid];
    if (!p) continue;

    const bye = getByeWeek(p.team);
    const onBye = !!(bye && bye === week);
    const injuryBad = BAD_INJURY_STATUSES.has(p.injury_status);
    const injuryCaution = p.injury_status === 'Questionable';
    const onThursday = isThursdayTeam(schedule, p.team);

    if (onBye) alerts.byeStarters.push({ slot, player: p });
    if (injuryBad) alerts.injuryStarters.push({ slot, player: p, severity: 'high' });
    else if (injuryCaution) alerts.injuryStarters.push({ slot, player: p, severity: 'low' });
    if (onThursday) alerts.thursdayFlags.push({ slot, player: p, isBench: false, game: schedule.get(normalizeTeam(p.team)) });

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
    if (isThursdayTeam(schedule, p.team)) alerts.thursdayFlags.push({ slot: 'BN', player: p, isBench: true, game: schedule.get(normalizeTeam(p.team)) });
  }

  return alerts;
}
