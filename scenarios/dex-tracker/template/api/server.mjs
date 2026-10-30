#!/usr/bin/env node
// Dex Tracker API: the backend the app is built on. Serves data/dex.sqlite as JSON, plus
// sprite and artwork images. Documented in api/openapi.json.
//
// Each start works on a fresh copy of the database, so writes (POST) last until the server
// stops.
//
// Env:
//   PORT         port to listen on (default 9000)
//   PUBLIC_URL   origin used for absolute media URLs in responses (default http://localhost:$PORT)
//   LATENCY_MS   delay added to every /api response, like a real service's processing
//                time (default 30)
//   API_OVERLAY  path to a SQL file run against the copy at startup (tests use this to
//                change the data after the app was built)

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(ROOT, 'data/dex.sqlite');
const MEDIA_DIR = path.join(ROOT, 'data/media');
const OPENAPI = fs.readFileSync(path.join(ROOT, 'api/openapi.json'), 'utf8');

const PORT = Number(process.env.PORT ?? 9000);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const LATENCY_MS = Number(process.env.LATENCY_MS || 30);

if (!fs.existsSync(DB_FILE)) {
  console.error(`No database at ${DB_FILE}. Run npm run setup-data first.`);
  process.exit(1);
}
const workFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dex-api-')), 'dex.sqlite');
fs.copyFileSync(DB_FILE, workFile);
const db = new DatabaseSync(workFile);
db.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;');
if (process.env.API_OVERLAY) db.exec(fs.readFileSync(process.env.API_OVERLAY, 'utf8'));
process.on('exit', () => fs.rmSync(path.dirname(workFile), { recursive: true, force: true }));

// ---------- Queries ----------

const stmts = new Map();
const prepare = (sql) => {
  if (!stmts.has(sql)) stmts.set(sql, db.prepare(sql));
  return stmts.get(sql);
};
const all = (sql, ...params) => prepare(sql).all(...params);
const get = (sql, ...params) => prepare(sql).get(...params);

const TODAY = get(`SELECT value FROM meta WHERE key = 'today'`).value;
const abs = (url) => (url ? PUBLIC_URL + url : null);

// Reference data never changes, so it's read once.
const typeRefs = new Map(all('SELECT name, display_name FROM type ORDER BY id').map((t) => [t.name, { name: t.name, displayName: t.display_name }]));
const generationRefs = new Map(all('SELECT id, name, display_name FROM generation ORDER BY id').map((g) => [g.id, { name: g.name, displayName: g.display_name }]));
const speciesRows = new Map(all('SELECT * FROM species').map((s) => [s.id, s]));
const speciesByName = new Map([...speciesRows.values()].map((s) => [s.name, s]));
const gameRows = new Map(all('SELECT * FROM game ORDER BY release_order, id').map((g) => [g.id, g]));

const speciesRef = (id) => {
  const s = speciesRows.get(id);
  return { id: s.id, name: s.name, displayName: s.display_name, sprite: abs(s.sprite), types: [s.type1, s.type2].filter(Boolean).map((t) => typeRefs.get(t)) };
};
const gameRef = (id) => (id ? { id, displayName: gameRows.get(id).display_name } : null);
const friendRef = (id) => {
  const f = get('SELECT id, name FROM friend WHERE id = ?', id);
  return { id: f.id, name: f.name };
};

const MISSING = 'SELECT id FROM species WHERE id NOT IN (SELECT species_id FROM catch) ORDER BY id';
const missingIds = () => all(MISSING).map((r) => r.id);

// ---------- Request helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const notFound = () => new HttpError(404, 'Not found');

