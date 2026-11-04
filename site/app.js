"use strict";

// ---------------------------------------------------------------- state & utils
const D = {};          // loaded data
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const f1 = (x) => (x == null || !isFinite(x) ? "–" : x.toFixed(1));
const f2 = (x) => (x == null || !isFinite(x) ? "–" : x.toFixed(2));

const store = {
  get(k, def) { try { const v = localStorage.getItem("fplshades." + k); return v ? { ...def, ...JSON.parse(v) } : { ...def }; } catch { return { ...def }; } },
  set(k, v) { try { localStorage.setItem("fplshades." + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

function fmtDate(iso, opts = { weekday: "short", day: "numeric", month: "short" }) {
  return iso ? new Date(iso).toLocaleDateString("en-GB", opts) : "TBC";
}
function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
}

// Diverging colour: t in [-1, 1], +1 = favourable (blue), -1 = unfavourable (red).
function hexToRgb(h) { h = h.trim().replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
let PAL = null;
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  PAL = { good: hexToRgb(cs.getPropertyValue("--good")), mid: hexToRgb(cs.getPropertyValue("--mid")), bad: hexToRgb(cs.getPropertyValue("--bad")) };
}
function heat(t) {
  if (t == null || !isFinite(t)) return "";
  t = clamp(t, -1, 1);
  const pole = t >= 0 ? PAL.good : PAL.bad;
  const k = Math.pow(Math.abs(t), 0.85) * 0.92;
  const rgb = PAL.mid.map((m, i) => Math.round(m + (pole[i] - m) * k));
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  const ink = lum < 0.55 ? "#fff" : "#0b0b0b";
  return `background:rgb(${rgb.join(",")});color:${ink}`;
}
const fdrT = (d) => (3 - d) / 2;

// ---------------------------------------------------------------- data model
async function load() {
  const get = (f) => fetch(`data/${f}?v=${Date.now() >> 16}`).then((r) => { if (!r.ok) throw new Error(f + " " + r.status); return r.json(); });
  const [meta, teams, fixtures, players] = await Promise.all([get("meta.json"), get("teams.json"), get("fixtures.json"), get("players.json")]);
  Object.assign(D, { meta, teams, fixtures });
  D.team = Object.fromEntries(teams.map((t) => [t.id, t]));
  D.fields = players.fields;
  const fi = Object.fromEntries(players.fields.map((f, i) => [f, i]));
  D.fi = fi;
  D.ui = Object.fromEntries((players.usFields || []).map((f, i) => [f, i]));
  D.players = players.players;
  D.fx = Object.fromEntries(fixtures.map((f) => [f.id, f]));
  D.events = meta.events;
  D.eventById = Object.fromEntries(meta.events.map((e) => [e.id, e]));

  // GWs that have player data (any started fixture)
  D.dataGws = [...new Set(fixtures.filter((f) => f.gw && (f.fin || f.live)).map((f) => f.gw))].sort((a, b) => a - b);
  // First GW to look ahead from: the first GW with an unplayed fixture after the current one
  const cur = meta.current_gw || 0;
  const curDone = fixtures.filter((f) => f.gw === cur).every((f) => f.fin);
  D.startGw = meta.next_gw || (curDone ? cur + 1 : cur) || 1;
  if (!curDone && cur) D.startGw = cur;

  // Finished games per team, in kickoff order
  D.games = Object.fromEntries(teams.map((t) => [t.id, []]));
  for (const f of fixtures.filter((f) => f.fin).sort((a, b) => a.ko.localeCompare(b.ko))) {
    D.games[f.h].push({ fx: f, gw: f.gw, opp: f.a, home: true, gf: f.hs, ga: f.as, xgf: f.xh, xga: f.xa });
    D.games[f.a].push({ fx: f, gw: f.gw, opp: f.h, home: false, gf: f.as, ga: f.hs, xgf: f.xa, xga: f.xh });
  }
  // Upcoming / all fixtures by team by GW
  D.byTeamGw = Object.fromEntries(teams.map((t) => [t.id, {}]));
  for (const f of fixtures) {
    if (!f.gw) continue;
    (D.byTeamGw[f.h][f.gw] ||= []).push({ fx: f, opp: f.a, home: true, fdr: f.dh });
    (D.byTeamGw[f.a][f.gw] ||= []).push({ fx: f, opp: f.h, home: false, fdr: f.da });
  }
  D.unscheduled = fixtures.filter((f) => !f.gw);

  // League scoring per game overall and by venue, from every finished fixture this season
  const fin = fixtures.filter((f) => f.fin && f.xh != null);
  const n = fin.length || 1;
  const hx = sum(fin.map((f) => f.xh)) / n, ax = sum(fin.map((f) => f.xa)) / n;
  const hg = sum(fin.map((f) => f.hs)) / n, ag = sum(fin.map((f) => f.as)) / n;
  D.league = {
    xg: { mean: (hx + ax) / 2 || 1.35, home: hx || 1.45, away: ax || 1.25 },
    g: { mean: (hg + ag) / 2 || 1.35, home: hg || 1.45, away: ag || 1.25 },
    n: fin.length,
  };
}

const short = (id, home) => { const s = D.team[id]?.short ?? "?"; return home ? s.toUpperCase() : s.toLowerCase(); };

/** Per-game rates for a team over its last `n` games (0 = all), optionally home/away only. */
function teamRates(teamId, n, venue = "all") {
  let g = D.games[teamId];
  if (venue !== "all") g = g.filter((x) => x.home === (venue === "home"));
  if (n) g = g.slice(-n);
  const gp = g.length;
  const tot = {
    gp, gf: sum(g.map((x) => x.gf)), ga: sum(g.map((x) => x.ga)),
    xgf: sum(g.map((x) => x.xgf ?? 0)), xga: sum(g.map((x) => x.xga ?? 0)),
    w: g.filter((x) => x.gf > x.ga).length, d: g.filter((x) => x.gf === x.ga).length,
    l: g.filter((x) => x.gf < x.ga).length, cs: g.filter((x) => x.ga === 0).length,
  };
  // With no games yet, fall back to the league average for that venue
  const pg = (v, m) => (gp ? v / gp : m);
  const fb = (L, side) => (venue === "all" ? L.mean : L[side]);
  const us = venue === "away" ? "away" : "home", them = venue === "away" ? "home" : "away";
  return { ...tot, venue, games: g, gfpg: pg(tot.gf, fb(D.league.g, us)), gapg: pg(tot.ga, fb(D.league.g, them)), xgfpg: pg(tot.xgf, fb(D.league.xg, us)), xgapg: pg(tot.xga, fb(D.league.xg, them)) };
}

// ---------------------------------------------------------------- tooltip
const tip = $("#tip");
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (!el) { tip.hidden = true; return; }
  tip.innerHTML = el.getAttribute("data-tip");
  tip.hidden = false;
});
document.addEventListener("mousemove", (e) => {
  if (tip.hidden) return;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > innerHeight - 8) y = e.clientY - h - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
});
document.addEventListener("scroll", () => (tip.hidden = true), true);

// ---------------------------------------------------------------- small UI builders
function seg(name, options, value) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(value) ? "on" : ""}">${l}</button>`).join("")}</div>`;
}
function selectEl(name, options, value) {
  return `<select data-sel="${name}">${options.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
}
/** Wire up seg buttons, selects, checkboxes and inputs to a state object. */
function bindControls(root, st, key, rerender) {
  const save = () => { st.startFor = D.startGw; store.set(key, st); rerender(); };
  root.querySelectorAll("[data-seg]").forEach((s) => s.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const v = b.dataset.v; st[s.dataset.seg] = isNaN(+v) || v === "" ? v : +v; save();
  }));
  root.querySelectorAll("[data-sel]").forEach((s) => s.addEventListener("change", () => {
    const v = s.value; st[s.dataset.sel] = isNaN(+v) || v === "" ? v : +v; save();
  }));
  root.querySelectorAll("[data-chk]").forEach((c) => c.addEventListener("change", () => { st[c.dataset.chk] = c.checked; save(); }));
  root.querySelectorAll("[data-inp]").forEach((c) => c.addEventListener("input", () => {
    st[c.dataset.inp] = c.type === "number" ? (c.value === "" ? "" : +c.value) : c.value;
    store.set(key, st);
    rerender(true);
  }));
}
function sortHeader(cols, st) {
  return cols.map((c) => {
    const on = st.sort === c.key;
    const cls = [c.cls || "", c.sortable === false ? "" : "sortable"].join(" ");
    return `<th class="${cls}" data-sort="${c.key}" ${c.title ? `data-tip="${esc(c.title)}"` : ""}>${c.label}${on ? `<span class="arr">${st.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`;
  }).join("");
}
function bindSort(root, st, key, rerender, defaultDir = () => -1) {
  root.querySelectorAll("th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (st.sort === k) st.dir = -st.dir; else { st.sort = k; st.dir = defaultDir(k); }
    store.set(key, st); rerender();
  }));
}
function statusFlag(p) {
  if (p.status === "a") return "";
  const ch = p.chance;
  const cls = p.status === "d" && ch != null && ch >= 50 ? "warn" : p.status === "d" ? "warn" : "crit";
  const label = ch != null ? ch + "%" : p.status === "s" ? "S" : p.status === "u" ? "U" : p.status === "n" ? "N" : "!";
  return `<span class="flag ${cls}" data-tip="${esc(p.news || "Unavailable")}">${label}</span>`;
}
function nextFixtures(teamId, n, from = D.startGw) {
  const out = [];
  for (let gw = from; gw < from + n && gw <= 38; gw++) {
    const fs = D.byTeamGw[teamId][gw] || [];
    if (!fs.length) out.push(`<span class="chip cell blank" style="display:inline-block;padding:1px 6px" data-tip="GW${gw}: no fixture">–</span>`);
    for (const f of fs) out.push(`<span class="chip" style="${heat(fdrT(f.fdr))}" data-tip="GW${gw}: ${esc(D.team[f.opp].name)} (${f.home ? "H" : "A"}) · FDR ${f.fdr}<br>${fmtDate(f.fx.ko)} ${fmtTime(f.fx.ko)}">${short(f.opp, f.home)}</span>`);
  }
  return `<span class="chips">${out.join("")}</span>`;
}

