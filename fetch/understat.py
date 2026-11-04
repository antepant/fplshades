"""Shot locations and per-match creation stats from Understat, matched to FPL ids.

Understat has no official API; this reads the same JSON its pages load
(getLeagueData / getMatchData). Data is free for non-commercial use with
credit. Finished matches are cached in fetch/cache/understat/ once they are a
day old (Understat can revise xG shortly after full time).
"""
from __future__ import annotations

import difflib
import gzip
import html
import json
import re
import sys
import time
import unicodedata
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "https://understat.com"
UA = "Mozilla/5.0 (fpl-shades; personal decision-support site)"
HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache" / "understat"
OVERRIDES = HERE / "understat_names.json"   # {"<understat player id>": <fpl element id>}
POLITE_DELAY = 0.4                           # seconds between uncached requests

# Penalty box in Understat's 0–1 pitch coordinates (X towards goal, Y across).
BOX_X = 1 - 16.5 / 105
BOX_Y = (0.5 - 20.16 / 68, 0.5 + 20.16 / 68)

RESULTS = ["Goal", "SavedShot", "MissedShots", "BlockedShot", "ShotOnPost", "OwnGoal"]
SITUATIONS = ["OpenPlay", "FromCorner", "SetPiece", "DirectFreekick", "Penalty"]
BODY = ["RightFoot", "LeftFoot", "Head", "OtherBodyPart"]
US_FIELDS = ["fx", "pos", "min", "sh", "sib", "pk", "g", "xg", "npxg", "kp", "xa", "xgch", "xgbu"]
SHOT_FIELDS = ["p", "t", "fx", "min", "x", "y", "xg", "res", "sit", "body", "ast"]

# Understat team title -> FPL team name, where they differ and short codes don't line up.
TEAM_ALIASES = {
    "manchester city": "man city", "manchester united": "man utd", "newcastle united": "newcastle",
    "nottingham forest": "nott'm forest", "tottenham": "spurs", "wolverhampton wanderers": "wolves",
    "coventry": "coventry city", "hull": "hull city", "ipswich": "ipswich town",
    "leicester": "leicester city", "sheffield united": "sheffield utd", "luton": "luton town",
    "west bromwich albion": "west brom", "queens park rangers": "qpr",
}