function intParam(url, name, { min = 1, max = Infinity, fallback }) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be an integer from ${min}${max === Infinity ? '' : ` to ${max}`}`);
  return n;
}
function enumParam(url, name, values, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  if (!values.includes(raw)) throw new HttpError(400, `${name} must be one of: ${values.join(', ')}`);
  return raw;
}
function boolParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  if (raw !== 'true' && raw !== 'false') throw new HttpError(400, `${name} must be true or false`);
  return raw === 'true';
}
function gameParam(url, name = 'game') {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  if (!gameRows.has(raw)) throw new HttpError(400, `Unknown ${name}: ${raw}`);
  return raw;
}
function generationParam(url) {
  const raw = url.searchParams.get('generation');
  if (raw === null || raw === '') return undefined;
  const g = [...generationRefs].find(([, ref]) => ref.name === raw);
  if (!g) throw new HttpError(400, `Unknown generation: ${raw}`);
  return g[0];
}

// Paging: ?page (1-based) and ?pageSize. Returns the response envelope around `rows`.
function paging(url, defaultSize) {
  const page = intParam(url, 'page', { fallback: 1 });
  const pageSize = intParam(url, 'pageSize', { max: 100, fallback: defaultSize });
  return {
    page,
    pageSize,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    envelope: (items, total) => ({ items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }),
  };
}

// WHERE clause builder.
function where(conditions) {
  const parts = conditions.filter(([cond]) => cond);
  return {
    sql: parts.length ? `WHERE ${parts.map(([, sql]) => sql).join(' AND ')}` : '',
    params: parts.flatMap(([, , ...params]) => params),
  };
}

// ---------- Shapes ----------

const catchJson = (c) => ({
  id: c.id,
  species: speciesRef(c.species_id),
  game: gameRef(c.game_id),
  caughtAt: c.caught_at,
  level: c.level,
  shiny: !!c.shiny,
  method: c.method,
  ball: c.ball,
  nickname: c.nickname,
  tradeId: c.trade_id,
  huntId: c.hunt_id,
});
const tradeJson = (t) => ({
  id: t.id,
  tradedAt: t.traded_at,
  friend: friendRef(t.friend_id),
  game: gameRef(t.game_id),
  gave: speciesRef(t.gave_id),
  received: speciesRef(t.received_id),
  evolved: !!t.evolved,
});
const huntJson = (h) => ({
  id: h.id,
  species: speciesRef(h.species_id),
  game: gameRef(h.game_id),
  method: h.method,
  startedAt: h.started_at,
  endedAt: h.ended_at,
  status: h.status,
  encounters: h.encounters,
});

// Months ending with TODAY's month, oldest first: ['2024-11', ..., '2026-10'].
function lastMonths(n) {
  const [y, m] = TODAY.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

// ---------- Routes ----------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}/?$`), handler });

route('GET', '/api/openapi.json', () => JSON.parse(OPENAPI));

route('GET', '/api/me', () => {
  const meta = Object.fromEntries(all('SELECT key, value FROM meta').map((r) => [r.key, r.value]));
  const one = (sql) => Object.values(get(sql))[0];
  return {
    name: meta.trainer,
    friendCode: meta.friend_code,
    since: meta.since,
    today: TODAY,
    stats: {
      speciesCaught: one('SELECT COUNT(DISTINCT species_id) FROM catch'),
      speciesTotal: speciesRows.size,
      catchCount: one('SELECT COUNT(*) FROM catch'),
      shinyCount: one('SELECT COUNT(*) FROM catch WHERE shiny = 1'),
      tradeCount: one('SELECT COUNT(*) FROM trade'),
      hoursPlayed: Math.round(one('SELECT COALESCE(SUM(minutes), 0) FROM session') / 60),
      gamesOwned: one('SELECT COUNT(*) FROM my_game'),
      activeHunts: one(`SELECT COUNT(*) FROM hunt WHERE status = 'active'`),
    },
  };
});

route('GET', '/api/meta', () => ({
  today: TODAY,
  generations: [...generationRefs.values()],
  types: [...typeRefs.values()],
  games: [...gameRows.values()].map((g) => ({ ...gameRef(g.id), generation: generationRefs.get(g.generation_id), platform: g.platform })),
  catchMethods: all('SELECT DISTINCT method FROM catch ORDER BY method').map((r) => r.method),
  huntMethods: all('SELECT DISTINCT method FROM hunt ORDER BY method').map((r) => r.method),
}));

