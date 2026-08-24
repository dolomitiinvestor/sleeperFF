# Sleeper Lineup Watch

A tiny static webapp that pulls **every Sleeper fantasy football team you're on**
by username and flags:

- 🛌 Starters who are on a **bye** this week
- 🚑 Starters who are **Out / Doubtful / IR** (with healthy bench replacement suggestions for that slot)
- ⚠️ Starters who are **Questionable**
- 📅 Anyone (starter or bench) who **plays Thursday Night**, so you don't forget to lock in that slot before kickoff

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
your roster in each one, and surface the alerts above. Tap **Load My Teams**
again any time to refresh.

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
- There is no projected-points data source wired in (that would require a
  paid API), so bench suggestions are eligibility-based, not ranked by
  projection — double check matchups before swapping.
