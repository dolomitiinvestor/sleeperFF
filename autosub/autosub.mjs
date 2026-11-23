// Sleeper autosub bot — runs in GitHub Actions on a schedule.
//
// Loads the web app's own app.js + byeWeeks.js (with a stub DOM) so the bot
// uses exactly the same Sleeper-projection x Vegas-line scoring as the Subs
// tab, then submits the recommended lineup for every league you're in.
//
// Env:
//   SLEEPER_USERNAME  your Sleeper username (required)
//   SLEEPER_TOKEN     Authorization token from sleeper.com (required when LIVE)
//   AUTOSUB_LIVE      "true" to actually submit; anything else = dry run
//   AUTOSUB_LEAGUES   optional comma-separated league_ids to limit to

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRAPHQL_URL = 'https://api.sleeper.app/graphql';

const USERNAME = (process.env.SLEEPER_USERNAME || '').trim();
const TOKEN = (process.env.SLEEPER_TOKEN || '').trim().replace(/^Bearer\s+/i, '');
const LIVE = String(process.env.AUTOSUB_LIVE || '').toLowerCase() === 'true';
const ONLY_LEAGUES = (process.env.AUTOSUB_LEAGUES || '').split(',').map((s) => s.trim()).filter(Boolean);

const summary = [];
const log = (line = '') => { console.log(line); summary.push(line); };

// ---------- Load the web app's logic into a sandbox ----------

function loadAppLogic() {
  // A Proxy that absorbs any DOM access app.js does at load time.
  const stub = new Proxy(function () {}, {
    get: (_t, prop) => (prop === Symbol.toPrimitive ? () => '' : stub),
    apply: () => stub,
    set: () => true,
  });
  const memStore = new Map();
  const ctx = {
    console, fetch, URL, URLSearchParams, Intl, Date, Math, JSON, Promise, Map, Set,
    setTimeout, clearTimeout,
    document: stub,
    window: { addEventListener() {} },
    localStorage: {
      getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
      setItem: (k, v) => memStore.set(k, String(v)),
      removeItem: (k) => memStore.delete(k),
    },
  };
  vm.createContext(ctx);
  for (const f of ['byeWeeks.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  for (const fn of ['getWeekSchedule', 'getProjectionsById', 'recommendSubs', 'averageImpliedTotal', 'gameHasStarted']) {
    if (typeof ctx[fn] !== 'function') throw new Error(`app.js no longer defines ${fn}() — autosub needs updating.`);
  }
  return ctx;
}

// ---------- Sleeper API ----------

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function submitLineup({ leagueId, rosterId, week, starters }) {
  const query = `mutation update_matchup_leg(
    $leagueId: String!  $rosterId: Int!  $round: Int!  $leg: Int!  $starters: [String]
  ) {
    update_matchup_leg(
      league_id: $leagueId, roster_id: $rosterId, round: $round, leg: $leg, starters: $starters
    ) { league_id leg round roster_id starters }
  }`;
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: TOKEN },
    body: JSON.stringify({
      operationName: 'update_matchup_leg',
      query,
      variables: { leagueId, rosterId, round: week, leg: week, starters },
    }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok || !body || body.errors) {
    throw new Error(`Sleeper rejected lineup (${res.status}): ${text.slice(0, 300)}`);
  }
  return body.data.update_matchup_leg;
}

function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

// ---------- Safety checks on a proposed lineup ----------

function validateLineup({ before, after, roster, lockedIdx }) {
  if (after.length !== before.length) return 'starter count changed';
  const owned = new Set(roster.players || []);
  const real = after.filter((p) => p && p !== '0');
  if (new Set(real).size !== real.length) return 'duplicate player in lineup';
  if (real.some((p) => !owned.has(p))) return 'lineup contains a player not on the roster';
  for (const i of lockedIdx) if (after[i] !== before[i]) return `locked slot ${i} would change`;
  return null;
}

// ---------- Main ----------