// ---------------------------------------------------------------- PLAYERS
const P_DEF = { win: "season", from: 1, to: 38, pos: "ALL", team: 0, maxp: "", minm: 90, q: "", per90: false, cols: "fpl", sort: "xgi", dir: -1, limit: 100 };
const P_COLS = [
  { key: "price", label: "£", title: "Current price", dec: 1, raw: true },
  { key: "own", label: "Sel%", title: "Selected by % of managers", dec: 1, raw: true },
  { key: "min", label: "Min", title: "Minutes played", dec: 0, no90: true },
  { key: "pts", label: "Pts", title: "FPL points", dec: 0 },
  { key: "g", label: "G", title: "Goals", dec: 0, cls: "sep" },
  { key: "xg", label: "xG", title: "Expected goals", dec: 2 },
  { key: "a", label: "A", title: "Assists (FPL)", dec: 0 },
  { key: "xa", label: "xA", title: "Expected assists", dec: 2 },
  { key: "gi", label: "GI", title: "Goals + assists", dec: 0 },
  { key: "xgi", label: "xGI", title: "xG + xA", dec: 2 },
  { key: "dgi", label: "GI−xGI", title: "Goal involvements minus xGI. Positive = over-performing (may regress)", dec: 2 },
  { key: "xgc", label: "xGC", title: "Expected goals conceded while on the pitch", dec: 2, cls: "sep" },
  { key: "cs", label: "CS", title: "Clean sheets (FPL definition, 60+ min)", dec: 0 },
  { key: "dc", label: "DC", title: "Defensive contributions (CBIT for DEF, CBIRT for MID/FWD)", dec: 0 },
  { key: "dch", label: "DC hits", title: "Matches where the defensive-contribution threshold was reached (+2 pts)", dec: 0 },
  { key: "sv", label: "Sv", title: "Saves", dec: 0 },
  { key: "bon", label: "Bon", title: "Bonus points", dec: 0, cls: "sep" },
  { key: "bps", label: "BPS", title: "Bonus point system score", dec: 0 },
];

// Shooting & creation columns come from Understat (its own xG model, so its xG differs a little from FPL's).
const P_COLS_US = [
  { key: "price", label: "£", title: "Current price", dec: 1, raw: true },
  { key: "min", label: "Min", title: "Minutes played", dec: 0, no90: true },
  { key: "pts", label: "Pts", title: "FPL points", dec: 0 },
  { key: "sh", label: "Sh", title: "Shots (Understat)", dec: 0, cls: "sep" },
  { key: "sib", label: "SiB", title: "Shots from inside the penalty box", dec: 0 },
  { key: "boxpct", label: "Box%", title: "Share of shots taken inside the box", dec: 0, raw: true },
  { key: "g", label: "G", title: "Goals", dec: 0 },
  { key: "usxg", label: "xG", title: "Expected goals (Understat model, penalties included)", dec: 2 },
  { key: "npxg", label: "npxG", title: "Non-penalty xG (Understat)", dec: 2 },
  { key: "xgsh", label: "xG/Sh", title: "Average xG per shot (non-penalty): shot quality", dec: 2, raw: true },
  { key: "kp", label: "KP", title: "Key passes: passes leading to a shot (Understat)", dec: 0, cls: "sep" },
  { key: "usxa", label: "xA", title: "Expected assists (Understat model)", dec: 2 },
  { key: "npxgi", label: "npxG+xA", title: "Non-penalty xG + xA (Understat)", dec: 2 },
  { key: "xgch", label: "xGChain", title: "xG of every possession the player was involved in", dec: 2, cls: "sep" },
  { key: "xgbu", label: "xGBuildup", title: "xGChain without the shot and the key pass: involvement earlier in the move", dec: 2 },
];

/** Min minutes for the current window. Each window keeps its own value, so a season-sized
 *  threshold doesn't empty the table on Last 3. (Older saves had one `minm`; it becomes the season's.) */
function minMinutes(st) {
  return st.minmBy?.[st.win] ?? (st.win === "season" ? st.minm : P_DEF.minm);
}
function windowGws(st) {
  const g = D.dataGws;
  if (st.win === "season") return new Set(g);
  if (st.win === "custom") return new Set(g.filter((x) => x >= st.from && x <= st.to));
  return new Set(g.slice(-st.win));
}
function aggPlayer(p, gws) {
  const fi = D.fi, a = { min: 0, pts: 0, g: 0, a: 0, xg: 0, xa: 0, xgc: 0, cs: 0, dc: 0, dch: 0, sv: 0, bon: 0, bps: 0, st: 0, apps: 0 };
  for (const r of p.log) {
    if (!gws.has(r[fi.gw])) continue;
    for (const k of ["min", "pts", "g", "a", "xg", "xa", "xgc", "cs", "dc", "dch", "sv", "bon", "bps", "st"]) a[k] += r[fi[k]];
    if (r[fi.min] > 0) a.apps++;
  }
  a.gi = a.g + a.a; a.xgi = a.xg + a.xa; a.dgi = a.gi - a.xgi;
  a.price = p.price; a.own = p.own;
  // Understat rows: matched to gameweeks through the FPL fixture id
  const ui = D.ui;
  Object.assign(a, { sh: 0, sib: 0, pk: 0, usxg: 0, npxg: 0, kp: 0, usxa: 0, xgch: 0, xgbu: 0 });
  for (const r of p.us || []) {
    if (!gws.has(D.fx[r[ui.fx]]?.gw)) continue;
    a.sh += r[ui.sh]; a.sib += r[ui.sib]; a.pk += r[ui.pk]; a.usxg += r[ui.xg]; a.npxg += r[ui.npxg];
    a.kp += r[ui.kp]; a.usxa += r[ui.xa]; a.xgch += r[ui.xgch]; a.xgbu += r[ui.xgbu];
  }
  a.npxgi = a.npxg + a.usxa;
  a.boxpct = a.sh ? (a.sib / a.sh) * 100 : 0;
  a.xgsh = a.sh - a.pk > 0 ? a.npxg / (a.sh - a.pk) : 0;
  return a;
}

