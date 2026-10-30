// Checks that the Dex Tracker API works and matches api/openapi.json. Not part of the
// benchmark (agents never see these); run after changing the API, the data or the spec:
//
//   node --test scenarios/dex-tracker/api-tests/
//
// Needs data/dex.sqlite (template/scripts/setup-data.sh, or build-db.mjs).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../template');
const SPEC = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'api/openapi.json'), 'utf8'));

// ---------- A small JSON Schema validator (the subset openapi.json uses) ----------

function resolve(schema) {
  return schema.$ref ? resolve(SPEC.components.schemas[schema.$ref.split('/').pop()]) : schema;
}
function validate(value, schema, at = '$') {
  schema = resolve(schema);
  const errors = [];
  if (schema.anyOf) {
    const results = schema.anyOf.map((s) => validate(value, s, at));
    if (!results.some((r) => !r.length)) errors.push(`${at}: matches none of anyOf (${results.map((r) => r[0]).join(' | ')})`);
    return errors;
  }
  if (schema.allOf) return schema.allOf.flatMap((s) => validate(value, s, at));
  const typeOk = {
    object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    array: Array.isArray,
    string: (v) => typeof v === 'string',
    integer: Number.isInteger,
    number: (v) => typeof v === 'number',
    boolean: (v) => typeof v === 'boolean',
    null: (v) => v === null,
  };
  if (schema.type && !typeOk[schema.type](value)) return [`${at}: expected ${schema.type}, got ${JSON.stringify(value)?.slice(0, 60)}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${value} not in ${schema.enum}`);
  if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`${at}: not a date: ${value}`);
  if (schema.format === 'uri' && !/^https?:\/\//.test(value)) errors.push(`${at}: not an absolute URL: ${value}`);
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}: missing ${key}`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in value) errors.push(...validate(value[key], sub, `${at}.${key}`));
    // Responses shouldn't carry undocumented fields (allOf combines several objects, so skip there).
    if (schema.properties && !schema._partial) for (const key of Object.keys(value)) if (!(key in schema.properties) && !resolve.allowExtra) errors.push(`${at}: undocumented field ${key}`);
  }
  if (schema.type === 'array') value.forEach((v, i) => errors.push(...validate(v, schema.items, `${at}[${i}]`)));
  return errors;
}
// allOf parts each describe some of an object's fields, so extra fields are fine inside them.
function markPartials(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.allOf) for (const part of schema.allOf) resolve(part)._partial = true;
  for (const v of Object.values(schema)) markPartials(v);
}
markPartials(SPEC);
// Shared schemas used both inside allOf and on their own can't be strict in both places.
for (const name of ['Trade', 'Hunt', 'Catch', 'SpeciesRef', 'GameRef']) SPEC.components.schemas[name]._partial = true;

// ---------- API server ----------

const PORT = 9411;
const BASE = `http://localhost:${PORT}`;
let server;