async function main() {
  if (!USERNAME) throw new Error('SLEEPER_USERNAME is not set.');
  if (LIVE && !TOKEN) throw new Error('AUTOSUB_LIVE is true but SLEEPER_TOKEN is not set.');

  log(`## Sleeper autosub — ${LIVE ? 'LIVE' : 'DRY RUN (set repo variable AUTOSUB_LIVE=true to submit)'}`);
  if (TOKEN) {
    const exp = tokenExpiry(TOKEN);
    if (exp) {
      const days = (exp - Date.now()) / 86400000;
      if (days < 0) throw new Error(`SLEEPER_TOKEN expired on ${exp.toISOString()} — grab a fresh one.`);
      if (days < 7) log(`> ⚠️ SLEEPER_TOKEN expires in ${days.toFixed(1)} days (${exp.toISOString()}).`);
    }
  }

  const app = loadAppLogic();
  const state = await getJSON('https://api.sleeper.app/v1/state/nfl');
  if (state.season_type !== 'regular') {
    log(`Season type is "${state.season_type}" — nothing to do.`);
    return;
  }
  const week = state.week;
  const user = await getJSON(`https://api.sleeper.app/v1/user/${encodeURIComponent(USERNAME)}`);
  if (!user || !user.user_id) throw new Error('Sleeper user not found — check SLEEPER_USERNAME.');

  let leagues = await getJSON(`https://api.sleeper.app/v1/user/${user.user_id}/leagues/nfl/${state.season}`);
  if (ONLY_LEAGUES.length) leagues = leagues.filter((l) => ONLY_LEAGUES.includes(l.league_id));

  const [schedule, projectionsById, allPlayers] = await Promise.all([
    app.getWeekSchedule(state.season, week),
    app.getProjectionsById(state.season, week),
    getJSON('https://api.sleeper.app/v1/players/nfl'),
  ]);
  if (!schedule) throw new Error('Could not load ESPN schedule/lines — not touching lineups.');
  if (!projectionsById) throw new Error('Could not load Sleeper projections — not touching lineups.');
  const avgImplied = app.averageImpliedTotal(schedule);
  log(`Week ${week} · ${leagues.length} league(s) · avg implied team total ${avgImplied.toFixed(1)}`);

  let failures = 0;
  for (const lg of leagues) {
    const leagueName = lg.name || lg.league_id;
    try {
      const [league, rosters, matchups] = await Promise.all([
        getJSON(`https://api.sleeper.app/v1/league/${lg.league_id}`),
        getJSON(`https://api.sleeper.app/v1/league/${lg.league_id}/rosters`),
        getJSON(`https://api.sleeper.app/v1/league/${lg.league_id}/matchups/${week}`).catch(() => null),
      ]);
      const roster = (rosters || []).find((r) => r.owner_id === user.user_id || (r.co_owners || []).includes(user.user_id));
      if (!roster) { log(`\n### ${leagueName}\nNo roster found — skipped.`); continue; }
      const leg = (matchups || []).find((m) => m.roster_id === roster.roster_id);
      if (!leg) { log(`\n### ${leagueName}\nNo matchup this week (bye/playoffs out) — skipped.`); continue; }

      // This week's lineup lives on the matchup leg, not the roster default.
      const before = [...(leg.starters || roster.starters || [])];
      const playersById = {};
      for (const id of roster.players || []) {
        const p = allPlayers[id];
        if (!p) continue;
        playersById[id] = {
          full_name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || id,
          position: p.position,
          fantasy_positions: p.fantasy_positions || (p.position ? [p.position] : []),
          team: p.team,
          status: p.status,
          injury_status: p.injury_status || null,
        };
      }

      const rec = app.recommendSubs(league, { ...roster, starters: before }, playersById, week, schedule, projectionsById, avgImplied);
      log(`\n### ${leagueName}`);
      if (!rec.swaps.length) { log('Lineup already optimal.'); continue; }

      for (const sw of rec.swaps) {
        const outName = sw.out ? sw.out.player.full_name : 'empty slot';
        log(`- ${sw.slot}: start **${sw.inn.player.full_name}** over ${outName} (+${sw.gain.toFixed(1)})`);
      }
      log(`Projected ${rec.totalBefore.toFixed(1)} → ${rec.totalAfter.toFixed(1)}`);

      const after = rec.finalStarters;
      const lockedIdx = before.map((pid, i) => {
        const p = playersById[pid];
        return p && app.gameHasStarted(schedule, p.team) ? i : -1;
      }).filter((i) => i >= 0);
      const problem = validateLineup({ before, after, roster, lockedIdx });
      if (problem) throw new Error(`Safety check failed (${problem}) — lineup not submitted.`);

      if (!LIVE) { log('_Dry run — not submitted._'); continue; }
      const result = await submitLineup({ leagueId: lg.league_id, rosterId: roster.roster_id, week, starters: after });
      const saved = (result && result.starters) || [];
      if (saved.join(',') !== after.join(',')) {
        throw new Error(`Sleeper saved a different lineup than requested: ${JSON.stringify(saved)}`);
      }
      log('✅ Submitted.');
    } catch (err) {
      failures++;
      log(`\n### ${leagueName}\n❌ ${err.message}`);
    }
  }
  if (failures) throw new Error(`${failures} league(s) failed.`);
}

main()
  .catch((err) => { log(`\n**Error:** ${err.message}`); process.exitCode = 1; })
  .finally(() => {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  });
