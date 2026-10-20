"""Fetch FPL data and write the JSON files the static site reads.

Usage:  python fetch/fetch_data.py

Standard library only. Writes to site/data/ and caches finished gameweeks
in fetch/cache/ so later runs only download what has changed.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import understat

BASE = "https://fantasy.premierleague.com/api"
ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "fetch" / "cache"
OUT = ROOT / "site" / "data"
UA = "Mozilla/5.0 (fpl-shades; personal decision-support site)"

# Order of the per-fixture stat rows written for each player (see players.json "fields").
FIELDS = ["gw", "fx", "min", "pts", "g", "a", "xg", "xa", "xgc", "cs", "gc",
          "dc", "dch", "bon", "bps", "sv", "st", "yc", "rc", "og", "pm", "ps"]


def get(path: str, retries: int = 3):
    url = f"{BASE}/{path}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == retries - 1:
                raise
            print(f"  retry {url}: {e}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))


def cached(name: str, path: str, keep: bool):
    """Return JSON from cache if present, else fetch it (and cache it if keep)."""
    f = CACHE / name
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    data = get(path)
    if keep:
        CACHE.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(data), encoding="utf-8")
    return data


def num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def row_from_stats(gw: int, fx: int, s: dict, dc_hit: int) -> list:
    """One compact stat row. `s` is either a live 'stats' dict or an element-summary history row."""
    vals = {
        "gw": gw, "fx": fx,
        "min": int(s.get("minutes", 0)),
        "pts": int(s.get("total_points", 0)),
        "g": int(s.get("goals_scored", 0)),
        "a": int(s.get("assists", 0)),
        "xg": round(num(s.get("expected_goals")), 2),
        "xa": round(num(s.get("expected_assists")), 2),
        "xgc": round(num(s.get("expected_goals_conceded")), 2),
        "cs": int(s.get("clean_sheets", 0)),
        "gc": int(s.get("goals_conceded", 0)),
        "dc": int(s.get("defensive_contribution", 0)),
        "dch": dc_hit,
        "bon": int(s.get("bonus", 0)),
        "bps": int(s.get("bps", 0)),
        "sv": int(s.get("saves", 0)),
        "st": int(s.get("starts", 0)),
        "yc": int(s.get("yellow_cards", 0)),
        "rc": int(s.get("red_cards", 0)),
        "og": int(s.get("own_goals", 0)),
        "pm": int(s.get("penalties_missed", 0)),
        "ps": int(s.get("penalties_saved", 0)),
    }
    return [vals[k] for k in FIELDS]


def main() -> None:
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    print("bootstrap-static, fixtures ...")
    boot = get("bootstrap-static/")
    fixtures = get("fixtures/")

    events = {e["id"]: e for e in boot["events"]}
    teams = {t["id"]: t for t in boot["teams"]}
    elements = {p["id"]: p for p in boot["elements"]}
    fx_by_id = {f["id"]: f for f in fixtures}

    # Gameweeks with at least one started fixture have live data worth reading.
    started_gws = sorted({f["event"] for f in fixtures if f["event"] and f["started"]})

    rows: dict[int, list] = {pid: [] for pid in elements}
    # team xG per fixture: {fixture_id: {"h": xg, "a": xg}}
    fx_xg: dict[int, dict] = {}

    for gw in started_gws:
        ev = events[gw]
        done = bool(ev.get("finished") and ev.get("data_checked"))
        live = cached(f"live_{gw}.json", f"event/{gw}/live/", keep=done)
        n_dgw = 0
        for el in live["elements"]:
            pid = el["id"]
            p = elements.get(pid)
            if p is None:
                continue
            explain = el.get("explain") or []
            fids = [e["fixture"] for e in explain]
            if not fids or el["stats"].get("minutes", 0) == 0 and not el["stats"].get("total_points", 0):
                continue

            if len(fids) == 1:
                fid = fids[0]
                dc_hit = int(any(s["identifier"] == "defensive_contribution" and s["points"] > 0
                                 for s in explain[0]["stats"]))
                rows[pid].append(row_from_stats(gw, fid, el["stats"], dc_hit))
                f = fx_by_id.get(fid)
                if f:
                    side = "h" if f["team_h"] == p["team"] else "a" if f["team_a"] == p["team"] else None
                    if side:  # unknown side = player transferred since; skip for team totals
                        d = fx_xg.setdefault(fid, {"h": 0.0, "a": 0.0})
                        d[side] += num(el["stats"].get("expected_goals"))
                continue

            # Double gameweek: live stats are summed across fixtures, so split them
            # with the player's per-fixture history.
            n_dgw += 1
            hist = cached(f"element_{pid}_gw{gw}.json", f"element-summary/{pid}/", keep=done)["history"]
            dc_by_fx = {e["fixture"]: int(any(s["identifier"] == "defensive_contribution" and s["points"] > 0
                                              for s in e["stats"])) for e in explain}
            for h in hist:
                if h["round"] != gw:
                    continue
                fid = h["fixture"]
                rows[pid].append(row_from_stats(gw, fid, h, dc_by_fx.get(fid, 0)))
                d = fx_xg.setdefault(fid, {"h": 0.0, "a": 0.0})
                d["h" if h["was_home"] else "a"] += num(h.get("expected_goals"))
        note = f", {n_dgw} double-GW players split" if n_dgw else ""
        print(f"  GW{gw}: {'final' if done else 'provisional'}{note}")

    # ---- fixtures.json
    out_fx = []
    for f in fixtures:
        xg = fx_xg.get(f["id"])
        out_fx.append({
            "id": f["id"], "gw": f["event"], "ko": f["kickoff_time"],
            "h": f["team_h"], "a": f["team_a"],
            "hs": f["team_h_score"], "as": f["team_a_score"],
            "fin": bool(f["finished"] or f["finished_provisional"]),
            "live": bool(f["started"] and not (f["finished"] or f["finished_provisional"])),
            "xh": round(xg["h"], 2) if xg and f["started"] else None,
            "xa": round(xg["a"], 2) if xg and f["started"] else None,
            "dh": f["team_h_difficulty"], "da": f["team_a_difficulty"],
        })

    # ---- teams.json
    out_teams = [{"id": t["id"], "short": t["short_name"], "name": t["name"],
                  "strength": t.get("strength")} for t in boot["teams"]]

    # ---- Understat shots and per-match creation stats (optional; skipped if unreachable)
    first = boot["events"][0]["deadline_time"][:4]
    print("understat ...")
    us = understat.fetch(int(first), boot, fixtures)
    us_rows = us["rows"] if us else {}

    # ---- players.json
    pos = {et["id"]: et["singular_name_short"] for et in boot["element_types"]}
    out_players = []
    for pid, p in elements.items():
        if p.get("removed"):
            continue
        out_players.append({
            "id": pid, "name": p["web_name"],
            "full": f'{p["first_name"]} {p["second_name"]}'.strip(),
            "team": p["team"], "pos": pos.get(p["element_type"], "?"),
            "price": p["now_cost"] / 10, "own": num(p["selected_by_percent"]),
            "status": p["status"], "news": p["news"] or "",
            "chance": p["chance_of_playing_next_round"],
            "form": num(p["form"]), "ep": num(p["ep_next"]),
            "pen": p.get("penalties_order"), "fk": p.get("direct_freekicks_order"),
            "ck": p.get("corners_and_indirect_freekicks_order"),
            "tin": p.get("transfers_in_event", 0), "tout": p.get("transfers_out_event", 0),
            "log": rows[pid],
            "us": us_rows.get(pid, []),
        })

    # ---- meta.json
    cur = next((e for e in boot["events"] if e["is_current"]), None)
    nxt = next((e for e in boot["events"] if e["is_next"]), None)
    meta = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "season": f"{first}/{int(first) + 1 - 2000:02d}",
        "current_gw": cur["id"] if cur else None,
        "next_gw": nxt["id"] if nxt else None,
        "events": [{"id": e["id"], "deadline": e["deadline_time"], "finished": e["finished"]}
                   for e in boot["events"]],
        "understat": bool(us),
    }

    def write(name, obj):
        (OUT / name).write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")

    write("fixtures.json", out_fx)
    write("teams.json", out_teams)
    write("players.json", {"fields": FIELDS, "usFields": understat.US_FIELDS, "players": out_players})
    write("shots.json", {
        "fields": understat.SHOT_FIELDS, "results": understat.RESULTS,
        "situations": understat.SITUATIONS, "body": understat.BODY,
        "names": us["names"] if us else [], "shots": us["shots"] if us else [],
    })
    write("meta.json", meta)
    print(f"done in {time.time() - t0:.1f}s: {len(out_players)} players, "
          f"{len(started_gws)} gameweeks with data, written to {OUT}")


if __name__ == "__main__":
    main()