async function startServer(env = {}) {
  const child = spawn(process.execPath, [path.join(TEMPLATE, 'api/server.mjs')], { env: { ...process.env, PORT: String(PORT), LATENCY_MS: '0', ...env }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(BASE);
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('API did not start');
}
const stopServer = (child) => new Promise((r) => (child.exitCode !== null ? r() : (child.once('exit', r), child.kill())));

async function api(url, init) {
  const res = await fetch(BASE + url, init);
  return { status: res.status, body: await res.json(), headers: res.headers };
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function responseSchema(pathKey, method = 'get', status = 200) {
  return SPEC.paths[pathKey][method].responses[status].content['application/json'].schema;
}
async function check(url, pathKey, method = 'get') {
  const res = await api(url);
  assert.equal(res.status, 200, `${url}: ${JSON.stringify(res.body)}`);
  const errors = validate(res.body, responseSchema(pathKey, method));
  assert.deepEqual(errors.slice(0, 5), [], url);
  return res.body;
}

before(async () => {
  server = await startServer();
});
after(async () => {
  await stopServer(server);
});

// ---------- Every documented GET matches its schema ----------

const EXAMPLES = {
  '/api/species/{name}': ['/api/species/eevee', '/api/species/slowking', '/api/species/arceus', '/api/species/pikachu'],
  '/api/species/{name}/catches': ['/api/species/pikachu/catches'],
  '/api/games/{id}': ['/api/games/red', '/api/games/scarlet', '/api/games/crystal'],
  '/api/games/{id}/dex': ['/api/games/red/dex', '/api/games/red/dex?status=missing'],
  '/api/friends/{id}': ['/api/friends/1', '/api/friends/150'],
  '/api/trades/{id}': ['/api/trades/1'],
  '/api/hunts/{id}': ['/api/hunts/1'],
};

test('every GET endpoint matches openapi.json', async () => {
  for (const [pathKey, ops] of Object.entries(SPEC.paths)) {
    if (!ops.get) continue;
    for (const url of EXAMPLES[pathKey] ?? [pathKey]) await check(url, pathKey);
  }
});

test('every enum query parameter accepts each value and rejects others', async () => {
  for (const [pathKey, ops] of Object.entries(SPEC.paths)) {
    if (!ops.get || pathKey.includes('{')) continue;
    for (const param of ops.get.parameters.filter((p) => p.in === 'query' && p.schema.enum)) {
      for (const value of param.schema.enum) await check(`${pathKey}?${param.name}=${value}`, pathKey);
      assert.equal((await api(`${pathKey}?${param.name}=nonsense`)).status, 400, `${pathKey} ${param.name}`);
    }
  }
});

test('unknown resources are 404s with an error body', async () => {
  for (const url of ['/api/species/missingno', '/api/games/pokemon-gray', '/api/friends/999', '/api/trades/999999', '/api/hunts/999999', '/api/nope']) {
    const res = await api(url);
    assert.equal(res.status, 404, url);
    assert.equal(typeof res.body.error, 'string');
  }
});

test('responses are no-store JSON with open CORS; media is cacheable', async () => {
  const res = await fetch(`${BASE}/api/me`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const species = (await api('/api/species/pikachu')).body.species;
  for (const url of [species.sprite, species.artwork]) {
    const img = await fetch(url.replace(/^https?:\/\/[^/]+/, BASE));
    assert.equal(img.status, 200, url);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('cache-control'), /max-age/);
  }
  const preflight = await fetch(`${BASE}/api/trades`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
});

// ---------- Behavior ----------

test('paging is consistent', async () => {
  const first = await check('/api/catches?pageSize=7', '/api/catches');
  assert.equal(first.items.length, 7);
  assert.equal(first.totalPages, Math.ceil(first.total / 7));
  const second = await check('/api/catches?pageSize=7&page=2', '/api/catches');
  assert.notDeepEqual(second.items[0], first.items[0]);
  const all = await check('/api/catches?pageSize=14', '/api/catches');
  assert.deepEqual(all.items.map((c) => c.id), [...first.items, ...second.items].map((c) => c.id));
  const past = await check(`/api/catches?page=${first.totalPages + 1}`, '/api/catches');
  assert.equal(past.items.length, 0);
  assert.equal((await api('/api/catches?pageSize=101')).status, 400);
  assert.equal((await api('/api/catches?page=0')).status, 400);
});

test('me agrees with the lists', async () => {
  const me = (await api('/api/me')).body;
  assert.equal(me.stats.speciesTotal, 1025);
  assert.equal(me.stats.catchCount, (await api('/api/catches?pageSize=1')).body.total);
  assert.equal(me.stats.shinyCount, (await api('/api/catches?shiny=true&pageSize=1')).body.total);
  assert.equal(me.stats.tradeCount, (await api('/api/trades?pageSize=1')).body.total);
  assert.equal(me.stats.activeHunts, (await api('/api/hunts?status=active&pageSize=1')).body.total);
  assert.equal(me.stats.gamesOwned, (await api('/api/games')).body.items.length);
  assert.equal(me.stats.speciesTotal - me.stats.speciesCaught, (await api('/api/needs?pageSize=1')).body.total);
  const hours = (await api('/api/games')).body.items.reduce((s, g) => s + g.hours, 0);
  assert.ok(Math.abs(hours - me.stats.hoursPlayed) <= me.stats.gamesOwned, `${hours} vs ${me.stats.hoursPlayed}`);
});

test('filters filter', async () => {
  const shiny = (await api('/api/catches?shiny=true&pageSize=100')).body.items;
  assert.ok(shiny.length > 0 && shiny.every((c) => c.shiny));
  const red = (await api('/api/catches?game=red&pageSize=100')).body.items;
  assert.ok(red.every((c) => c.game.id === 'red'));
  const pika = (await api('/api/catches?species=pikachu&pageSize=100')).body;
  assert.equal(pika.total, (await api('/api/species/pikachu')).body.mine.caught);
  assert.ok(pika.items.every((c) => c.species.name === 'pikachu'));
  assert.ok((await api('/api/trades?friend=3&pageSize=100')).body.items.every((t) => t.friend.id === 3));
  assert.ok((await api('/api/trades?evolved=true&pageSize=100')).body.items.every((t) => t.evolved));
  assert.ok((await api('/api/trades?year=2020&pageSize=100')).body.items.every((t) => t.tradedAt.startsWith('2020-')));
  assert.ok((await api('/api/hunts?status=failed&pageSize=100')).body.items.every((h) => h.status === 'failed'));
  const needs = (await api('/api/needs?pageSize=100')).body;
  assert.ok((await api('/api/needs?source=wild&pageSize=100')).body.items.every((n) => n.wildIn.length));
  assert.ok((await api('/api/needs?source=friends&pageSize=100')).body.items.every((n) => n.friendCount > 0));
  assert.ok((await api('/api/needs?source=trade-evolution&pageSize=100')).body.items.every((n) => n.tradeEvolution));
  const gen1 = (await api('/api/needs?generation=generation-i&pageSize=100')).body;
  assert.ok(gen1.items.every((n) => n.generation.name === 'generation-i' && n.species.id <= 151));
  assert.ok(gen1.total < needs.total);
  for (const n of needs.items) assert.equal((await api(`/api/species/${n.species.name}`)).body.mine.caught, 0);
});

test('sorting sorts', async () => {
  const isSorted = (xs, cmp) => xs.every((x, i) => i === 0 || cmp(xs[i - 1], x) <= 0);
  assert.ok(isSorted((await api('/api/catches?pageSize=100')).body.items, (a, b) => b.caughtAt.localeCompare(a.caughtAt)));
  assert.ok(isSorted((await api('/api/catches?sort=date&pageSize=100')).body.items, (a, b) => a.caughtAt.localeCompare(b.caughtAt)));
  assert.ok(isSorted((await api('/api/catches?sort=-level&pageSize=100')).body.items, (a, b) => b.level - a.level));
  assert.ok(isSorted((await api('/api/catches?sort=dex&pageSize=100')).body.items, (a, b) => a.species.id - b.species.id));
  assert.ok(isSorted((await api('/api/trades?pageSize=100')).body.items, (a, b) => b.tradedAt.localeCompare(a.tradedAt) || b.id - a.id));
  assert.ok(isSorted((await api('/api/needs?pageSize=100')).body.items, (a, b) => a.species.id - b.species.id));
  assert.ok(isSorted((await api('/api/needs?sort=friends&pageSize=100')).body.items, (a, b) => b.friendCount - a.friendCount || a.species.id - b.species.id));
  assert.ok(isSorted((await api('/api/friends?pageSize=100')).body.items, (a, b) => a.friend.name.localeCompare(b.friend.name)));
  assert.ok(isSorted((await api('/api/friends?sort=trades&pageSize=100')).body.items, (a, b) => b.tradeCount - a.tradeCount));
  assert.ok(isSorted((await api('/api/friends?sort=can-help&pageSize=100')).body.items, (a, b) => b.canHelp - a.canHelp));
  assert.ok(isSorted((await api('/api/hunts?sort=encounters&pageSize=100')).body.items, (a, b) => b.encounters - a.encounters));
  const activity = (await api('/api/activity?limit=50')).body.items;
  assert.ok(isSorted(activity, (a, b) => b.date.localeCompare(a.date)));
  const more = (await api('/api/activity?limit=10&offset=10')).body.items;
  assert.deepEqual(more.map((i) => `${i.type}${i.id}`), activity.slice(10, 20).map((i) => `${i.type}${i.id}`));
});

test('reference data is sane', async () => {
  const meta = (await api('/api/meta')).body;
  assert.equal(meta.types.length, 18);
  assert.equal(meta.generations.length, 9);
  assert.deepEqual(meta.games.slice(0, 3).map((g) => g.id), ['red', 'blue', 'yellow']);
  const eevee = (await api('/api/species/eevee')).body;
  assert.equal(eevee.evolution.species.name, 'eevee');
  assert.equal(eevee.evolution.evolvesTo.length, 8);
  const slowking = (await api('/api/species/slowking')).body;
  const trade = slowking.evolution.evolvesTo.find((e) => e.species.name === 'slowking');
  assert.equal(trade.trade, true);
  assert.match(trade.how, /^Trade holding King.s Rock$/);
  const machamp = (await api('/api/species/machamp')).body.evolution;
  assert.deepEqual([machamp.species.name, machamp.evolvesTo[0].species.name, machamp.evolvesTo[0].evolvesTo[0].species.name], ['machop', 'machoke', 'machamp']);
  const red = (await api('/api/games/red')).body;
  assert.equal(red.counterpart.id, 'blue');
  assert.equal(red.dexSize, 151);
  assert.ok(red.counterpartExclusives.some((e) => e.species.name === 'sandshrew'), 'Sandshrew is a Blue exclusive');
  assert.equal(red.hoursByMonth.length, 12);
  assert.equal((await api('/api/stats/catches-by-month')).body.items.at(-1).month, meta.today.slice(0, 7));
  const completion = (await api('/api/stats/completion-by-game')).body.items;
  for (const c of completion) assert.equal(c.percent, Math.round((c.caught / c.dexSize) * 1000) / 10);
});

// Writes last: they change totals the other tests check.
test('logging a trade creates the trade and a catch', async () => {
  const before = (await api('/api/me')).body.stats;
  const games = (await api('/api/games')).body.items;
  const res = await post('/api/trades', { friendId: 7, game: games[0].game.id, gave: 'pikachu', received: 'bulbasaur' });
  assert.equal(res.status, 201);
  assert.deepEqual(validate(res.body, responseSchema('/api/trades', 'post', 201)), []);
  assert.equal(res.body.tradedAt, (await api('/api/meta')).body.today);
  const after = (await api('/api/me')).body.stats;
  assert.equal(after.tradeCount, before.tradeCount + 1);
  assert.equal(after.catchCount, before.catchCount + 1);
  const newest = (await api('/api/trades?pageSize=1')).body.items[0];
  assert.equal(newest.id, res.body.id);
  assert.equal((await api('/api/activity?limit=1')).body.items[0].id, res.body.id);
  assert.equal((await api(`/api/trades/${res.body.id}`)).body.received.name, 'bulbasaur');

  for (const bad of [{}, { friendId: 7, game: 'pokemon-gray', gave: 'pikachu', received: 'eevee' }, { friendId: 9999, game: games[0].game.id, gave: 'pikachu', received: 'eevee' }, { friendId: 7, game: games[0].game.id, gave: 'missingno', received: 'eevee' }, { friendId: 7, game: games[0].game.id, gave: 'pikachu', received: 'eevee', tradedAt: '2099-01-01' }]) {
    assert.equal((await post('/api/trades', bad)).status, 400, JSON.stringify(bad));
  }
});

test('adding encounters to a hunt', async () => {
  const active = (await api('/api/hunts?status=active&pageSize=1')).body.items[0];
  const res = await post(`/api/hunts/${active.id}/encounters`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.encounters, active.encounters + 1);
  assert.equal((await post(`/api/hunts/${active.id}/encounters`, { count: 10 })).body.encounters, active.encounters + 11);
  assert.equal((await post(`/api/hunts/${active.id}/encounters`, { count: 0 })).status, 400);
  const done = (await api('/api/hunts?status=completed&pageSize=1')).body.items[0];
  assert.equal((await post(`/api/hunts/${done.id}/encounters`, {})).status, 409);
});

test('a restart throws writes away, and the overlay changes the data', async () => {
  await stopServer(server);
  server = await startServer();
  const plain = (await api('/api/me')).body.stats;
  await stopServer(server);
  server = await startServer({ API_OVERLAY: path.join(TEMPLATE, 'tests/fixtures/live-data.sql') });
  const overlaid = (await api('/api/me')).body.stats;
  assert.equal(overlaid.tradeCount, plain.tradeCount + 1);
  assert.equal(overlaid.speciesCaught, plain.speciesCaught + 1);
  assert.equal((await api('/api/friends?pageSize=1')).body.total, 151);
  assert.equal((await api('/api/trades?pageSize=1')).body.items[0].friend.name, 'Benchmon Fan');
});

test('latency defaults to about 30 ms', async () => {
  await stopServer(server);
  server = await startServer({ LATENCY_MS: '' });
  const t = performance.now();
  await api('/api/meta');
  const ms = performance.now() - t;
  assert.ok(ms >= 29 && ms < 200, `${ms} ms`);
});