route('GET', '/api/stats/completion-by-game', () => ({
  items: all(`
    SELECT g.id, g.dex_size,
      (SELECT COUNT(DISTINCT c.species_id) FROM catch c JOIN dex_entry d ON d.game_id = c.game_id AND d.species_id = c.species_id WHERE c.game_id = g.id) AS caught
    FROM my_game m JOIN game g ON g.id = m.game_id WHERE g.dex_size > 0 ORDER BY g.release_order, g.id`).map((r) => ({
    game: gameRef(r.id),
    caught: r.caught,
    dexSize: r.dex_size,
    percent: Math.round((r.caught / r.dex_size) * 1000) / 10,
  })),
}));

route('GET', '/api/stats/catches-by-month', () => {
  const months = lastMonths(24);
  const counts = new Map(all(`SELECT substr(caught_at, 1, 7) AS month, COUNT(*) AS n FROM catch WHERE caught_at >= ? GROUP BY month`, `${months[0]}-01`).map((r) => [r.month, r.n]));
  return { items: months.map((month) => ({ month, count: counts.get(month) ?? 0 })) };
});

route('GET', '/api/activity', (url) => {
  const limit = intParam(url, 'limit', { max: 50, fallback: 10 });
  const offset = intParam(url, 'offset', { min: 0, fallback: 0 });
  const n = limit + offset + 1;
  // Catches that came from a trade or a shiny hunt show up as that trade or hunt instead.
  const rows = all(
    `SELECT * FROM (
       SELECT * FROM (SELECT 'trade' AS type, id, traded_at AS date, 2 AS rank FROM trade ORDER BY traded_at DESC, id DESC LIMIT ?)
       UNION ALL SELECT * FROM (SELECT 'hunt', id, ended_at, 1 FROM hunt WHERE status = 'completed' ORDER BY ended_at DESC, id DESC LIMIT ?)
       UNION ALL SELECT * FROM (SELECT 'catch', id, caught_at, 0 FROM catch WHERE trade_id IS NULL AND hunt_id IS NULL ORDER BY caught_at DESC, id DESC LIMIT ?)
     ) ORDER BY date DESC, rank DESC, id DESC LIMIT ? OFFSET ?`,
    n, n, n, limit + 1, offset,
  );
  const items = rows.slice(0, limit).map((r) => {
    if (r.type === 'trade') return { type: 'trade', ...tradeJson(get('SELECT * FROM trade WHERE id = ?', r.id)), date: r.date };
    if (r.type === 'hunt') return { type: 'hunt', ...huntJson(get('SELECT * FROM hunt WHERE id = ?', r.id)), date: r.date };
    return { type: 'catch', ...catchJson(get('SELECT * FROM catch WHERE id = ?', r.id)), date: r.date };
  });
  return { items, hasMore: rows.length > limit };
});

// What the trainer still needs, and how to get each one.
function needInfo(id) {
  const wildIn = all(`SELECT w.game_id FROM wild w JOIN my_game m ON m.game_id = w.game_id JOIN game g ON g.id = w.game_id WHERE w.species_id = ? ORDER BY g.release_order, g.id`, id).map((r) => gameRef(r.game_id));
  const friendCount = get('SELECT COUNT(*) AS n FROM friend_species WHERE species_id = ?', id).n;
  const evo = get(`SELECT from_id, how FROM evolution WHERE to_id = ? AND trigger = 'trade'`, id);
  return { wildIn, friendCount, tradeEvolution: evo ? { from: speciesRef(evo.from_id), how: evo.how } : null };
}
route('GET', '/api/needs', (url) => {
  const generation = generationParam(url);
  const source = enumParam(url, 'source', ['all', 'wild', 'friends', 'trade-evolution'], 'all');
  const sort = enumParam(url, 'sort', ['dex', 'friends'], 'dex');
  const p = paging(url, 50);
  let rows = missingIds()
    .map((id) => speciesRows.get(id))
    .filter((s) => generation === undefined || s.generation_id === generation)
    .map((s) => ({ id: s.id, generation: s.generation_id, ...needInfo(s.id) }))
    .filter((r) => source === 'all' || (source === 'wild' ? r.wildIn.length : source === 'friends' ? r.friendCount : r.tradeEvolution));
  if (sort === 'friends') rows.sort((a, b) => b.friendCount - a.friendCount || a.id - b.id);
  const items = rows.slice(p.offset, p.offset + p.limit).map((r) => ({
    species: speciesRef(r.id),
    generation: generationRefs.get(r.generation),
    wildIn: r.wildIn,
    friendCount: r.friendCount,
    tradeEvolution: r.tradeEvolution,
  }));
  return p.envelope(items, rows.length);
});

