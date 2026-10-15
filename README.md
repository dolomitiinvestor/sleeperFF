# Sleeper Lineup Watch

A tiny static webapp that pulls **every Sleeper fantasy football team you're on**
by username and flags:

- Starters who are on a **bye** this week
- Starters who are **Out / IR / etc.** (red), **Doubtful** (orange), or **Questionable** (yellow) — with healthy bench replacement suggestions for Out/IR-level designations
- Starters in a **flex slot** who play Thursday Night, and bench players who play Thursday Night when a starter carries an injury designation or the bench player is projected to outscore your lowest starter — so you don't forget to lock in that slot before kickoff

There's also a **Viewing** tab: real NFL game times/teams/venues for the week,
grouped so you can see which games have your starters in them, how many
points you need from that league's matchup to win, and each player's
projected points.

And a **Subs** tab: per league, the start/sit swaps that raise your
projected total. Each player's score is their Sleeper projection scaled by
the Vegas line — team implied total (over/under ÷ 2 − spread ÷ 2) vs. this
week's average team. Defenses use the opponent's implied total instead.

It's 100% static — no server, no login, no build step. It talks directly to
Sleeper's public read-only API and ESPN's public scoreboard from your browser.
Nothing you enter is sent anywhere except those two APIs, and the only thing
saved locally (in your phone's browser storage) is your username and a cached
copy of the player database.

## Deploy to GitHub Pages

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. In the repo: **Settings → Pages**.
3. Under "Build and deployment", set **Source: Deploy from a branch**.
4. Branch: pick the branch these files are on, folder **/ (root)**. Save.
5. GitHub gives you a URL like `https://<your-username>.github.io/<repo-name>/`.
   It can take a minute or two to go live the first time.

No secrets, no API keys, nothing else to configure.

## Use it on your iPhone

1. Open the GitHub Pages URL in **Safari** (must be Safari for this to work).
2. Tap the **Share** icon → **Add to Home Screen**.
3. It installs like an app with its own icon — tap it to launch full-screen.

## Using the app

Type your **Sleeper username** (not display name / not email) and tap **Load
My Teams**. It'll pull every league you're in for the current season, show
your roster in each one, and surface the alerts above. Your username is saved
in the browser, so the app reloads your teams automatically on future visits
— tap **Load My Teams** again any time to force a refresh.

The player database (names, positions, injury status) is a ~5–6&nbsp;MB
download from Sleeper. The app caches it in your browser for about 20 hours
so repeat loads are fast — use the "Force-refresh player data" link at the
bottom if you want the very latest injury designations immediately.

## Updating bye weeks for a new season

Bye weeks aren't available from Sleeper's API, so they're hardcoded in
[`byeWeeks.js`](byeWeeks.js). Once the NFL releases next year's schedule,
update the `BYE_WEEKS` table in that file (32 teams, one bye week each) and
push. Nothing else needs to change.

## How it works (technical notes)

- **Rosters/leagues/players**: `api.sleeper.app` — no auth required.
- **Thursday Night matchup**: `site.api.espn.com` scoreboard for the current
  week, filtered to games that fall on a Thursday in US Eastern time (this
  also naturally catches the Thanksgiving Thursday slate). If ESPN's endpoint
  is unreachable, the Thursday-lock alerts are simply skipped for that load —
  everything else still works.
- **Flex-slot substitutions**: recommendations only suggest bench players
  eligible for the specific slot (e.g. a `WRRB_FLEX` only gets WR/RB
  suggestions), and skip anyone else who is also on a bye or already
  Out/Doubtful/IR.
- Bench-swap suggestions are still eligibility-based, not ranked by
  projection — double check matchups before swapping.
- **Projections** (Viewing tab): `api.sleeper.app/projections/nfl/...`, an
  unofficial but public Sleeper endpoint. Raw per-stat projections are
  combined with each league's own `scoring_settings` so the number reflects
  that league's exact scoring, not a generic PPR/standard guess.
- **Subs tab scoring**: `score = projection × (1 + 0.5 × (implied − avg) / avg)`,
  capped at ±15%. Example: avg 22.5, team implied 27.0 → +10%. Lines come
  from the `odds` block on ESPN's scoreboard. Swaps under 0.5 pts are
  ignored. Bench players who are on bye, Out/IR/Doubtful, or already
  kicked off are never suggested, and locked starters are never moved.
- **Matchup score / points needed** (Viewing tab): Sleeper's
  `/league/{id}/matchups/{week}` endpoint, which is the same live score
  Sleeper's own site shows.
