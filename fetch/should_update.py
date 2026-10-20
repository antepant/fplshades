"""Decide whether the scheduled workflow should refresh the site right now.

GitHub Actions wakes this up every 30 minutes. It reads the FPL fixture list and asks for an
update twice per gameweek:

  pre-GW:   before the gameweek's first kickoff (the FPL deadline is 90 min before it).
            Evening first kickoff (EVENING_FROM UK time or later): PRE_EVENING before kickoff.
            Earlier kickoff: at PRE_DAY_BEFORE UK time the evening before.
  post-GW:  every fixture of the gameweek is finished and POST_GW has passed since its
            last kickoff (about two hours after the final whistle).

Each is due once: "already updated" is read from the deployed site's data/meta.json, so no
state is kept here.

Usage:  python fetch/should_update.py [--now 2026-10-23T12:00:00Z] [--meta-url URL] [--force]
Prints run=true|false and kind=pre|post|manual, and also writes them to $GITHUB_OUTPUT.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import urllib.request

FIXTURES = "https://fantasy.premierleague.com/api/fixtures/"
EVENING_FROM = 17                     # UK hour; first kickoffs from this hour count as evening games
PRE_EVENING = dt.timedelta(hours=4)   # evening kickoff: update this long before it
PRE_DAY_BEFORE = 20                   # earlier kickoff: update at this UK hour the day before
POST_GW = dt.timedelta(hours=4)       # after the last kickoff (≈ 2 h of match + 2 h)
UTC = dt.timezone.utc


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (fpl-shades update check)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_utc(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(UTC)


def last_sunday(year, month):
    d = dt.date(year, month + 1, 1) - dt.timedelta(days=1) if month < 12 else dt.date(year, 12, 31)
    return d - dt.timedelta(days=(d.weekday() + 1) % 7)


def uk_offset(t):
    """UK offset from UTC at UTC time t: BST from 01:00 UTC on the last Sunday of March to the last Sunday of October."""
    start = dt.datetime.combine(last_sunday(t.year, 3), dt.time(1), UTC)
    end = dt.datetime.combine(last_sunday(t.year, 10), dt.time(1), UTC)
    return dt.timedelta(hours=1) if start <= t < end else dt.timedelta(0)


def pre_due(first_ko):
    local = first_ko + uk_offset(first_ko)
    if local.hour >= EVENING_FROM:
        return first_ko - PRE_EVENING
    evening_before = dt.datetime.combine(local.date() - dt.timedelta(days=1), dt.time(PRE_DAY_BEFORE), UTC)
    return evening_before - uk_offset(first_ko - dt.timedelta(days=1))


def last_update(meta_url):
    """When the live site was last generated, or None if it can't be read (e.g. first deploy)."""
    if not meta_url:
        return None
    try:
        return parse_utc(get_json(meta_url)["updated"])
    except Exception as e:  # noqa: BLE001
        print(f"could not read {meta_url}: {e}")
        return None


def decide(now, fixtures, updated):
    """Return (kind, reason) for the update that is due, or (None, reason)."""
    gws = {}
    for f in fixtures:
        if f.get("event") and f.get("kickoff_time"):
            gws.setdefault(f["event"], []).append(f)
    upcoming = []
    for gw, fs in sorted(gws.items()):
        kos = [parse_utc(f["kickoff_time"]) for f in fs]
        first, last = min(kos), max(kos)
        pre = pre_due(first)
        if pre <= now < first and (updated is None or updated < pre):
            return "pre", f"GW{gw}: first kickoff {first:%a %d %b %H:%M} UTC, update due from {pre:%a %H:%M} UTC"
        post = last + POST_GW
        done = all(f.get("finished") or f.get("finished_provisional") for f in fs)
        if done and now >= post and (updated is None or updated < post):
            return "post", f"GW{gw}: all fixtures finished, last kickoff {last:%a %d %b %H:%M} UTC"
        if now < pre:
            upcoming.append(f"next: GW{gw} pre-GW update from {pre:%a %d %b %H:%M} UTC")
        elif not done or now < post:
            upcoming.append(f"GW{gw} post-GW update once all games are finished, from {post:%a %d %b %H:%M} UTC")
    return None, "nothing due; " + (upcoming[0] if upcoming else "season over")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--now", help="pretend it's this UTC time (for testing)")
    ap.add_argument("--meta-url", default=os.environ.get("SITE_META_URL"))
    ap.add_argument("--updated", help="pretend the site was last updated at this UTC time (for testing)")
    ap.add_argument("--force", action="store_true", default=os.environ.get("FORCE") == "true")
    args = ap.parse_args()

    now = parse_utc(args.now) if args.now else dt.datetime.now(UTC)
    if args.force:
        kind, reason = "manual", "forced"
    else:
        updated = parse_utc(args.updated) if args.updated else last_update(args.meta_url)
        print(f"site last updated: {updated or 'unknown'}")
        kind, reason = decide(now, get_json(FIXTURES), updated)

    run = kind is not None
    print(f"run={str(run).lower()} kind={kind or ''} ({reason})")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"run={str(run).lower()}\nkind={kind or ''}\n")


if __name__ == "__main__":
    main()