function renderPlayers(fast) {
  const st = store.get("players", P_DEF);
  const main = $("#main");
  const gwOpts = D.dataGws.map((g) => [g, "GW" + g]);
  if (!fast || !$("#pTable")) {
    main.innerHTML = `
      <h1>Players</h1>
      <p class="lede">Season or recent-form stats for every player. Click a column to sort and a player for their gameweek log. Hover a column header for its definition.</p>
      <div class="controls">
        <div class="ctl"><span class="lbl">Window</span>${seg("win", [["season", "Season"], [6, "Last 6"], [3, "Last 3"], ["custom", "GW range"]], st.win)}</div>
        ${st.win === "custom" ? `<div class="ctl"><span class="lbl">From – to</span><div>${selectEl("from", gwOpts, st.from)} ${selectEl("to", gwOpts, Math.min(st.to, D.dataGws.at(-1)))}</div></div>` : ""}
        <div class="ctl"><span class="lbl">Position</span>${seg("pos", [["ALL", "All"], ["GKP", "GK"], ["DEF", "DEF"], ["MID", "MID"], ["FWD", "FWD"]], st.pos)}</div>
        <div class="ctl"><span class="lbl">Team</span>${selectEl("team", [[0, "All teams"], ...[...D.teams].sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.id, t.name])], st.team)}</div>
        <div class="ctl"><label for="maxp">Max £</label><input id="maxp" type="number" step="0.5" min="3.5" data-inp="maxp" value="${st.maxp}"></div>
        <div class="ctl"><label for="minm" data-tip="Remembered separately for each window">Min minutes</label><input id="minm" type="number" step="45" min="0" value="${minMinutes(st)}"></div>
        <div class="ctl"><span class="lbl">Columns</span>${seg("cols", [["fpl", "FPL"], ["us", "Shooting & creation"]], st.cols)}</div>
        <div class="ctl"><span class="lbl">Values</span>${seg("per90", [["false", "Totals"], ["true", "Per 90"]], String(st.per90))}</div>
        <div class="ctl"><label for="q">Search</label><input id="q" type="search" placeholder="Player name" data-inp="q" value="${esc(st.q)}"></div>
      </div>
      <div class="tablewrap"><table class="grid" id="pTable"></table></div>
      <div class="more" id="pMore"></div>
      <p class="note">Per 90 divides counting stats by minutes played × 90. Players with too few minutes give noisy per-90 numbers, so raise Min minutes when using it. Next 5: official FPL difficulty, upper case = home. Shooting &amp; creation data: <a href="https://understat.com" target="_blank" rel="noopener">Understat</a>.</p>
      ${st.cols === "us" ? usGapNote(windowGws(st)) : ""}`;
    bindControls(main, st, "players", (f) => renderPlayers(f));
    // seg buttons for per90 send "true"/"false" strings
    $("#minm").addEventListener("input", (e) => {
      st.minmBy = { ...st.minmBy, [st.win]: e.target.value === "" ? 0 : +e.target.value };
      store.set("players", st);
      renderPlayers(true);
    });
  }
  const per90 = st.per90 === true || st.per90 === "true";
  const COLS = st.cols === "us" ? P_COLS_US : P_COLS;
  if (!["name", "team"].includes(st.sort) && !COLS.some((c) => c.key === st.sort)) Object.assign(st, { sort: st.cols === "us" ? "npxgi" : "xgi", dir: -1 });
  const gws = windowGws(st);
  const q = (st.q || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  let rows = D.players
    .filter((p) => (st.pos === "ALL" || p.pos === st.pos) && (!st.team || p.team === st.team) && (st.maxp === "" || p.price <= st.maxp))
    .filter((p) => !q || (p.name + " " + p.full).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(q))
    .map((p) => ({ p, a: aggPlayer(p, gws) }))
    .filter((r) => q || r.a.min > 0);
  const minm = minMinutes(st);
  const mostMin = Math.max(0, ...rows.map((r) => r.a.min));
  if (!q) rows = rows.filter((r) => r.a.min >= minm);
  const val = (r, c) => {
    const v = c.key === "name" ? r.p.name : c.key === "team" ? D.team[r.p.team].short : r.a[c.key];
    return per90 && !c.raw && !c.no90 && typeof v === "number" ? (r.a.min ? (v / r.a.min) * 90 : 0) : v;
  };
  const sortCol = COLS.find((c) => c.key === st.sort) || { key: st.sort };
  rows.sort((x, y) => {
    const a = val(x, sortCol), b = val(y, sortCol);
    return (typeof a === "string" ? a.localeCompare(b) : a - b) * st.dir;
  });
  const total = rows.length;
  rows = rows.slice(0, st.limit);
  const cols = [{ key: "name", label: "Player", cls: "l sticky" }, { key: "team", label: "Team", cls: "l" }, ...COLS, { key: "next", label: "Next 5", cls: "l sep", sortable: false }];
  $("#pTable").innerHTML = `<thead><tr>${sortHeader(cols, st)}</tr></thead><tbody>${rows.map((r) => `
    <tr class="click" data-pid="${r.p.id}">
      <td class="l sticky"><span class="pos">${r.p.pos}</span><span class="pname">${esc(r.p.name)}</span>${statusFlag(r.p)}</td>
      <td class="l">${D.team[r.p.team].short}</td>
      ${COLS.map((c) => { const v = val(r, c); const dec = per90 && !c.raw && !c.no90 ? 2 : c.dec; return `<td class="${c.cls || ""}">${v === 0 && !c.raw ? `<span class="dim">0</span>` : v.toFixed(dec)}</td>`; }).join("")}
      <td class="l sep">${nextFixtures(r.p.team, 5)}</td>
    </tr>`).join("") || `<tr><td colspan="${cols.length}" class="l dim">${minm > mostMin
      ? `No one matching these filters has ${minm}+ minutes in this window (the most is ${mostMin}). Lower Min minutes.`
      : "No players match these filters."}</td></tr>`}</tbody>`;
  bindSort($("#pTable"), st, "players", () => renderPlayers(true), (k) => (k === "name" || k === "team" ? 1 : -1));
  $("#pTable").querySelectorAll("tr[data-pid]").forEach((tr) => tr.addEventListener("click", (e) => { if (!e.target.closest("[data-tip].chip")) openPlayer(+tr.dataset.pid); }));
  $("#pMore").innerHTML = total > st.limit
    ? `<button class="btn" id="moreBtn">Show more (${total - st.limit} hidden)</button>`
    : `<span class="dim">${total} players</span>`;
  $("#moreBtn")?.addEventListener("click", () => { st.limit += 100; store.set("players", st); renderPlayers(true); });
}

// ---------------------------------------------------------------- player panel
function barChart({ gws, series, height = 150, fmt = f1, tipFor }) {
  // series: [{key, label, color, values: Map gw -> number}] stacked bottom-up
  const W = 420, H = height, padL = 28, padB = 18, padT = 6;
  const totals = gws.map((g) => sum(series.map((s) => Math.max(0, s.values.get(g) || 0))));
  const max = Math.max(1, ...totals);
  const step = (W - padL) / gws.length, bw = Math.max(4, Math.min(22, step * 0.62));
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, max / 2, max];
  let out = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (const t of ticks) out += `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)" stroke-width="1"/><text x="${padL - 5}" y="${y(t) + 3.5}" text-anchor="end" font-size="10" fill="var(--muted)">${fmt(t)}</text>`;
  gws.forEach((g, i) => {
    const x = padL + step * i + (step - bw) / 2;
    let base = 0;
    const segs = series.map((s) => ({ s, v: Math.max(0, s.values.get(g) || 0) })).filter((o) => o.v > 0);
    segs.forEach((o, j) => {
      const y0 = y(base), y1 = y(base + o.v);
      const hgt = Math.max(0, y0 - y1 - (j < segs.length - 1 ? 2 : 0));
      const top = j === segs.length - 1;
      out += top
        ? `<path d="M${x},${y0} V${y0 - hgt + 3} q0,-3 3,-3 h${bw - 6} q3,0 3,3 V${y0} Z" fill="${o.s.color}"/>`
        : `<rect x="${x}" y="${y0 - hgt}" width="${bw}" height="${hgt}" fill="${o.s.color}"/>`;
      base += o.v;
    });
    if (gws.length <= 20 || i % 2 === 0) out += `<text x="${x + bw / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--muted)">${g}</text>`;
    out += `<rect x="${padL + step * i}" y="0" width="${step}" height="${H - padB}" fill="transparent" data-tip="${esc(tipFor(g))}"/>`;
  });
  out += `<line x1="${padL}" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)"/></svg>`;
  return out;
}

function openPlayer(pid) {
  const p = D.players.find((x) => x.id === pid);
  if (!p) return;
  const fi = D.fi, t = D.team[p.team];
  const byGw = new Map();
  for (const r of p.log) {
    const g = r[fi.gw];
    const o = byGw.get(g) || { rows: [] };
    o.rows.push(r);
    byGw.set(g, o);
  }
  const m = (k) => new Map([...byGw].map(([g, o]) => [g, sum(o.rows.map((r) => r[fi[k]]))]));
  const pts = m("pts"), xg = m("xg"), xa = m("xa"), mins = m("min");
  const gws = D.dataGws;
  const oppOf = (r) => {
    const f = D.fx[r[fi.fx]]; if (!f) return "?";
    const home = f.h === p.team;
    return short(home ? f.a : f.h, home);
  };
  const tipFor = (g) => {
    const o = byGw.get(g);
    if (!o) return `GW${g}: did not play`;
    return `GW${g} vs ${o.rows.map(oppOf).join(", ")} · ${mins.get(g)}′<br>${pts.get(g)} pts · xG ${f2(xg.get(g))} · xA ${f2(xa.get(g))}`;
  };
  const season = aggPlayer(p, new Set(gws));
  const setp = [p.pen && `Pens #${p.pen}`, p.fk && `FKs #${p.fk}`, p.ck && `Corners #${p.ck}`].filter(Boolean).join(" · ");
  const logRows = [...p.log].sort((a, b) => b[fi.gw] - a[fi.gw]);
  $("#panelBody").innerHTML = `
    <div class="phead">
      <div><h2>${esc(p.full)} ${statusFlag(p)}</h2>
        <div class="facts"><span>${esc(t.name)}</span><span>${p.pos}</span><span><b>£${p.price.toFixed(1)}</b></span><span><b>${p.own.toFixed(1)}%</b> selected</span><span>Form <b>${p.form.toFixed(1)}</b></span><span>xPts next <b>${p.ep.toFixed(1)}</b></span>${setp ? `<span>${setp}</span>` : ""}</div>
      </div>
      <button class="x" type="button" aria-label="Close">×</button>
    </div>
    ${p.news ? `<div class="news">${esc(p.news)}</div>` : ""}
    <div class="facts">Season: <span><b>${season.pts}</b> pts</span><span><b>${season.min}</b> min</span><span><b>${season.g}</b> G / <b>${f2(season.xg)}</b> xG</span><span><b>${season.a}</b> A / <b>${f2(season.xa)}</b> xA</span>${["GKP", "DEF"].includes(p.pos) ? `<span><b>${season.cs}</b> CS</span>` : ""}<span><b>${season.dch}</b> DC hits</span><span><b>${season.bon}</b> bonus</span></div>
    <div class="charts">
      <div class="chart"><h3>Points per gameweek</h3>${barChart({ gws, series: [{ label: "Points", color: "var(--series-1)", values: pts }], fmt: (v) => Math.round(v), tipFor })}</div>
      <div class="chart"><h3>Expected goal involvement per gameweek</h3>
        <div class="lg"><span><i style="background:var(--series-1)"></i>xG</span><span><i style="background:var(--series-2)"></i>xA</span></div>
        ${barChart({ gws, series: [{ label: "xG", color: "var(--series-1)", values: xg }, { label: "xA", color: "var(--series-2)", values: xa }], height: 132, tipFor })}</div>
    </div>
    <div class="psec"><h3>Next fixtures</h3>${nextFixtures(p.team, 8)}</div>
    <div class="psec" id="shotSec"><p class="dim">Loading shot map…</p></div>
    <div class="psec"><h3>Gameweek log</h3>
      <div class="tablewrap"><table class="grid">
        <thead><tr><th class="l">GW</th><th class="l">Opp</th><th>Result</th><th>Min</th><th>Pts</th><th>G</th><th>xG</th><th>A</th><th>xA</th><th>xGC</th><th>CS</th><th>DC</th><th>Bon</th><th>BPS</th>${p.pos === "GKP" ? "<th>Sv</th>" : ""}</tr></thead>
        <tbody>${logRows.map((r) => {
          const f = D.fx[r[fi.fx]]; const home = f && f.h === p.team;
          const res = f && f.hs != null ? (home ? `${f.hs}–${f.as}` : `${f.as}–${f.hs}`) : "";
          const dch = r[fi.dch] ? ` <span class="dim" title="DC threshold reached">✓</span>` : "";
          return `<tr><td class="l">${r[fi.gw]}</td><td class="l">${oppOf(r)}</td><td>${res}</td><td>${r[fi.min]}</td><td><b>${r[fi.pts]}</b></td><td>${r[fi.g]}</td><td>${f2(r[fi.xg])}</td><td>${r[fi.a]}</td><td>${f2(r[fi.xa])}</td><td>${f2(r[fi.xgc])}</td><td>${r[fi.cs]}</td><td>${r[fi.dc]}${dch}</td><td>${r[fi.bon]}</td><td>${r[fi.bps]}</td>${p.pos === "GKP" ? `<td>${r[fi.sv]}</td>` : ""}</tr>`;
        }).join("") || `<tr><td class="l dim" colspan="14">No appearances yet.</td></tr>`}</tbody>
      </table></div>
    </div>`;
  showPanel();
  renderShotSection(p);
}
function showPanel() {
  const dlg = $("#panel");
  $("#panelBody .x")?.addEventListener("click", () => dlg.close());
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
}
$("#panel").addEventListener("click", (e) => { if (e.target === $("#panel")) $("#panel").close(); });