route('GET', '/api/species', (url) => {
  const q = url.searchParams.get('q')?.trim().toLowerCase() ?? '';
  const p = paging(url, 20);
  const caught = new Set(all('SELECT DISTINCT species_id FROM catch').map((r) => r.species_id));
  const matches = [...speciesRows.values()].filter((s) => !q || s.display_name.toLowerCase().includes(q) || s.name.includes(q)).sort((a, b) => a.id - b.id);
  return p.envelope(matches.slice(p.offset, p.offset + p.limit).map((s) => ({ ...speciesRef(s.id), caught: caught.has(s.id) })), matches.length);
});

route('GET', '/api/species/:name', (url, { name }) => {
  const s = speciesByName.get(name);
  if (!s) throw notFound();
  const mine = get('SELECT COUNT(*) AS caught, COALESCE(SUM(shiny), 0) AS shiny, MIN(caught_at) AS first, MAX(caught_at) AS last FROM catch WHERE species_id = ?', s.id);
  // The whole evolution family, from its base species.
  const links = all('SELECT e.* FROM evolution e JOIN species s ON s.id = e.from_id WHERE s.chain_id = ?', s.chain_id);
  const base = [...speciesRows.values()].filter((x) => x.chain_id === s.chain_id && !links.some((l) => l.to_id === x.id)).sort((a, b) => a.id - b.id)[0] ?? s;
  const tree = (id, how = null, trigger = null) => ({
    species: speciesRef(id),
    how,
    trade: trigger === 'trade',
    evolvesTo: links.filter((l) => l.from_id === id).sort((a, b) => a.to_id - b.to_id).map((l) => tree(l.to_id, l.how, l.trigger)),
  });
  const availability = all(`
    SELECT d.game_id,
      EXISTS (SELECT 1 FROM wild w WHERE w.game_id = d.game_id AND w.species_id = d.species_id) AS wild,
      EXISTS (SELECT 1 FROM my_game m WHERE m.game_id = d.game_id) AS owned
    FROM dex_entry d JOIN game g ON g.id = d.game_id WHERE d.species_id = ? ORDER BY g.release_order, g.id`, s.id);
  const friendTotal = get('SELECT COUNT(*) AS n FROM friend_species WHERE species_id = ?', s.id).n;
  return {
    species: { ...speciesRef(s.id), genus: s.genus, generation: generationRefs.get(s.generation_id), artwork: abs(s.artwork), legendary: !!s.legendary, mythical: !!s.mythical },
    mine: { caught: mine.caught, shiny: mine.shiny, firstCaught: mine.first, lastCaught: mine.last },
    evolution: tree(base.id),
    availability: availability.map((a) => ({ game: gameRef(a.game_id), wild: !!a.wild, owned: !!a.owned })),
    friends: {
      total: friendTotal,
      items: all('SELECT f.id, f.name FROM friend_species fs JOIN friend f ON f.id = fs.friend_id WHERE fs.species_id = ? ORDER BY f.name LIMIT 12', s.id),
    },
  };
});

