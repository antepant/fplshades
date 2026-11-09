# FPL Shades — Fantasy Premier League decision support

A static site with six views:

- **Players**: stats for every player for the season, the last 6 or last 3 gameweeks, or any GW range, as totals or per 90. Columns include points, G/xG, A/xA, GI/xGI, GI−xGI (over/under-performance), xGC, clean sheets, defensive contributions and how often the DC threshold was hit, bonus and BPS, plus the next 5 fixtures. Filter by position, team, max price, minutes (remembered separately for each window) and name. Injury/doubt flags show the chance of playing (hover for the news). The **Shooting & creation** column set switches to Understat numbers: shots, shots in the box, npxG, xG per shot, key passes, xA, npxG+xA, xGChain and xGBuildup. Click a player for their gameweek log, points and xG/xA charts, set-piece duties, next 8 fixtures, a **shot map** (shots taken, or shots from their passes, for season / last 6 / last 3, with or without penalties) and a **starting-positions map** (where they lined up in each start).
- **Ticker**: a fixture matrix (teams × upcoming gameweeks) with stats instead of just team names, like [Ticker shades](https://antepant.shinyapps.io/ticker_shades/). Upper case = home, lower case = away. Choose:
  - **For**: *Attack* (good fixtures for attackers), *Defence* (good fixtures for defenders and keepers) or *FPL FDR*.
  - **Model**: *Opponent only* shows the opponent's goals (or xG) conceded per game (Attack) or scored per game (Defence). *Team vs opponent* projects the team's goals for or against: team rate × opponent rate ÷ league average.
  - **Measure**: xG or actual goals. **Form period**: the team's last 3, last 6 or all games. **From** / **Gameweeks**: which gameweeks to show. **Home/away form** uses each team's own home games when it plays at home and away games when it plays away, against the opponent's games at the other venue.
  - The last column is the sum of projected goals (Attack), the expected clean sheets (Defence, team vs opponent: the sum of e^(−projected goals against) per fixture), the average (Defence, opponent only) or the average FDR. Double gameweeks are outlined and count twice; blanks are hatched and count zero.
- **Schedule**: a plain fixture list for the rest of the season, with the kick-off day under each opponent and counts of double and blank gameweeks. Pick an earlier start to see played games with scores (hover for xG). Fixtures without a date are listed below.
- **Teams**: games played, W/D/L, points, goals, clean sheets, xGF/xGA/xGD and per-game rates, for the last 3, last 6 or all games, home, away or both. Click a team for its results with xG per game, shot maps for and against, next fixtures and top players by xGI.
- **Results**: every game played so far, newest first: kick-off, home and away team, the score, each team's xG and the top 3 FPL points scorers. Filter by gameweek or team. Click a game for every player who played in it, with minutes, points, goals, assists, xG, xA, clean sheet, goals conceded, xGC, defensive contributions and DC hit, saves, penalties saved and missed, cards, own goals, bonus and BPS (sortable), plus both teams' shot maps.
- **Defcons**: which teams players get defensive-contribution points against. Each row is an opponent, with the DC hits per game, the hit rate of 60+ minute appearances and the defensive contributions per 90 of the players facing it, split by position, plus the teams that face it in the next 5 gameweeks. Filter by the opponent's last 3, last 6 or all games, by where the players were (home, away or both) and by position. Click a team for each game and who reached the threshold.

Blue means good for the team, red means bad, everywhere. All columns sort; filters are remembered in the browser.

## Run it

```bash
python fetch/fetch_data.py
```

```bash
python -m http.server 8000 --directory site
```

Then open http://localhost:8000. You need Python 3.9+ and nothing else (standard library only). The first fetch takes about a minute (one Understat request per played match); after that a few seconds, because finished gameweeks and matches are cached in `fetch/cache/`.

## Where the data comes from

FPL data comes from the official (undocumented) Fantasy Premier League API, `fantasy.premierleague.com/api`:

| Data | Endpoint |
|---|---|
| Players, prices, ownership, injury news, set-piece order, gameweeks | `bootstrap-static/` |
| Fixtures, scores, FDR | `fixtures/` |
| Per-player stats for each gameweek (minutes, points, xG, xA, xGC, DC, bonus…) | `event/{gw}/live/` |
| Per-fixture split for players with two games in one gameweek | `element-summary/{id}/` |

Shot and position data comes from [Understat](https://understat.com) (`fetch/understat.py`), using the JSON its own pages load:

| Data | Endpoint |
|---|---|
| Season fixture list and match ids | `getLeagueData/EPL/{season}` |
| Every shot (x/y, xG, result, situation, body part, assister) and each player's position, minutes, key passes, xA, xGChain, xGBuildup | `getMatchData/{match id}` |

Understat has no official API, so this can break if they change their site. Their data is free for **non-commercial use with credit** (the site footer credits it). Matches are cached once they're a day old, and uncached requests are spaced out. If Understat can't be reached, the fetch uses the matches already in the cache, and the site notes which recent games are missing (they're filled in at the next update that reaches Understat). With nothing cached, the shot features show a message and everything else still works.

Neither API is documented, so fields can change. The fetch writes five files to `site/data/`: `players.json` (each player's per-fixture FPL and Understat rows), `shots.json` (loaded the first time you open a shot map), `fixtures.json`, `teams.json` and `meta.json`. All windows and models are worked out in the browser from these.

## How things are worked out

- **Team xG** for a fixture is the sum of that team's players' xG in it (the FPL API has no team-level xG). Team xGA is the opponent's sum. Players who have moved club since a game are left out of these sums, because the API only gives their current club.
- **Double gameweeks**: the live endpoint adds up a player's two games, so for those players the fetch reads their per-fixture history instead.
- **Last N gameweeks** (Players) counts gameweeks with games played so far. **Last N games** (Ticker, Teams) counts each team's own finished games, so a blank doesn't shorten the window.
- **Home/away form**: with it on, a home fixture combines the team's last N *home* games with the opponent's last N *away* games (and the other way round away from home), so teams that are much stronger at home show it. In *Team vs opponent* mode the projection is home attack × away defence ÷ the league's average for home teams (or away teams), so venue isn't counted twice. Home or away alone is half the games, so these numbers are noisier, especially early in the season. A team with no games at a venue yet falls back to the league average for that venue.
- **Ticker colours** are z-scores against all cells on screen, so the shading is relative to the fixtures you're looking at. FDR uses fixed colours (1–2 blue, 3 grey, 4–5 red).
- **DC hits**: games where the player got the +2 defensive-contribution points.
- **Understat ↔ FPL matching**: teams by name or short code, fixtures by home and away team, players by name within the team (accents and letters like ø folded, then a fuzzy match for spellings such as Yarmolyuk/Yarmoliuk). The fetch prints any player it can't match; their shots still count on team maps. To fix one, add it to `fetch/understat_names.json` as `{"<understat player id>": <fpl element id>}`.
- **Shot maps** show the attacking third (40 m); the rare longer shots are drawn on its edge. Dot area grows with xG. Own goals are left out. "In the box" uses the real penalty-area size (16.5 m × 40.3 m).
- **Starting positions** are Understat's formation slot for each start (e.g. AMR, DC); sub appearances are counted separately. This is where the player lined up, not a touch heatmap: touch-level data (SofaScore, WhoScored, FotMob) isn't freely available for reuse.

## Hosting on GitHub Pages

The workflow in `.github/workflows/update-site.yml` fetches the data on GitHub's servers and publishes `site/` to GitHub Pages, so your computer doesn't need to be on. The generated data (`site/data/`) and the cache (`fetch/cache/`) are not committed; the workflow builds them.

**When it updates.** GitHub wakes the workflow every 30 minutes. A quick check (`fetch/should_update.py`) reads the FPL fixture list and the live site's `data/meta.json`, and only runs the full update twice per gameweek:

- **before the gameweek**: if the first kickoff is an evening game (17:00 UK time or later), from 4 hours before it, which is 2½ hours before the FPL deadline. Otherwise from 20:00 UK time the evening before.
- **after the gameweek**: once every fixture of the gameweek is finished and 4 hours have passed since the last kickoff (about 2 hours after the final whistle).

Each update happens once: the check skips it if the site has been updated since it became due. Otherwise the check stops after a few seconds. GitHub's timer often runs 5–15 minutes late and can occasionally skip a run. Times are worked out in UK time, including summer time. To test the check for any moment: `python fetch/should_update.py --now 2026-10-23T15:10:00Z --updated 2026-10-20T12:00:00Z`.

**One-time setup**

1. Create an empty **public** repository on GitHub, e.g. `fplshades` (no README or .gitignore, so it doesn't conflict). Pages on a private repo needs a paid plan.
2. Push this folder to it:
   ```bash
   git remote add origin https://github.com/<your-username>/fplshades.git
   ```
   ```bash
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Go to **Actions → Update site → Run workflow** for the first deploy. The site appears at `https://<your-username>.github.io/fplshades/`.

**Good to know**

- **Manual refresh:** Actions → Update site → Run workflow, any time.
- **Inactive repos:** GitHub turns off scheduled workflows after 60 days without commits. Each update re-enables the workflow through the API to prevent that; if it's ever switched off anyway, re-enable it from the Actions tab.
- **Custom domain:** set a repository variable `SITE_URL` (e.g. `https://fplshades.com`) so the check can find `meta.json`.
- **Cost:** free for public repositories. An update takes about a minute the first time (Understat), then well under a minute; each check a few seconds.
- If the FPL API or Understat ever refuses requests from GitHub's servers, run the fetch locally and publish `site/` some other way.

## Next steps

- Blend in last season's team numbers early in the season so short form periods are less noisy (the hockey site does this with a 20-game prior). The FPL API only has the current season, so this needs another source or a saved copy of last season's `fixtures.json`.
- Price-change and transfer-trend columns (`transfers_in_event` is already in `players.json`).