// ---------------------------------------------------------------- shot maps & positions (Understat)
let shotsPromise = null;
function ensureShots() {
  shotsPromise ||= fetch(`data/shots.json?v=${Date.now() >> 16}`).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((s) => {
    if (!s) return null;
    const si = Object.fromEntries(s.fields.map((f, i) => [f, i]));
    D.shotMeta = s;
    D.shots = s.shots.map((r) => ({
      p: r[si.p], t: r[si.t], fx: r[si.fx], min: r[si.min], x: r[si.x], y: r[si.y], xg: r[si.xg],
      res: s.results[r[si.res]] || "", sit: s.situations[r[si.sit]] || "", body: s.body[r[si.body]] || "", ast: r[si.ast],
      gw: D.fx[r[si.fx]]?.gw,
    })).filter((x) => x.res !== "OwnGoal");
    return D.shots;
  });
  return shotsPromise;
}
/** A note when finished games in `gws` have no Understat data (it was down at the last update). */
function usGapNote(gws) {
  const miss = (D.meta.understat_missing || []).map((id) => D.fx[id]).filter((f) => f && gws.has(f.gw));
  if (!miss.length) return "";
  const gwList = [...new Set(miss.map((f) => f.gw))].sort((a, b) => a - b).map((g) => "GW" + g).join(", ");
  return `<p class="note">Understat couldn't be reached at the last update, so ${miss.length} game${miss.length > 1 ? "s" : ""} (${gwList}) ${miss.length > 1 ? "are" : "is"} missing here. They're filled in at the next update that reaches it.</p>`;
}
const playerName = (id) => D.players.find((p) => p.id === id)?.name || "?";
const shooterName = (s) => (s.p > 0 ? playerName(s.p) : D.shotMeta.names[-s.p - 1] || "?");
const NICE = { MissedShots: "Missed", SavedShot: "Saved", BlockedShot: "Blocked", ShotOnPost: "Hit the post", Goal: "Goal",
  OpenPlay: "Open play", FromCorner: "From a corner", SetPiece: "Set piece", DirectFreekick: "Direct free kick", Penalty: "Penalty",
  RightFoot: "Right foot", LeftFoot: "Left foot", Head: "Header", OtherBodyPart: "Other" };

/** Pitch markings in metres (68 wide). Attacking goal at the top. `full` draws both halves. */
function pitchLines(full, depth = 52.5) {
  const L = full ? 105 : depth, ln = `stroke="var(--axis)" stroke-width="0.35" fill="none"`;
  const end = (y0, dir) => {
    const y = (d) => y0 + dir * d;
    return `<rect x="13.84" y="${Math.min(y(0), y(16.5))}" width="40.32" height="16.5" ${ln}/>
      <rect x="24.84" y="${Math.min(y(0), y(5.5))}" width="18.32" height="5.5" ${ln}/>
      <rect x="30.34" y="${Math.min(y(0), y(-1.6))}" width="7.32" height="1.6" ${ln}/>
      <circle cx="34" cy="${y(11)}" r="0.35" fill="var(--axis)"/>
      <path d="M26.69 ${y(16.5)} A9.15 9.15 0 0 ${dir > 0 ? 0 : 1} 41.31 ${y(16.5)}" ${ln}/>`;
  };
  return `<rect x="0" y="0" width="68" height="${L}" fill="var(--surface-2)" stroke="var(--axis)" stroke-width="0.35"/>
    ${end(0, 1)}
    ${full ? `<line x1="0" x2="68" y1="52.5" y2="52.5" ${ln}/><circle cx="34" cy="52.5" r="9.15" ${ln}/>${end(105, -1)}`
           : ""}`;
}

/** Attacking-third shot map (40 m deep; longer shots sit on the edge). Filled = goal, hollow = no goal, area = xG.
 *  Understat's Y runs from the attacker's right (0) to left (1). */
function shotMap(shots, { who = true } = {}) {
  const dots = [...shots].sort((a, b) => b.xg - a.xg).map((s) => {
    const cx = (1 - s.y) * 68, cy = Math.min(39.5, (1 - s.x) * 105), r = 0.7 + Math.sqrt(s.xg) * 3.4;
    const f = D.fx[s.fx], opp = f ? (f.h === s.t ? short(f.a, true) : short(f.h, false)) : "";
    const tipText = `<b>${esc(NICE[s.res] || s.res)}</b> · xG ${s.xg.toFixed(2)}${who ? `<br>${esc(shooterName(s))}` : ""}<br>GW${s.gw} vs ${opp}, ${s.min}′<br>${esc(NICE[s.sit] || s.sit)} · ${esc(NICE[s.body] || s.body)}${s.ast > 0 ? `<br>Assisted by ${esc(playerName(s.ast))}` : ""}`;
    return s.res === "Goal"
      ? `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="var(--series-1)" stroke="var(--surface)" stroke-width="0.4" data-tip="${esc(tipText)}"/>`
      : `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="var(--surface)" fill-opacity="0.55" stroke="var(--text-2)" stroke-width="0.4" data-tip="${esc(tipText)}"/>`;
  }).join("");
  return `<svg class="pitch" viewBox="-1 -2.5 70 43.5" role="img" aria-label="Shot map">${pitchLines(false, 40)}${dots}</svg>`;
}
function shotSummary(shots) {
  const np = shots.filter((s) => s.sit !== "Penalty");
  const g = shots.filter((s) => s.res === "Goal").length;
  const npxg = sum(np.map((s) => s.xg));
  const box = shots.filter((s) => s.x >= 1 - 16.5 / 105 && Math.abs(s.y - 0.5) <= 20.16 / 68).length;
  return `<div class="facts"><span><b>${shots.length}</b> shots</span><span><b>${g}</b> goals</span><span><b>${f2(npxg)}</b> npxG</span><span><b>${np.length ? f2(npxg / np.length) : "–"}</b> npxG/shot</span><span><b>${shots.length ? Math.round((box / shots.length) * 100) : 0}%</b> in the box</span>${shots.length - np.length ? `<span><b>${shots.length - np.length}</b> pens</span>` : ""}</div>`;
}
const MAP_LEGEND = `<div class="lg"><span><i style="background:var(--series-1);border-radius:50%"></i>Goal</span><span><i style="border:1px solid var(--text-2);border-radius:50%"></i>No goal</span><span>Bigger = higher xG</span></div>`;

// Understat position slots (x, y in % of the pitch; attacking goal at the top)
const POS_XY = {
  FWL: [26, 15], FW: [50, 12], FWR: [74, 15],
  AML: [16, 31], AMC: [50, 32], AMR: [84, 31],
  ML: [12, 47], MC: [50, 48], MR: [88, 47],
  DML: [20, 62], DMC: [50, 63], DMR: [80, 62],
  DL: [14, 76], DC: [50, 79], DR: [86, 76], GK: [50, 94],
};
function positionMap(rows) {
  const ui = D.ui, counts = {};
  let subs = 0;
  for (const r of rows) { const pos = r[ui.pos]; if (POS_XY[pos]) counts[pos] = (counts[pos] || 0) + 1; else if (pos === "Sub") subs++; }
  const max = Math.max(1, ...Object.values(counts));
  const dots = Object.entries(counts).map(([pos, n]) => {
    const [px, py] = POS_XY[pos], cx = (px / 100) * 68, cy = (py / 100) * 105, r = 3.2 + 4.2 * Math.sqrt(n / max);
    return `<g data-tip="${pos}: started ${n} game${n > 1 ? "s" : ""} here"><circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--series-1)" stroke="var(--surface)" stroke-width="0.6"/>
      <text x="${cx}" y="${cy + 1.6}" text-anchor="middle" font-size="4.4" font-weight="700" fill="#fff">${n}</text>
      <text x="${cx}" y="${cy + r + 4.2}" text-anchor="middle" font-size="3.6" fill="var(--text-2)">${pos}</text></g>`;
  }).join("");
  return `<svg class="pitch" viewBox="-1 -2.5 70 110" role="img" aria-label="Starting positions">${pitchLines(true)}${dots}</svg>
    <div class="dim" style="font-size:12px;margin-top:4px">${Object.keys(counts).length ? "" : "No starts in this window. "}${subs ? `Plus ${subs} sub appearance${subs > 1 ? "s" : ""}.` : ""}</div>`;
}

const SM_DEF = { win: "season", kind: "taken", pens: true };
async function renderShotSection(p) {
  const box = $("#shotSec");
  if (!box) return;
  const shots = await ensureShots();
  if ($("#shotSec") !== box) return; // panel changed while loading
  if (!shots || !D.meta.understat) { box.innerHTML = `<p class="dim">Shot data isn't available (Understat couldn't be reached at the last update).</p>`; return; }
  const st = store.get("shotmap", SM_DEF);
  const gws = windowGws({ win: st.win });
  let list = shots.filter((s) => gws.has(s.gw) && (st.kind === "taken" ? s.p === p.id : s.ast === p.id));
  if (!st.pens) list = list.filter((s) => s.sit !== "Penalty");
  const rows = (p.us || []).filter((r) => gws.has(D.fx[r[D.ui.fx]]?.gw));
  const span = [...gws];
  box.innerHTML = `
    <div class="controls" style="margin-bottom:8px">
      <div class="ctl"><span class="lbl">Window</span>${seg("win", [["season", "Season"], [6, "Last 6"], [3, "Last 3"]], st.win)}</div>
      <div class="ctl"><span class="lbl">Shots</span>${seg("kind", [["taken", "Taken"], ["created", "Assisted"]], st.kind)}</div>
      <label class="check"><input type="checkbox" data-chk="pens" ${st.pens ? "checked" : ""}> Penalties</label>
    </div>
    <div class="maps">
      <div class="chart"><h3>${st.kind === "taken" ? "Shots taken" : "Shots from this player's passes"} <span class="dim" style="font-weight:400">GW${span[0] ?? "–"}–${span.at(-1) ?? "–"}</span></h3>${MAP_LEGEND}${shotMap(list, { who: st.kind !== "taken" })}${shotSummary(list)}</div>
      <div class="chart"><h3>Starting positions</h3><div class="lg"><span>Number = games started there</span></div>${positionMap(rows)}</div>
    </div>${usGapNote(gws)}`;
  bindControls(box, st, "shotmap", () => renderShotSection(p));
}
async function renderTeamShots(tid) {
  const box = $("#teamShots");
  if (!box) return;
  const shots = await ensureShots();
  if ($("#teamShots") !== box) return;
  if (!shots || !D.meta.understat) { box.innerHTML = `<p class="dim">Shot data isn't available (Understat couldn't be reached at the last update).</p>`; return; }
  const forS = shots.filter((s) => s.t === tid);
  const fxs = new Set(D.games[tid].map((g) => g.fx.id));
  const agS = shots.filter((s) => s.t !== tid && fxs.has(s.fx));
  box.innerHTML = `${MAP_LEGEND}<div class="maps">
      <div class="chart"><h3>Shots for</h3>${shotMap(forS)}${shotSummary(forS)}</div>
      <div class="chart"><h3>Shots against</h3>${shotMap(agS)}${shotSummary(agS)}</div></div>${usGapNote(new Set(D.dataGws))}`;
}