route('GET', '/api/species/:name/catches', (url, { name }) => {
  const s = speciesByName.get(name);
  if (!s) throw notFound();
  const p = paging(url, 20);
  const total = get('SELECT COUNT(*) AS n FROM catch WHERE species_id = ?', s.id).n;
  const rows = all('SELECT * FROM catch WHERE species_id = ? ORDER BY caught_at DESC, id DESC LIMIT ? OFFSET ?', s.id, p.limit, p.offset);
  return p.envelope(rows.map(catchJson), total);
});

const CATCH_SORTS = { '-date': 'caught_at DESC, id DESC', date: 'caught_at, id', '-level': 'level DESC, caught_at DESC, id DESC', level: 'level, caught_at DESC, id DESC', dex: 'species_id, caught_at DESC, id DESC' };
route('GET', '/api/catches', (url) => {
  const game = gameParam(url);
  const shiny = boolParam(url, 'shiny');
  const method = url.searchParams.get('method') || undefined;
  const speciesName = url.searchParams.get('species') || undefined;
  if (speciesName && !speciesByName.has(speciesName)) throw new HttpError(400, `Unknown species: ${speciesName}`);
  const sort = enumParam(url, 'sort', Object.keys(CATCH_SORTS), '-date');
  const p = paging(url, 50);
  const w = where([
    [game, 'game_id = ?', game],
    [shiny !== undefined, 'shiny = ?', shiny ? 1 : 0],
    [method, 'method = ?', method],
    [speciesName, 'species_id = ?', speciesByName.get(speciesName)?.id],
  ]);
  const total = get(`SELECT COUNT(*) AS n FROM catch ${w.sql}`, ...w.params).n;
  const rows = all(`SELECT * FROM catch ${w.sql} ORDER BY ${CATCH_SORTS[sort]} LIMIT ? OFFSET ?`, ...w.params, p.limit, p.offset);
  return p.envelope(rows.map(catchJson), total);
});

const DEX_CAUGHT = `(SELECT COUNT(DISTINCT c.species_id) FROM catch c JOIN dex_entry d ON d.game_id = c.game_id AND d.species_id = c.species_id WHERE c.game_id = g.id)`;
route('GET', '/api/games', () => ({
  items: all(`
    SELECT g.*, m.copies, m.playthroughs, m.started_at, m.last_played, ${DEX_CAUGHT} AS dex_caught,
      (SELECT COALESCE(SUM(minutes), 0) FROM session s WHERE s.game_id = g.id) AS minutes
    FROM my_game m JOIN game g ON g.id = m.game_id ORDER BY g.release_order, g.id`).map((g) => ({
    game: gameRef(g.id),
    generation: generationRefs.get(g.generation_id),
    platform: g.platform,
    copies: g.copies,
    playthroughs: g.playthroughs,
    hours: Math.round(g.minutes / 60),
    startedAt: g.started_at,
    lastPlayed: g.last_played,
    dexSize: g.dex_size,
    dexCaught: g.dex_caught,
  })),
}));