def get(path: str):
    req = urllib.request.Request(f"{BASE}/{path}", headers={
        "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Accept-Encoding": "identity"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
            if body[:2] == b"\x1f\x8b":  # Understat gzips even when not asked to
                body = gzip.decompress(body)
            return json.loads(body)
        except Exception as e:  # noqa: BLE001 - network errors of any kind
            if attempt == 2:
                raise
            print(f"  retry understat {path}: {e}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))


# Letters NFKD doesn't reduce to ASCII.
FOLD = str.maketrans({"ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "ß": "ss", "ł": "l", "Ł": "L",
                      "đ": "d", "Đ": "D", "ı": "i", "þ": "th", "ð": "d"})


def norm(s: str) -> str:
    s = html.unescape(s or "").translate(FOLD)
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z' ]+", " ", s.replace("-", " ")).strip()


def tokens(s: str) -> set:
    return set(norm(s).replace("'", "").split())


def f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


class PlayerMatcher:
    """Match Understat players to FPL elements by team and name."""

    def __init__(self, elements: list, overrides: dict):
        self.by_team: dict[int, list] = {}
        self.all = []
        for p in elements:
            full = f'{p["first_name"]} {p["second_name"]}'
            rec = {"id": p["id"], "team": p["team"], "full": tokens(full), "web": tokens(p["web_name"]),
                   "fullstr": norm(full).replace("'", ""), "webstr": norm(p["web_name"]).replace("'", "")}
            self.by_team.setdefault(p["team"], []).append(rec)
            self.all.append(rec)
        self.overrides = {str(k): v for k, v in overrides.items()}
        self.memo: dict[str, int | None] = {}
        self.unmatched: dict[str, tuple] = {}

    @staticmethod
    def score(us: set, usstr: str, c: dict) -> int:
        if usstr in (c["fullstr"], c["webstr"]):
            return 5
        if us == c["full"]:
            return 5
        if us <= c["full"] or c["full"] <= us:
            return 4
        if c["web"] and c["web"] <= us:
            return 3
        last = usstr.split()[-1] if usstr else ""
        if last and last in c["full"]:
            return 2
        return 0

    def best(self, name: str, cands: list):
        us, usstr = tokens(name), norm(name).replace("'", "")
        scored = sorted(((self.score(us, usstr, c), c["id"]) for c in cands), reverse=True)
        if not scored or scored[0][0] == 0:
            # spelling/transliteration differences (Yarmolyuk / Yarmoliuk): fuzzy, unique, same team only
            ratios = sorted(((difflib.SequenceMatcher(None, usstr, c["fullstr"]).ratio(), c["id"]) for c in cands),
                            reverse=True)
            if ratios and ratios[0][0] >= 0.82 and (len(ratios) == 1 or ratios[1][0] < ratios[0][0] - 0.1):
                return ratios[0][1]
            return None
        if len(scored) > 1 and scored[1][0] == scored[0][0]:
            return None  # ambiguous
        return scored[0][1]

    def match(self, us_id: str, name: str, fpl_team: int | None) -> int | None:
        if us_id in self.overrides:
            return self.overrides[us_id]
        if us_id in self.memo:
            return self.memo[us_id]
        pid = self.best(name, self.by_team.get(fpl_team, [])) if fpl_team else None
        if pid is None:  # moved club since, or not in the team list: try everyone, strict match only
            us, usstr = tokens(name), norm(name).replace("'", "")
            strict = [c["id"] for c in self.all if self.score(us, usstr, c) >= 4]
            pid = strict[0] if len(strict) == 1 else None
        self.memo[us_id] = pid
        if pid is None:
            self.unmatched[us_id] = (name, fpl_team)
        return pid


def map_teams(us_teams: dict, fpl_teams: list) -> dict:
    """Understat team id -> FPL team id."""
    by_short = {t["short_name"].upper(): t["id"] for t in fpl_teams}
    by_name = {norm(t["name"]): t["id"] for t in fpl_teams}
    out = {}
    for t in us_teams.values():
        title = norm(t["title"])
        tid = by_name.get(title) or by_name.get(TEAM_ALIASES.get(title, ""))
        if tid is None:
            tid = by_short.get((t.get("short_title") or "").upper())
        if tid is None:
            print(f"  understat: no FPL team for {t['title']!r}; add it to TEAM_ALIASES", file=sys.stderr)
        else:
            out[str(t["id"])] = tid
    return out


def league_from_cache(season_start: int) -> dict | None:
    """Rebuild the season's team list and played matches from the cached match files."""
    teams, dates = {}, []
    for cfile in sorted(CACHE.glob("match_*.json")):
        md = json.loads(cfile.read_text(encoding="utf-8"))
        shots = (md.get("shots", {}).get("h") or []) + (md.get("shots", {}).get("a") or [])
        if not shots or shots[0].get("season") != str(season_start):
            continue
        side = {}
        for s in ("h", "a"):
            r = next(iter((md.get("rosters", {}).get(s) or {}).values()), None)
            if r is None:
                break
            side[s] = {"id": str(r["team_id"]), "title": shots[0][f"{s}_team"]}
            teams[side[s]["id"]] = side[s]
        if len(side) == 2:
            dates.append({"id": cfile.stem.split("_")[1], "isResult": True, "datetime": shots[0]["date"], **side})
    return {"teams": teams, "dates": dates} if dates else None


def fetch(season_start: int, boot: dict, fixtures: list) -> dict | None:
    """Return {"shots": [...], "rows": {fpl_id: [...]}, "names": [...], ...}, or None if Understat is
    down and nothing is cached. When it's down, the cached matches are used on their own."""
    t0 = time.time()
    CACHE.mkdir(parents=True, exist_ok=True)
    offline = False
    try:
        league = get(f"getLeagueData/EPL/{season_start}")
    except Exception as e:  # noqa: BLE001
        league = league_from_cache(season_start)
        if league is None:
            print(f"  understat unavailable ({e}); shot data skipped", file=sys.stderr)
            return None
        offline = True
        print(f"  understat unavailable ({e}); using {len(league['dates'])} cached matches", file=sys.stderr)

    team_map = map_teams(league["teams"], boot["teams"])
    fx_by_pair = {(x["team_h"], x["team_a"]): x["id"] for x in fixtures}
    overrides = json.loads(OVERRIDES.read_text(encoding="utf-8")) if OVERRIDES.exists() else {}
    matcher = PlayerMatcher(boot["elements"], overrides)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

    shots_out, rows, names, name_idx, done_fx = [], {}, [], {}, []
    n_new = n_failed = 0
    for m in league["dates"]:
        if not m.get("isResult"):
            continue
        h, a = team_map.get(str(m["h"]["id"])), team_map.get(str(m["a"]["id"]))
        fx = fx_by_pair.get((h, a))
        if fx is None:
            print(f"  understat: no FPL fixture for {m['h']['title']} v {m['a']['title']}", file=sys.stderr)
            continue
        cfile = CACHE / f"match_{m['id']}.json"
        if cfile.exists():
            md = json.loads(cfile.read_text(encoding="utf-8"))
        elif offline:
            continue
        else:
            try:
                md = get(f"getMatchData/{m['id']}")
            except Exception as e:  # noqa: BLE001 - skip this match, keep the rest
                print(f"  understat: match {m['id']} skipped ({e})", file=sys.stderr)
                n_failed += 1
                continue
            n_new += 1
            time.sleep(POLITE_DELAY)
            played = datetime.strptime(m["datetime"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            if played < cutoff:
                cfile.write_text(json.dumps(md), encoding="utf-8")
        done_fx.append(fx)

        side_team = {"h": h, "a": a}
        # per-player per-match rows from the rosters
        per = {}
        for side in ("h", "a"):
            for r in (md.get("rosters", {}).get(side) or {}).values():
                pid = matcher.match(str(r["player_id"]), r["player"], side_team[side])
                if pid is None:
                    continue
                per[(pid, side)] = {"fx": fx, "pos": r.get("position") or "", "min": int(f(r["time"])),
                                    "sh": int(f(r["shots"])), "sib": 0, "pk": 0, "g": int(f(r["goals"])),
                                    "xg": f(r["xG"]), "npxg": f(r["xG"]), "kp": int(f(r["key_passes"])),
                                    "xa": f(r["xA"]), "xgch": f(r["xGChain"]), "xgbu": f(r["xGBuildup"])}
        # shots
        for side in ("h", "a"):
            for s in md.get("shots", {}).get(side) or []:
                pid = matcher.match(str(s["player_id"]), s["player"], side_team[side])
                if pid is None:
                    key = html.unescape(s["player"])
                    if key not in name_idx:
                        name_idx[key] = len(names)
                        names.append(key)
                    p_ref = -(name_idx[key] + 1)
                else:
                    p_ref = pid
                x, y, xg = f(s["X"]), f(s["Y"]), f(s["xG"])
                res, sit, body = s.get("result", ""), s.get("situation", ""), s.get("shotType", "")
                ast = None
                if s.get("player_assisted"):
                    ast = matcher.best(s["player_assisted"], matcher.by_team.get(side_team[side], []))
                shots_out.append([p_ref, side_team[side], fx, int(f(s["minute"])), round(x, 3), round(y, 3),
                                  round(xg, 3), RESULTS.index(res) if res in RESULTS else -1,
                                  SITUATIONS.index(sit) if sit in SITUATIONS else -1,
                                  BODY.index(body) if body in BODY else -1, ast or 0])
                rec = per.get((pid, side)) if pid else None
                if rec:
                    if x >= BOX_X and BOX_Y[0] <= y <= BOX_Y[1]:
                        rec["sib"] += 1
                    if sit == "Penalty":
                        rec["npxg"] -= xg
                        rec["pk"] += 1
        for (pid, _side), rec in per.items():
            rec["npxg"] = max(0.0, rec["npxg"])
            rows.setdefault(pid, []).append(
                [rec[k] if not isinstance(rec[k], float) else round(rec[k], 3) for k in US_FIELDS])

    unmatched_with_time = sorted({n for _id, (n, _t) in matcher.unmatched.items()})
    if unmatched_with_time:
        print(f"  understat: {len(unmatched_with_time)} players not matched to FPL "
              f"(their shots still count for team maps): {', '.join(unmatched_with_time[:15])}"
              f"{' …' if len(unmatched_with_time) > 15 else ''}")
        print(f"  add fixes to {OVERRIDES.name} as {{\"<understat id>\": <fpl id>}}; ids:",
              ", ".join(f"{k}={v[0]}" for k, v in list(matcher.unmatched.items())[:15]))
    print(f"  understat: {len(shots_out)} shots, {n_new} matches downloaded"
          f"{f', {n_failed} failed' if n_failed else ''}, {time.time() - t0:.1f}s")
    return {"shots": shots_out, "rows": rows, "names": names, "unmatched": len(unmatched_with_time),
            "fixtures": done_fx}