// ---------------------------------------------------------------- TICKER
const T_DEF = { stat: "att", model: "matchup", measure: "xg", period: 6, start: 0, horizon: 6, adj: true, sort: "total", dir: -1 };

/** The rates a fixture is built from. With home/away on, the team's own home (or away) games
 *  meet the opponent's away (or home) games, against the league average for that venue. */
function fixtureRates(st, team, opp, home, rates) {
  const L = D.league[st.measure];
  if (!st.adj) return { T: rates.all[team], O: rates.all[opp], baseUs: L.mean, baseThem: L.mean };
  return {
    T: rates[home ? "home" : "away"][team], O: rates[home ? "away" : "home"][opp],
    baseUs: home ? L.home : L.away, baseThem: home ? L.away : L.home,
  };
}
function tickerValue(st, team, opp, home, rates) {
  const { T, O, baseUs, baseThem } = fixtureRates(st, team, opp, home, rates);
  const x = st.measure === "xg";
  const oppConc = x ? O.xgapg : O.gapg, oppScore = x ? O.xgfpg : O.gfpg;
  const ourScore = x ? T.xgfpg : T.gfpg, ourConc = x ? T.xgapg : T.gapg;
  if (st.stat === "att") return st.model === "matchup" ? ourScore * oppConc / baseUs : oppConc;
  return st.model === "matchup" ? oppScore * ourConc / baseThem : oppScore;
}