route('GET', '/api/games/:id', (url, { id }) => {
  const g = gameRows.get(id);
  if (!g) throw notFound();
  const m = get(`SELECT m.*, ${DEX_CAUGHT} AS dex_caught FROM my_game m JOIN game g ON g.id = m.game_id WHERE m.game_id = ?`, id);
  const counts = get('SELECT COUNT(*) AS n, COALESCE(SUM(shiny), 0) AS shiny FROM catch WHERE game_id = ?', id);
  const minutes = get('SELECT COALESCE(SUM(minutes), 0) AS n FROM session WHERE game_id = ?', id).n;
  const months = lastMonths(12);
  const byMonth = new Map(all('SELECT substr(date, 1, 7) AS month, SUM(minutes) AS n FROM session WHERE game_id = ? AND date >= ? GROUP BY month', id, `${months[0]}-01`).map((r) => [r.month, r.n]));
  // Version exclusives: wild in the counterpart version but not in this one.
  const exclusives = g.counterpart
    ? all(`
        SELECT w.species_id, EXISTS (SELECT 1 FROM catch c WHERE c.species_id = w.species_id) AS caught
        FROM wild w WHERE w.game_id = ? AND w.species_id NOT IN (SELECT species_id FROM wild WHERE game_id = ?) ORDER BY w.species_id`, g.counterpart, id)
    : [];
  return {
    game: { ...gameRef(id), generation: generationRefs.get(g.generation_id), platform: g.platform },
    counterpart: gameRef(g.counterpart),
    dexSize: g.dex_size,
    mine: m
      ? { copies: m.copies, playthroughs: m.playthroughs, startedAt: m.started_at, lastPlayed: m.last_played, hours: Math.round(minutes / 60), dexCaught: m.dex_caught, catchCount: counts.n, shinyCount: counts.shiny }
      : null,
    hoursByMonth: months.map((month) => ({ month, hours: Math.round((byMonth.get(month) ?? 0) / 6) / 10 })),
    counterpartExclusives: exclusives.map((e) => ({ species: speciesRef(e.species_id), caught: !!e.caught })),
  };
});

route('GET', '/api/games/:id/dex', (url, { id }) => {
  if (!gameRows.has(id)) throw notFound();
  const status = enumParam(url, 'status', ['all', 'caught', 'missing'], 'all');
  const p = paging(url, 50);
  const caughtExpr = 'EXISTS (SELECT 1 FROM catch c WHERE c.game_id = d.game_id AND c.species_id = d.species_id)';
  const filter = status === 'all' ? '' : `AND ${status === 'caught' ? '' : 'NOT '}${caughtExpr}`;
  const total = get(`SELECT COUNT(*) AS n FROM dex_entry d WHERE d.game_id = ? ${filter}`, id).n;
  const rows = all(`SELECT d.number, d.species_id, ${caughtExpr} AS caught FROM dex_entry d WHERE d.game_id = ? ${filter} ORDER BY d.number LIMIT ? OFFSET ?`, id, p.limit, p.offset);
  return p.envelope(rows.map((r) => ({ number: r.number, species: speciesRef(r.species_id), caught: !!r.caught })), total);
});

const FRIEND_COLUMNS = `
  f.id, f.name, f.friend_code, f.since,
  (SELECT COUNT(*) FROM friend_game fg WHERE fg.friend_id = f.id) AS game_count,
  (SELECT COUNT(*) FROM trade t WHERE t.friend_id = f.id) AS trade_count,
  (SELECT MAX(traded_at) FROM trade t WHERE t.friend_id = f.id) AS last_trade,
  (SELECT COUNT(*) FROM friend_species fs WHERE fs.friend_id = f.id AND fs.species_id IN (${MISSING})) AS can_help`;
const FRIEND_SORTS = { name: 'name, id', trades: 'trade_count DESC, name, id', 'can-help': 'can_help DESC, name, id', 'last-trade': 'last_trade IS NULL, last_trade DESC, name, id' };
route('GET', '/api/friends', (url) => {
  const sort = enumParam(url, 'sort', Object.keys(FRIEND_SORTS), 'name');
  const p = paging(url, 25);
  const total = get('SELECT COUNT(*) AS n FROM friend').n;
  const rows = all(`SELECT ${FRIEND_COLUMNS} FROM friend f ORDER BY ${FRIEND_SORTS[sort]} LIMIT ? OFFSET ?`, p.limit, p.offset);
  return p.envelope(
    rows.map((f) => ({ friend: { id: f.id, name: f.name }, friendCode: f.friend_code, since: f.since, gameCount: f.game_count, tradeCount: f.trade_count, lastTradeAt: f.last_trade, canHelp: f.can_help })),
    total,
  );
});