function renderTicker() {
  const st = store.get("ticker", T_DEF);
  const start = st.start && st.startFor === D.startGw ? st.start : D.startGw;
  const end = Math.min(38, start + st.horizon - 1);
  const gws = []; for (let g = start; g <= end; g++) gws.push(g);
  const isFdr = st.stat === "fdr";
  const byVenue = (v) => Object.fromEntries(D.teams.map((t) => [t.id, teamRates(t.id, st.period, v)]));
  const rates = { all: byVenue("all"), home: byVenue("home"), away: byVenue("away") };
  const good = isFdr || st.stat === "def" ? -1 : 1; // direction in which a higher number is better
  const mLabel = st.measure === "xg" ? "xG" : "goals";

  // build rows
  const rows = D.teams.map((t) => {
    const cells = gws.map((g) => (D.byTeamGw[t.id][g] || []).map((f) => ({
      ...f, gw: g, v: isFdr ? f.fdr : tickerValue(st, t.id, f.opp, f.home, rates),
    })));
    const all = cells.flat();
    const n = all.length;
    const avg = n ? sum(all.map((c) => c.v)) / n : null;
    let total;
    if (isFdr) total = avg;
    else if (st.stat === "att") total = sum(all.map((c) => c.v));
    else total = st.model === "matchup" ? sum(all.map((c) => Math.exp(-c.v))) : avg;
    return { t, cells, n, avg, total, r: rates.all[t.id] };
  });
  const vals = rows.flatMap((r) => r.cells.flat().map((c) => c.v));
  const mu = vals.length ? sum(vals) / vals.length : 0;
  const sd = Math.sqrt(vals.length ? sum(vals.map((v) => (v - mu) ** 2)) / vals.length : 1) || 1;
  const tOf = (v) => (isFdr ? fdrT(v) : clamp(((v - mu) / sd) / 2, -1, 1) * good);
  const totals = rows.map((r) => r.total).filter((v) => v != null);
  const tMu = sum(totals) / (totals.length || 1);
  const tSd = Math.sqrt(sum(totals.map((v) => (v - tMu) ** 2)) / (totals.length || 1)) || 1;
  const totalGood = isFdr ? -1 : st.stat === "att" ? 1 : st.model === "matchup" ? 1 : -1;

  // labels
  const totalLabel = isFdr ? "Avg FDR" : st.stat === "att" ? `Σ ${mLabel}` : st.model === "matchup" ? "xCS" : "Avg";
  const totalTitle = isFdr ? "Average official fixture difficulty"
    : st.stat === "att" ? `Sum over the horizon of the cell values. Double gameweeks count twice, blanks count zero.`
    : st.model === "matchup" ? "Expected clean sheets over the horizon: sum of e^(−projected goals against) per fixture (Poisson)."
    : "Average opponent attack across the fixtures in the horizon (lower is better).";
  const ownCols = isFdr ? [] : st.stat === "att"
    ? [{ key: "own1", label: st.measure === "xg" ? "xGF/g" : "GF/g", title: "Team's own attack, per game over the chosen period" }, { key: "own2", label: st.measure === "xg" ? "xGA/g" : "GA/g", title: "Team's own defence, per game over the chosen period" }]
    : [{ key: "own1", label: st.measure === "xg" ? "xGA/g" : "GA/g", title: "Team's own defence, per game over the chosen period" }, { key: "own2", label: st.measure === "xg" ? "xGF/g" : "GF/g", title: "Team's own attack, per game over the chosen period" }];
  const ownVal = (r, k) => {
    const x = st.measure === "xg";
    const att = x ? r.r.xgfpg : r.r.gfpg, def = x ? r.r.xgapg : r.r.gapg;
    return st.stat === "att" ? (k === "own1" ? att : def) : (k === "own1" ? def : att);
  };

  // sort
  // Fixture columns and the total sort by "goodness" (higher = better), so ▼ is always best first.
  const sortKey = st.sort;
  const keyVal = (r) => {
    if (sortKey === "team") return r.t.name;
    if (sortKey === "total") return r.total == null ? -Infinity : r.total * totalGood;
    if (sortKey === "n") return r.n;
    if (sortKey === "own1" || sortKey === "own2") return ownVal(r, sortKey);
    if (sortKey.startsWith("gw")) {
      const c = r.cells[gws.indexOf(+sortKey.slice(2))] || [];
      if (!c.length) return -Infinity;
      return (good > 0 ? sum(c.map((x) => x.v)) : -sum(c.map((x) => x.v)) / c.length);
    }
    return 0;
  };
  rows.sort((a, b) => { const x = keyVal(a), y = keyVal(b); return (typeof x === "string" ? x.localeCompare(y) : x - y) * st.dir; });

  const what = isFdr ? "official FPL fixture difficulty (1 easiest – 5 hardest)"
    : st.stat === "att"
      ? (st.model === "matchup" ? `projected ${mLabel} for the team: its own attack × the opponent's defence ÷ league average` : `the opponent's ${mLabel} conceded per game`)
      : (st.model === "matchup" ? `projected ${mLabel} against the team: the opponent's attack × the team's own defence ÷ league average` : `the opponent's ${mLabel} scored per game`);

  const main = $("#main");
  const periodOpts = [[3, "Last 3"], [6, "Last 6"], [0, "Season"]];
  const startOpts = []; for (let g = 1; g <= 38; g++) startOpts.push([g, `GW${g}${g === D.startGw ? " (next)" : ""}`]);
  main.innerHTML = `
    <h1>Fixture ticker</h1>
    <p class="lede">Each cell is a fixture; a corner marker means a home game, and hovering shows the opponent. The number is ${what}${!isFdr && st.adj ? ", using home games for the home side and away games for the away side" : ""}. <b style="color:var(--accent-ink)">Blue</b> is a good fixture for this team's ${st.stat === "def" ? "defenders and keeper" : isFdr ? "players" : "attackers"}, <b style="color:var(--bad)">red</b> a bad one.</p>
    <div class="controls">
      <div class="ctl"><span class="lbl">For</span>${seg("stat", [["att", "Attack"], ["def", "Defence"], ["fdr", "FPL FDR"]], st.stat)}</div>
      ${isFdr ? "" : `
      <div class="ctl"><span class="lbl">Model</span>${seg("model", [["matchup", "Team vs opponent"], ["opp", "Opponent only"]], st.model)}</div>
      <div class="ctl"><span class="lbl">Measure</span>${seg("measure", [["xg", "xG"], ["g", "Goals"]], st.measure)}</div>
      <div class="ctl"><span class="lbl">Form period</span>${seg("period", periodOpts, st.period)}</div>`}
      <div class="ctl"><span class="lbl">From</span>${selectEl("start", startOpts, start)}</div>
      <div class="ctl"><span class="lbl">Gameweeks</span>${selectEl("horizon", [1, 2, 3, 4, 5, 6, 8, 10, 12].map((h) => [h, h]), st.horizon)}</div>
      ${isFdr ? "" : `<label class="check"><input type="checkbox" data-chk="adj" ${st.adj ? "checked" : ""}> Home/away form</label>`}
    </div>
    <div class="tablewrap"><table class="grid" id="tTable">
      <thead><tr>${sortHeader([{ key: "team", label: "Team", cls: "l sticky" }, ...ownCols], st)}
        ${gws.map((g) => { const e = D.eventById[g]; return `<th class="c sortable${g === start ? " sep" : ""}" data-sort="gw${g}">GW${g}${st.sort === "gw" + g ? `<span class="arr">${st.dir > 0 ? "▲" : "▼"}</span>` : ""}<span class="sub">${e ? fmtDate(e.deadline, { day: "numeric", month: "short" }) : ""}</span></th>`; }).join("")}
        ${sortHeader([{ key: "n", label: "Gms", title: "Fixtures in the horizon", cls: "sep" }, { key: "total", label: totalLabel, title: totalTitle }], st)}
      </tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="l sticky"><b>${esc(r.t.name)}</b></td>
        ${ownCols.map((c) => `<td>${f2(ownVal(r, c.key))}</td>`).join("")}
        ${r.cells.map((cs, i) => `<td class="heat${i === 0 ? " sep" : ""}">${cs.length ? `<div class="cellbox">${cs.map((c) => `<div class="cell tval${cs.length > 1 ? " dgw" : ""}${c.home ? " home" : ""}" style="${heat(tOf(c.v))}" data-tip="${esc(cellTip(st, r.t, c, rates))}" aria-label="${c.home ? "Home" : "Away"} vs ${esc(D.team[c.opp].name)}: ${isFdr ? c.v : f2(c.v)}"><span class="opp">${isFdr ? c.v : f2(c.v)}</span></div>`).join("")}</div>` : `<div class="cell blank" data-tip="GW${gws[i]}: no fixture (blank)">–</div>`}</td>`).join("")}
        <td class="sep">${r.n}</td>
        <td class="heat"><div class="cell" style="${r.total == null ? "" : heat(clamp((r.total - tMu) / tSd / 2, -1, 1) * totalGood)}"><span class="opp">${r.total == null ? "–" : f2(r.total)}</span></div></td>
      </tr>`).join("")}</tbody>
    </table></div>
    <div class="legend"><span>Worse</span><span class="ramp">${[-1, -0.6, -0.25, 0, 0.25, 0.6, 1].map((t) => `<i style="${heat(t)}"></i>`).join("")}</span><span>Better</span>
      <span style="margin-left:14px" class="cell tval home legend-home">home game</span>
      <span class="cell dgw" >&nbsp;outline = double gameweek&nbsp;</span>
      <span class="cell blank" style="padding:2px 8px">blank gameweek</span></div>
    <p class="note">${isFdr ? "FDR is set by the Premier League and changes rarely." : `${st.adj ? `Home/away form is on: each fixture uses the team's ${st.period ? `last ${st.period} home games` : "home games this season"} when it plays at home (away games when away) and the opponent's games at the other venue. ${st.model === "matchup" ? `Projections divide by the league average for that venue this season (home ${f2(D.league[st.measure].home)}, away ${f2(D.league[st.measure].away)} ${mLabel} per game, from ${D.league.n} games).` : ""} Home or away alone is half the games, so it's noisier, especially early in the season.` : `Form uses each team's last ${st.period || "all"} finished ${st.period ? "games" : "games this season"}, home and away together. Short form periods are noisy, especially early in the season.`} Colours compare each cell with all the cells shown. The xGF/g and xGA/g columns use all games.`}</p>`;
  bindControls(main, st, "ticker", renderTicker);
  bindSort($("#tTable"), st, "ticker", renderTicker, (k) => (k === "team" ? 1 : -1));
}
function cellTip(st, team, c, rates) {
  const opp = D.team[c.opp];
  const head = `<b>${esc(team.short)} ${c.home ? "vs" : "@"} ${esc(opp.name)}</b> (${c.home ? "home" : "away"}) · GW${c.gw}<br>FDR ${c.fdr}`;
  if (st.stat === "fdr") return head;
  const x = st.measure === "xg", m = x ? "xG" : "G";
  const { T, O, baseUs, baseThem } = fixtureRates(st, team.id, c.opp, c.home, rates);
  const where = (r) => (r.venue === "all" ? `in ${r.gp} games` : `in ${r.gp} ${r.venue} game${r.gp === 1 ? "" : "s"}`);
  // The games behind a rate, newest first, scores and xG from that team's side
  const games = (r) => r.games.length ? `<span class="tg">${[...r.games].reverse().map((g) =>
    `GW${g.gw} ${g.home ? "vs" : "@"} ${esc(D.team[g.opp].short)} <b>${g.gf}–${g.ga}</b>${g.xgf != null ? ` · xG ${f2(g.xgf)}–${f2(g.xga)}` : ""}`).join("<br>")}</span>` : "";
  const lines = st.stat === "att"
    ? [`${opp.short} conceded ${f2(x ? O.xgapg : O.gapg)} ${m}/g ${where(O)}${games(O)}`, st.model === "matchup" ? `${team.short} scored ${f2(x ? T.xgfpg : T.gfpg)} ${m}/g ${where(T)}${games(T)}` : ""]
    : [`${opp.short} scored ${f2(x ? O.xgfpg : O.gfpg)} ${m}/g ${where(O)}${games(O)}`, st.model === "matchup" ? `${team.short} conceded ${f2(x ? T.xgapg : T.gapg)} ${m}/g ${where(T)}${games(T)}` : ""];
  const base = st.stat === "att" ? baseUs : baseThem;
  const baseLabel = !st.adj ? "League avg" : `League avg ${(st.stat === "att") === c.home ? "home" : "away"} team`;
  const cs = st.stat === "def" && st.model === "matchup" ? `<br>Clean sheet chance ≈ ${Math.round(Math.exp(-c.v) * 100)}%` : "";
  return `${head}<br>${lines.filter(Boolean).join("<br>")}${st.model === "matchup" ? `<br>${baseLabel} ${f2(base)} ${m}/g` : ""}<br><b>${st.model === "matchup" ? "Projected" : "Value"}: ${f2(c.v)}</b>${cs}`;
}

// ---------------------------------------------------------------- SCHEDULE
const S_DEF = { start: 0, count: 38, sort: "team", dir: 1 };
function renderSchedule() {
  const st = store.get("schedule", S_DEF);
  const start = st.start && st.startFor === D.startGw ? st.start : D.startGw;
  const gws = []; for (let g = start; g <= 38; g++) gws.push(g);
  const rows = D.teams.map((t) => {
    const cells = gws.map((g) => D.byTeamGw[t.id][g] || []);
    return { t, cells, blanks: cells.filter((c) => !c.length).length, doubles: cells.filter((c) => c.length > 1).length };
  });
  if (!["team", "doubles", "blanks"].includes(st.sort)) Object.assign(st, { sort: "team", dir: 1 });
  const kv = (r) => (st.sort === "team" ? r.t.name : r[st.sort]);
  rows.sort((a, b) => { const x = kv(a), y = kv(b); return (typeof x === "string" ? x.localeCompare(y) : x - y) * st.dir; });
  const startOpts = []; for (let g = 1; g <= 38; g++) startOpts.push([g, `GW${g}${g === D.startGw ? " (next)" : ""}`]);
  const main = $("#main");
  main.innerHTML = `
    <h1>Schedule</h1>
    <p class="lede">Every fixture by gameweek (upper case = home, lower case = away) with its kick-off day, or the score once played.</p>
    <div class="controls"><div class="ctl"><span class="lbl">From</span>${selectEl("start", startOpts, start)}</div></div>
    <div class="tablewrap"><table class="grid" id="sTable">
      <thead><tr>${sortHeader([{ key: "team", label: "Team", cls: "l sticky" }, { key: "doubles", label: "DGW", title: "Double gameweeks from the chosen start" }, { key: "blanks", label: "BGW", title: "Blank gameweeks from the chosen start" }], st)}
        ${gws.map((g, i) => { const e = D.eventById[g]; return `<th class="c${i === 0 ? " sep" : ""}">GW${g}<span class="sub">${e ? fmtDate(e.deadline, { day: "numeric", month: "short" }) : ""}</span></th>`; }).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="l sticky"><b>${esc(r.t.name)}</b></td>
        <td>${r.doubles || '<span class="dim">0</span>'}</td><td>${r.blanks || '<span class="dim">0</span>'}</td>
        ${r.cells.map((cs, i) => `<td class="c sched${i === 0 ? " sep" : ""}">${cs.length ? cs.map((c) => {
          const f = c.fx, played = f.fin || f.live;
          const score = played ? (c.home ? `${f.hs}–${f.as}` : `${f.as}–${f.hs}`) : "";
          return `<div class="fx" data-tip="<b>${esc(r.t.short)} ${c.home ? "vs" : "@"} ${esc(D.team[c.opp].name)}</b><br>${fmtDate(f.ko)} ${fmtTime(f.ko)}${played ? `<br>Score ${score}${f.xh != null ? ` · xG ${f2(c.home ? f.xh : f.xa)}–${f2(c.home ? f.xa : f.xh)}` : ""}` : ""}"><span class="opp">${short(c.opp, c.home)}</span><span class="sub">${played ? score : fmtDate(f.ko, { weekday: "short", day: "numeric" })}</span></div>`;
        }).join("") : `<span class="dim">–</span>`}</td>`).join("")}
      </tr>`).join("")}</tbody>
    </table></div>
    ${D.unscheduled.length ? `<p class="note"><b>Not yet scheduled:</b> ${D.unscheduled.map((f) => `${esc(D.team[f.h].short)} v ${esc(D.team[f.a].short)}`).join(", ")}. These usually become double gameweeks.</p>` : ""}`;
  bindControls(main, st, "schedule", renderSchedule);
  bindSort($("#sTable"), st, "schedule", renderSchedule, (k) => (k === "team" ? 1 : -1));
}

// ---------------------------------------------------------------- TEAMS
const TM_DEF = { period: 0, venue: "all", sort: "xgd", dir: -1 };
const TM_COLS = [
  { key: "gp", label: "GP", dec: 0 }, { key: "w", label: "W", dec: 0 }, { key: "d", label: "D", dec: 0 }, { key: "l", label: "L", dec: 0 },
  { key: "pts", label: "Pts", dec: 0 },
  { key: "gf", label: "GF", dec: 0, cls: "sep" }, { key: "ga", label: "GA", dec: 0 }, { key: "cs", label: "CS", title: "Clean sheets", dec: 0 },
  { key: "xgf", label: "xGF", dec: 1, cls: "sep", title: "Expected goals for (sum of players' xG)" }, { key: "xga", label: "xGA", dec: 1, title: "Expected goals against" },
  { key: "xgd", label: "xGD", dec: 1, title: "xGF − xGA" },
  { key: "gfpg", label: "GF/g", dec: 2, cls: "sep", heat: 1 }, { key: "gapg", label: "GA/g", dec: 2, heat: -1 },
  { key: "xgfpg", label: "xGF/g", dec: 2, heat: 1 }, { key: "xgapg", label: "xGA/g", dec: 2, heat: -1 },
];
function renderTeams() {
  const st = store.get("teams", TM_DEF);
  const rows = D.teams.map((t) => { const r = teamRates(t.id, st.period, st.venue); return { t, ...r, pts: r.w * 3 + r.d, xgd: r.xgf - r.xga }; });
  const stats = {};
  for (const c of TM_COLS.filter((c) => c.heat)) {
    const v = rows.map((r) => r[c.key]); const mu = sum(v) / v.length;
    stats[c.key] = { mu, sd: Math.sqrt(sum(v.map((x) => (x - mu) ** 2)) / v.length) || 1 };
  }
  rows.sort((a, b) => (st.sort === "team" ? a.t.name.localeCompare(b.t.name) : a[st.sort] - b[st.sort]) * st.dir);
  const main = $("#main");
  main.innerHTML = `
    <h1>Teams</h1>
    <p class="lede">Results and expected goals for each team. Per-game columns are shaded against the league: blue is good, red is bad. Click a team for its games.</p>
    <div class="controls">
      <div class="ctl"><span class="lbl">Period</span>${seg("period", [[3, "Last 3"], [6, "Last 6"], [0, "Season"]], st.period)}</div>
      <div class="ctl"><span class="lbl">Venue</span>${seg("venue", [["all", "All"], ["home", "Home"], ["away", "Away"]], st.venue)}</div>
    </div>
    <div class="tablewrap"><table class="grid" id="tmTable">
      <thead><tr>${sortHeader([{ key: "team", label: "Team", cls: "l sticky" }, ...TM_COLS], st)}</tr></thead>
      <tbody>${rows.map((r) => `<tr class="click" data-tid="${r.t.id}"><td class="l sticky"><b>${esc(r.t.name)}</b></td>
        ${TM_COLS.map((c) => `<td class="${c.cls || ""}" ${c.heat ? `style="${heat(clamp((r[c.key] - stats[c.key].mu) / stats[c.key].sd / 2, -1, 1) * c.heat)}"` : ""}>${c.key === "xgd" && r.xgd > 0 ? "+" : ""}${r[c.key].toFixed(c.dec)}</td>`).join("")}
      </tr>`).join("")}</tbody>
    </table></div>`;
  bindControls(main, st, "teams", renderTeams);
  bindSort($("#tmTable"), st, "teams", renderTeams, (k) => (k === "team" || ["ga", "gapg", "xga", "xgapg", "l"].includes(k) ? 1 : -1));
  main.querySelectorAll("tr[data-tid]").forEach((tr) => tr.addEventListener("click", () => openTeam(+tr.dataset.tid)));
}
function openTeam(tid) {
  const t = D.team[tid];
  const games = [...D.games[tid]].reverse();
  const season = new Set(D.dataGws);
  const top = D.players.filter((p) => p.team === tid).map((p) => ({ p, a: aggPlayer(p, season) })).filter((r) => r.a.min > 0).sort((a, b) => b.a.xgi - a.a.xgi).slice(0, 10);
  const res = (g) => (g.gf > g.ga ? "W" : g.gf < g.ga ? "L" : "D");
  $("#panelBody").innerHTML = `
    <div class="phead"><div><h2>${esc(t.name)}</h2></div><button class="x" type="button" aria-label="Close">×</button></div>
    <div class="psec"><h3>Next fixtures</h3>${nextFixtures(tid, 8)}</div>
    <div class="charts" style="margin-top:16px">
      <div class="chart"><h3>xG for per game</h3>${barChart({ gws: D.games[tid].map((g) => g.gw), series: [{ color: "var(--series-1)", values: new Map(D.games[tid].map((g) => [g.gw, g.xgf])) }], height: 120, fmt: f1, tipFor: (gw) => { const g = D.games[tid].find((x) => x.gw === gw); return g ? `GW${gw} ${g.home ? "vs" : "@"} ${D.team[g.opp].short}: xG ${f2(g.xgf)}, scored ${g.gf}` : ""; } })}</div>
      <div class="chart"><h3>xG against per game</h3>${barChart({ gws: D.games[tid].map((g) => g.gw), series: [{ color: "var(--series-2)", values: new Map(D.games[tid].map((g) => [g.gw, g.xga])) }], height: 120, fmt: f1, tipFor: (gw) => { const g = D.games[tid].find((x) => x.gw === gw); return g ? `GW${gw} ${g.home ? "vs" : "@"} ${D.team[g.opp].short}: xGA ${f2(g.xga)}, conceded ${g.ga}` : ""; } })}</div>
    </div>
    <div class="psec"><h3>Shot maps (season)</h3><div id="teamShots"><p class="dim">Loading…</p></div></div>
    <div class="psec"><h3>Results</h3><div class="tablewrap"><table class="grid">
      <thead><tr><th class="l">GW</th><th class="l">Date</th><th class="l">Opp</th><th class="c">Res</th><th>Score</th><th>xGF</th><th>xGA</th></tr></thead>
      <tbody>${games.map((g) => `<tr><td class="l">${g.gw}</td><td class="l">${fmtDate(g.fx.ko)}</td><td class="l">${short(g.opp, g.home)}</td><td class="c">${res(g)}</td><td>${g.gf}–${g.ga}</td><td>${f2(g.xgf)}</td><td>${f2(g.xga)}</td></tr>`).join("") || `<tr><td class="l dim" colspan="7">No games yet.</td></tr>`}</tbody>
    </table></div></div>
    <div class="psec"><h3>Top players by xGI (season)</h3><div class="tablewrap"><table class="grid">
      <thead><tr><th class="l">Player</th><th>£</th><th>Min</th><th>Pts</th><th>G</th><th>xG</th><th>A</th><th>xA</th><th>xGI/90</th></tr></thead>
      <tbody>${top.map((r) => `<tr class="click" data-pid="${r.p.id}"><td class="l"><span class="pos">${r.p.pos}</span><span class="pname">${esc(r.p.name)}</span>${statusFlag(r.p)}</td><td>${r.p.price.toFixed(1)}</td><td>${r.a.min}</td><td>${r.a.pts}</td><td>${r.a.g}</td><td>${f2(r.a.xg)}</td><td>${r.a.a}</td><td>${f2(r.a.xa)}</td><td>${f2(r.a.xgi / r.a.min * 90)}</td></tr>`).join("")}</tbody>
    </table></div></div>`;
  $("#panelBody").querySelectorAll("tr[data-pid]").forEach((tr) => tr.addEventListener("click", () => openPlayer(+tr.dataset.pid)));
  showPanel();
  renderTeamShots(tid);
}

// ---------------------------------------------------------------- DEFCONS
// Defensive-contribution points by opponent: each row is a team, the numbers are what the players
// facing it did. Goalkeepers can't earn DC points, so they're left out.
const DC_DEF = { period: 0, venue: "all", pos: "ALL", sort: "hitpg", dir: -1 };
const DC_POS = ["DEF", "MID", "FWD"];
const DC_COLS = [
  { key: "gp", label: "GP", title: "Games in the window", dec: 0 },
  { key: "apps", label: "60+", title: "Player appearances of 60+ minutes against them", dec: 0, cls: "sep" },
  { key: "hits", label: "Hits", title: "DC hits (+2 points) against them, any minutes", dec: 0 },
  { key: "hitpg", label: "Hits/g", title: "DC hits per game against them", dec: 2, heat: 1 },
  { key: "pct", label: "Hit%", title: "Share of 60+ minute appearances against them that reached the DC threshold", dec: 0, heat: 1, pct: true },
  { key: "dc90", label: "DC/90", title: "Defensive contributions per 90 by the players facing them (CBIT for DEF, CBIRT for MID/FWD)", dec: 1, heat: 1 },
];
const DC_POS_COLS = DC_POS.map((p, i) => ({ key: "pct" + p, label: p + " %", title: `Hit% for ${p === "DEF" ? "defenders (10+ CBIT)" : p === "MID" ? "midfielders (12+ CBIRT)" : "forwards (12+ CBIRT)"}`, dec: 0, heat: 1, pct: true, cls: i ? "" : "sep" }));

/** Outfield player rows by fixture, with the side they played on. */
function rowsByFx() {
  if (D.byFx) return D.byFx;
  const fi = D.fi;
  D.byFx = {};
  for (const p of D.players) {
    if (!DC_POS.includes(p.pos)) continue;
    for (const r of p.log) {
      const f = D.fx[r[fi.fx]];
      // The API only gives a player's current club, so games for a club they've since left are skipped
      if (!f || r[fi.min] <= 0 || (f.h !== p.team && f.a !== p.team)) continue;
      (D.byFx[f.id] ||= []).push({ p, min: r[fi.min], dc: r[fi.dc], hit: r[fi.dch] });
    }
  }
  return D.byFx;
}

/** What the players facing `opp` did in its last `n` games. `venue` is where those players were. */
function dcAgainst(opp, n, venue, pos) {
  const games = teamRates(opp, n, venue === "home" ? "away" : venue === "away" ? "home" : "all").games;
  const byFx = rowsByFx();
  const a = { gp: games.length, apps: 0, hits: 0, min: 0, dc: 0, hits60: 0, by: {}, games: [] };
  for (const ps of DC_POS) a.by[ps] = { apps: 0, hits: 0 };
  for (const g of games) {
    const rows = (byFx[g.fx.id] || []).filter((x) => x.p.team !== opp && (pos === "ALL" || x.p.pos === pos));
    for (const x of rows) {
      a.hits += x.hit; a.min += x.min; a.dc += x.dc;
      if (x.min >= 60) { a.apps++; a.hits60 += x.hit; a.by[x.p.pos].apps++; a.by[x.p.pos].hits += x.hit; }
    }
    a.games.push({ g, rows: rows.sort((x, y) => y.hit - x.hit || y.dc - x.dc) });
  }
  a.hitpg = a.gp ? a.hits / a.gp : null;
  a.pct = a.apps ? (a.hits60 / a.apps) * 100 : null;
  a.dc90 = a.min ? (a.dc / a.min) * 90 : null;
  for (const ps of DC_POS) a["pct" + ps] = a.by[ps].apps ? (a.by[ps].hits / a.by[ps].apps) * 100 : null;
  return a;
}