route('GET', '/api/friends/:id', (url, { id }) => {
  const f = /^\d+$/.test(id) && get(`SELECT ${FRIEND_COLUMNS}, (SELECT MIN(traded_at) FROM trade t WHERE t.friend_id = f.id) AS first_trade FROM friend f WHERE f.id = ?`, Number(id));
  if (!f) throw notFound();
  const games = all('SELECT fg.game_id FROM friend_game fg JOIN game g ON g.id = fg.game_id WHERE fg.friend_id = ? ORDER BY g.release_order, g.id', f.id);
  const canHelp = all(`SELECT species_id FROM friend_species WHERE friend_id = ? AND species_id IN (${MISSING}) ORDER BY species_id`, f.id);
  const byYear = new Map(all(`SELECT substr(traded_at, 1, 4) AS year, COUNT(*) AS n FROM trade WHERE friend_id = ? GROUP BY year`, f.id).map((r) => [r.year, r.n]));
  const firstYear = Number((f.first_trade ?? f.since).slice(0, 4));
  const years = Array.from({ length: Number(TODAY.slice(0, 4)) - firstYear + 1 }, (_, i) => String(firstYear + i));
  return {
    friend: { id: f.id, name: f.name },
    friendCode: f.friend_code,
    since: f.since,
    games: games.map((g) => gameRef(g.game_id)),
    tradeCount: f.trade_count,
    firstTradeAt: f.first_trade,
    lastTradeAt: f.last_trade,
    canHelp: canHelp.map((r) => speciesRef(r.species_id)),
    tradesByYear: years.map((year) => ({ year, count: byYear.get(year) ?? 0 })),
  };
});

route('GET', '/api/trades', (url) => {
  const friendId = intParam(url, 'friend', { fallback: undefined });
  const game = gameParam(url);
  const evolved = boolParam(url, 'evolved');
  const year = intParam(url, 'year', { min: 1996, max: 2100, fallback: undefined });
  const sort = enumParam(url, 'sort', ['-date', 'date'], '-date');
  const p = paging(url, 50);
  const w = where([
    [friendId !== undefined, 'friend_id = ?', friendId],
    [game, 'game_id = ?', game],
    [evolved !== undefined, 'evolved = ?', evolved ? 1 : 0],
    [year !== undefined, 'traded_at LIKE ?', `${year}-%`],
  ]);
  const total = get(`SELECT COUNT(*) AS n FROM trade ${w.sql}`, ...w.params).n;
  const rows = all(`SELECT * FROM trade ${w.sql} ORDER BY ${sort === 'date' ? 'traded_at, id' : 'traded_at DESC, id DESC'} LIMIT ? OFFSET ?`, ...w.params, p.limit, p.offset);
  return p.envelope(rows.map(tradeJson), total);
});

route('GET', '/api/trades/:id', (url, { id }) => {
  const t = /^\d+$/.test(id) && get('SELECT * FROM trade WHERE id = ?', Number(id));
  if (!t) throw notFound();
  const evo = t.evolved ? get(`SELECT from_id, how FROM evolution WHERE to_id = ? AND trigger = 'trade'`, t.received_id) : null;
  return { ...tradeJson(t), evolvedFrom: evo ? speciesRef(evo.from_id) : null, evolutionMethod: evo?.how ?? null };
});

route('POST', '/api/trades', (url, params, body) => {
  const { friendId, game, gave, received } = body ?? {};
  const tradedAt = body?.tradedAt ?? TODAY;
  if (!Number.isInteger(friendId) || !get('SELECT 1 FROM friend WHERE id = ?', friendId)) throw new HttpError(400, 'friendId must be the id of a friend');
  if (!get('SELECT 1 FROM my_game WHERE game_id = ?', game ?? '')) throw new HttpError(400, 'game must be the id of a game you own');
  for (const [field, value] of [['gave', gave], ['received', received]]) {
    if (!speciesByName.has(value)) throw new HttpError(400, `${field} must be a species name, such as pikachu`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradedAt) || Number.isNaN(Date.parse(tradedAt)) || tradedAt > TODAY) throw new HttpError(400, `tradedAt must be a date (YYYY-MM-DD) no later than ${TODAY}`);
  const id = get('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM trade').id;
  db.exec('BEGIN');
  prepare('INSERT INTO trade (id, traded_at, friend_id, game_id, gave_id, received_id, evolved) VALUES (?, ?, ?, ?, ?, ?, 0)').run(id, tradedAt, friendId, game, speciesByName.get(gave).id, speciesByName.get(received).id);
  prepare(`INSERT INTO catch (species_id, game_id, caught_at, level, shiny, method, ball, nickname, trade_id, hunt_id) VALUES (?, ?, ?, 1, 0, 'Trade', NULL, NULL, ?, NULL)`).run(speciesByName.get(received).id, game, tradedAt, id);
  db.exec('COMMIT');
  return [201, tradeJson(get('SELECT * FROM trade WHERE id = ?', id))];
});