/** Teams facing `opp` in the next `n` gameweeks; upper case = that team at home. */
function facingNext(opp, n) {
  const out = [];
  for (let gw = D.startGw; gw < D.startGw + n && gw <= 38; gw++) {
    const fs = D.byTeamGw[opp][gw] || [];
    if (!fs.length) out.push(`<span class="chip dim" data-tip="GW${gw}: no fixture">–</span>`);
    for (const f of fs) out.push(`<span class="chip" data-tip="GW${gw}: ${esc(D.team[f.opp].name)} ${f.home ? "away to" : "at home to"} ${esc(D.team[opp].name)}">${short(f.opp, !f.home)}</span>`);
  }
  return `<span class="chips">${out.join("")}</span>`;
}

function renderDefcons() {
  const st = store.get("defcons", DC_DEF);
  const cols = [...DC_COLS, ...(st.pos === "ALL" ? DC_POS_COLS : [])];
  if (st.sort !== "team" && !cols.some((c) => c.key === st.sort)) Object.assign(st, { sort: "hitpg", dir: -1 });
  const rows = D.teams.map((t) => ({ t, ...dcAgainst(t.id, st.period, st.venue, st.pos) }));
  const stats = {};
  for (const c of cols.filter((c) => c.heat)) {
    const v = rows.map((r) => r[c.key]).filter((x) => x != null);
    const mu = sum(v) / (v.length || 1);
    stats[c.key] = { mu, sd: Math.sqrt(sum(v.map((x) => (x - mu) ** 2)) / (v.length || 1)) || 1 };
  }
  const kv = (r) => (st.sort === "team" ? r.t.name : r[st.sort] ?? -Infinity);
  rows.sort((a, b) => { const x = kv(a), y = kv(b); return (typeof x === "string" ? x.localeCompare(y) : x - y) * st.dir; });
  const who = st.pos === "ALL" ? "outfield players" : { DEF: "defenders", MID: "midfielders", FWD: "forwards" }[st.pos];
  const where = st.venue === "home" ? " playing at home against them" : st.venue === "away" ? " playing away against them" : " against them";
  const gamesTip = (r) => r.games.length ? [...r.games].reverse().map(({ g, rows }) =>
    `GW${g.gw} ${esc(D.team[g.opp].short)} ${g.home ? "away" : "home"}: <b>${rows.filter((x) => x.hit).length}</b> hit${rows.filter((x) => x.hit).length === 1 ? "" : "s"}`).join("<br>") : "No games";
  const cell = (r, c) => {
    const v = r[c.key];
    if (v == null) return `<td class="${c.cls || ""} dim">–</td>`;
    const style = c.heat ? `style="${heat(clamp((v - stats[c.key].mu) / stats[c.key].sd / 2, -1, 1) * c.heat)}"` : "";
    const t = c.key === "hitpg" ? `data-tip="${esc(`<b>DC hits by ${who} vs ${r.t.short}</b><br>${gamesTip(r)}`)}"` : "";
    return `<td class="${c.cls || ""}" ${style} ${t}>${v.toFixed(c.dec)}${c.pct ? "%" : ""}</td>`;
  };
  const main = $("#main");
  main.innerHTML = `
    <h1>Defcons</h1>
    <p class="lede">Which teams players get defensive-contribution points against. Each row is a team; the numbers are what ${who}${where} did. <b style="color:var(--accent-ink)">Blue</b> means more defcons than usual for players facing that team. Click a team for each game and who hit the threshold.</p>
    <div class="controls">
      <div class="ctl"><span class="lbl">Period</span>${seg("period", [[3, "Last 3"], [6, "Last 6"], [0, "Season"]], st.period)}</div>
      <div class="ctl"><span class="lbl">Players' venue</span>${seg("venue", [["all", "All"], ["home", "Home"], ["away", "Away"]], st.venue)}</div>
      <div class="ctl"><span class="lbl">Position</span>${seg("pos", [["ALL", "All"], ["DEF", "DEF"], ["MID", "MID"], ["FWD", "FWD"]], st.pos)}</div>
    </div>
    <div class="tablewrap"><table class="grid" id="dcTable">
      <thead><tr>${sortHeader([{ key: "team", label: "Opponent", cls: "l sticky" }, ...cols, { key: "next", label: "Facing them next", cls: "l sep", sortable: false, title: "Teams that play them in the next 5 gameweeks. Upper case = that team is at home." }], st)}</tr></thead>
      <tbody>${rows.map((r) => `<tr class="click" data-tid="${r.t.id}"><td class="l sticky"><b>${esc(r.t.name)}</b></td>
        ${cols.map((c) => cell(r, c)).join("")}
        <td class="l sep">${facingNext(r.t.id, 5)}</td>
      </tr>`).join("")}</tbody>
    </table></div>
    <p class="note">A DC hit is a game where the player reached the defensive-contribution threshold for +2 points: 10 clearances, blocks, interceptions and tackles (CBIT) for defenders, 12 including ball recoveries (CBIRT) for midfielders and forwards. Hit% only counts appearances of 60+ minutes, since short sub appearances rarely get there. Periods are the opponent's last games${st.venue === "all" ? "" : ` at ${st.venue === "home" ? "away" : "home"} (where the players were ${st.venue})`}. Positions are the players' current FPL positions. Players who have changed club since are left out for games at their old club.</p>`;
  bindControls(main, st, "defcons", renderDefcons);
  bindSort($("#dcTable"), st, "defcons", renderDefcons, (k) => (k === "team" ? 1 : -1));
  main.querySelectorAll("tr[data-tid]").forEach((tr) => tr.addEventListener("click", (e) => { if (!e.target.closest(".chip")) openDcTeam(+tr.dataset.tid, st); }));
}

function openDcTeam(tid, st) {
  const t = D.team[tid];
  const a = dcAgainst(tid, st.period, st.venue, st.pos);
  const pct = (h, n) => (n ? `${Math.round((h / n) * 100)}%` : "–");
  const hitter = (x) => `<span class="dchit" data-tip="${esc(`${x.p.name} (${x.p.pos}): ${x.dc} ${x.p.pos === "DEF" ? "CBIT" : "CBIRT"} in ${x.min} min`)}"><span class="pos">${x.p.pos}</span>${esc(x.p.name)} <b>${x.dc}</b></span>`;
  $("#panelBody").innerHTML = `
    <div class="phead"><div><h2>Defcons against ${esc(t.name)}</h2>
      <div class="facts"><span>${st.period ? `Last ${st.period}` : "Season"}</span><span>${st.venue === "all" ? "Home and away" : `Players ${st.venue === "home" ? "at home" : "away"}`}</span><span>${st.pos === "ALL" ? "All outfield positions" : st.pos}</span></div></div>
      <button class="x" type="button" aria-label="Close">×</button></div>
    <div class="facts"><span><b>${f2(a.hitpg)}</b> hits per game</span>${DC_POS.map((ps) => a.by[ps].apps ? `<span>${ps}: <b>${a.by[ps].hits}</b> of ${a.by[ps].apps} (${pct(a.by[ps].hits, a.by[ps].apps)})</span>` : "").join("")}</div>
    <div class="psec"><h3>Facing them next</h3>${facingNext(tid, 8)}</div>
    <div class="psec"><h3>Games</h3><div class="tablewrap"><table class="grid">
      <thead><tr><th class="l">GW</th><th class="l">Team</th><th>Score</th><th>Hits</th><th>60+</th><th class="l">Players who hit the threshold</th></tr></thead>
      <tbody>${[...a.games].reverse().map(({ g, rows }) => { const hits = rows.filter((x) => x.hit); return `<tr>
        <td class="l">${g.gw}</td><td class="l" data-tip="${esc(D.team[g.opp].name)} ${g.home ? "away" : "at home"}">${short(g.opp, !g.home)}</td>
        <td>${g.ga}–${g.gf}</td><td>${hits.length}</td><td>${rows.filter((x) => x.min >= 60).length}</td>
        <td class="l">${hits.map(hitter).join("") || `<span class="dim">None</span>`}</td></tr>`; }).join("") || `<tr><td class="l dim" colspan="6">No games in this window.</td></tr>`}</tbody>
    </table></div><p class="note">Team is the side facing ${esc(t.short)}, upper case = at home. Score is from that team's side; the number after each name is their defensive contributions.</p></div>`;
  showPanel();
}

// ---------------------------------------------------------------- router & boot
const VIEWS = { players: renderPlayers, ticker: renderTicker, schedule: renderSchedule, teams: renderTeams, defcons: renderDefcons };
function route() {
  const v = location.hash.slice(1) in VIEWS ? location.hash.slice(1) : "players";
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.view === v));
  tip.hidden = true;
  VIEWS[v]();
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("fplshades.theme"); } catch { /* ignore */ }
  if (saved) document.documentElement.dataset.theme = saved;
  $("#themeBtn").addEventListener("click", () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("fplshades.theme", next); } catch { /* ignore */ }
    readPalette(); route();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readPalette(); route(); });
}

(async function boot() {
  initTheme();
  readPalette();
  try {
    await load();
  } catch (e) {
    $("#main").innerHTML = `<p class="empty">Couldn't load the data (${esc(e.message)}). Run <code>python fetch/fetch_data.py</code> first, then serve the <code>site</code> folder.</p>`;
    return;
  }
  const upd = new Date(D.meta.updated);
  $("#meta").textContent = `${D.meta.season} · next GW${D.startGw} · updated ${upd.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  addEventListener("hashchange", route);
  route();
})();