const HUNT_SORTS = { '-started': 'started_at DESC, id DESC', encounters: 'encounters DESC, id DESC' };
route('GET', '/api/hunts', (url) => {
  const status = enumParam(url, 'status', ['active', 'completed', 'failed'], undefined);
  const sort = enumParam(url, 'sort', Object.keys(HUNT_SORTS), '-started');
  const p = paging(url, 25);
  const w = where([[status, 'status = ?', status]]);
  const total = get(`SELECT COUNT(*) AS n FROM hunt ${w.sql}`, ...w.params).n;
  const rows = all(`SELECT * FROM hunt ${w.sql} ORDER BY ${HUNT_SORTS[sort]} LIMIT ? OFFSET ?`, ...w.params, p.limit, p.offset);
  return p.envelope(rows.map(huntJson), total);
});

route('GET', '/api/hunts/:id', (url, { id }) => {
  const h = /^\d+$/.test(id) && get('SELECT * FROM hunt WHERE id = ?', Number(id));
  if (!h) throw notFound();
  return huntJson(h);
});

route('POST', '/api/hunts/:id/encounters', (url, { id }, body) => {
  const h = /^\d+$/.test(id) && get('SELECT * FROM hunt WHERE id = ?', Number(id));
  if (!h) throw notFound();
  if (h.status !== 'active') throw new HttpError(409, 'Only active hunts can add encounters');
  const count = body?.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new HttpError(400, 'count must be an integer from 1 to 1000');
  prepare('UPDATE hunt SET encounters = encounters + ? WHERE id = ?').run(count, h.id);
  return huntJson(get('SELECT * FROM hunt WHERE id = ?', h.id));
});

// ---------- Server ----------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const delay = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : undefined);

function send(res, status, body) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
}

async function handleMedia(res, url) {
  const file = path.resolve(MEDIA_DIR, decodeURIComponent(url.pathname.slice('/media/'.length)));
  if (!file.startsWith(MEDIA_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { ...CORS, 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=86400' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (url.pathname.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) return await handleMedia(res, url);
    if (url.pathname === '/') return send(res, 200, { name: 'Dex Tracker API', openapi: `${PUBLIC_URL}/api/openapi.json` });
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    await delay(LATENCY_MS);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const matches = routes.filter((r) => r.re.test(url.pathname));
    const r = matches.find((m) => m.method === method);
    if (!r) return send(res, matches.length ? 405 : 404, { error: matches.length ? 'Method not allowed' : 'Not found' });
    const params = Object.fromEntries(Object.entries(url.pathname.match(r.re).groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
    const body = method === 'POST' ? await readBody(req) : undefined;
    const result = r.handler(url, params, body);
    const [status, payload] = Array.isArray(result) ? result : [200, result];
    send(res, status, payload);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    else res.end();
  }
});

server.keepAliveTimeout = 65_000;
server.listen(PORT, () => {
  console.log(`Dex Tracker API listening on ${PUBLIC_URL} (latency ${LATENCY_MS}ms${process.env.API_OVERLAY ? `, overlay ${process.env.API_OVERLAY}` : ''})`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
