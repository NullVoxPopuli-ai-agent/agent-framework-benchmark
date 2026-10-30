#!/usr/bin/env node
// Builds data/dex.sqlite, the database behind api/server.mjs.
//
// Reference data (species, types, games, regional Pokédexes, wild encounters, evolutions)
// comes from a PokeAPI data dump. The trainer's own data (games owned, play sessions,
// catches, friends, trades, shiny hunts) is generated from a fixed seed, so every build
// produces the same database.
//
// Usage: node scripts/build-db.mjs <PokeAPI api/v2 dir> <media dir> <out.sqlite>

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [apiDir, mediaDir, outFile] = process.argv.slice(2);
if (!apiDir || !mediaDir || !outFile) {
  console.error('Usage: build-db.mjs <api/v2 dir> <media dir> <out.sqlite>');
  process.exit(1);
}

// The data's "today". Dates in the generated data end here; it never moves.
const TODAY = '2026-10-15';
const SPECIES_COUNT = 1025;

// ---------- Seeded randomness ----------

let seed = 20261015;
function random() {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (xs) => xs[Math.floor(random() * xs.length)];
const chance = (p) => random() < p;
function pickWeighted(xs, weight) {
  const total = xs.reduce((s, x) => s + weight(x), 0);
  let r = random() * total;
  for (const x of xs) if ((r -= weight(x)) < 0) return x;
  return xs[xs.length - 1];
}
function shuffle(xs) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Log-uniform integer, for counts with a long tail (shiny hunt encounters).
const logInt = (min, max) => Math.round(Math.exp(Math.log(min) + random() * (Math.log(max) - Math.log(min))));

const DAY = 86_400_000;
const toDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const fromDate = (d) => Date.parse(`${d}T00:00:00Z`);
const randomDate = (from, to) => toDate(fromDate(from) + Math.floor(random() * ((fromDate(to) - fromDate(from)) / DAY + 1)) * DAY);
const addDays = (d, n) => toDate(fromDate(d) + n * DAY);
const minDate = (a, b) => (a < b ? a : b);

// ---------- PokeAPI reference data ----------

const read = (...parts) => JSON.parse(fs.readFileSync(path.join(apiDir, ...parts.map(String), "index.json"), "utf8"));
const english = (names) => names.find((n) => n.language.name === 'en');
const idFromUrl = (url) => Number(url.match(/\/(\d+)\/$/)[1]);
const media = (rel) => (fs.existsSync(path.join(mediaDir, rel)) ? `/media/${rel}` : null);

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
const generations = ROMAN.map((r, i) => ({ id: i + 1, name: `generation-${r.toLowerCase()}`, displayName: `Generation ${r}` }));
const genId = (name) => generations.find((g) => g.name === name).id;

const types = read('type')
  .results.map((t) => read('type', idFromUrl(t.url)))
  .filter((t) => !['stellar', 'unknown', 'shadow'].includes(t.name))
  .map((t) => ({ id: t.id, name: t.name, displayName: english(t.names).name }));

console.log('Reading species...');
const species = [];
for (let id = 1; id <= SPECIES_COUNT; id++) {
  const s = read('pokemon-species', id);
  const p = read('pokemon', id);
  const slots = [...p.types].sort((a, b) => a.slot - b.slot).map((t) => t.type.name);
  species.push({
    id,
    name: s.name,
    displayName: english(s.names).name,
    genus: english(s.genera)?.genus ?? null,
    generation: genId(s.generation.name),
    type1: slots[0],
    type2: slots[1] ?? null,
    legendary: s.is_legendary ? 1 : 0,
    mythical: s.is_mythical ? 1 : 0,
    chain: idFromUrl(s.evolution_chain.url),
    sprite: media(`sprites/pokemon/${id}.png`),
    artwork: media(`sprites/pokemon/other/official-artwork/${id}.png`),
  });
}
const speciesByName = new Map(species.map((s) => [s.name, s]));

// Item names, for evolution methods.
const itemIds = new Map(read('item').results.map((i) => [i.name, idFromUrl(i.url)]));
const itemName = (name) => {
  try {
    return english(read('item', itemIds.get(name)).names)?.name ?? name;
  } catch {
    return name;
  }
};
const humanize = (name) => name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

// How an evolution happens, in words. Trade evolutions win over other methods listed for
// the same link, since that's what a completionist needs to know.
function evolutionMethod(details) {
  const d = details.find((x) => x.trigger.name === 'trade') ?? details[0];
  if (!d) return { trigger: 'other', how: 'Other' };
  const t = d.trigger.name;
  if (t === 'trade') {
    if (d.held_item) return { trigger: t, how: `Trade holding ${itemName(d.held_item.name)}` };
    if (d.trade_species) return { trigger: t, how: `Trade for ${speciesByName.get(d.trade_species.name)?.displayName ?? humanize(d.trade_species.name)}` };
    return { trigger: t, how: 'Trade' };
  }
  if (t === 'level-up') {
    if (d.min_level) return { trigger: t, how: `Level ${d.min_level}` };
    if (d.min_happiness) return { trigger: t, how: 'Level up with high friendship' };
    if (d.known_move) return { trigger: t, how: `Level up knowing ${humanize(d.known_move.name)}` };
    if (d.held_item) return { trigger: t, how: `Level up holding ${itemName(d.held_item.name)}` };
    return { trigger: t, how: 'Level up' };
  }
  if (t === 'use-item' && d.item) return { trigger: t, how: `Use ${itemName(d.item.name)}` };
  return { trigger: t, how: humanize(t) };
}

console.log('Reading evolution chains...');
const evolutions = [];
for (const chainId of new Set(species.map((s) => s.chain))) {
  const walk = (node) => {
    for (const next of node.evolves_to) {
      const from = speciesByName.get(node.species.name);
      const to = speciesByName.get(next.species.name);
      if (from && to) evolutions.push({ from: from.id, to: to.id, ...evolutionMethod(next.evolution_details) });
      walk(next);
    }
  };
  walk(read('evolution-chain', chainId).chain);
}

// Main-series games with a regional Pokédex. Japanese releases, spin-offs and DLC are left out.
const GAME_GROUPS = [
  'red-blue', 'yellow', 'gold-silver', 'crystal', 'ruby-sapphire', 'emerald', 'firered-leafgreen',
  'diamond-pearl', 'platinum', 'heartgold-soulsilver', 'black-white', 'black-2-white-2', 'x-y',
  'omega-ruby-alpha-sapphire', 'sun-moon', 'ultra-sun-ultra-moon', 'lets-go-pikachu-lets-go-eevee',
  'sword-shield', 'brilliant-diamond-shining-pearl', 'legends-arceus', 'scarlet-violet', 'legends-za',
];
const PLATFORM = {
  'generation-i': 'Game Boy', 'generation-ii': 'Game Boy Color', 'generation-iii': 'Game Boy Advance',
  'generation-iv': 'Nintendo DS', 'generation-v': 'Nintendo DS', 'generation-vi': 'Nintendo 3DS',
  'generation-vii': 'Nintendo 3DS', 'generation-viii': 'Nintendo Switch', 'generation-ix': 'Nintendo Switch',
};
const groupIds = new Map(read('version-group').results.map((g) => [g.name, idFromUrl(g.url)]));
const versionIds = new Map(read('version').results.map((v) => [v.name, idFromUrl(v.url)]));

console.log('Reading games and Pokédexes...');
const games = [];
const dexEntries = []; // { game, species, number }
for (const groupName of GAME_GROUPS) {
  const group = read('version-group', groupIds.get(groupName));
  // A game's regional Pokédex is every Pokédex of its version group, merged in order.
  const dex = new Map();
  for (const p of group.pokedexes) {
    for (const e of read('pokedex', idFromUrl(p.url)).pokemon_entries) {
      const s = speciesByName.get(e.pokemon_species.name);
      if (s && !dex.has(s.id)) dex.set(s.id, dex.size + 1);
    }
  }
  const versions = group.versions.map((v) => read('version', versionIds.get(v.name)));
  for (const v of versions) {
    const counterpart = versions.find((o) => o.name !== v.name)?.name ?? null;
    const platform = groupName === 'lets-go-pikachu-lets-go-eevee' ? 'Nintendo Switch' : PLATFORM[group.generation.name];
    // Release order: by version group, then PokeAPI's version order (Red before Blue).
    games.push({ id: v.name, displayName: english(v.names).name, generation: genId(group.generation.name), order: group.order * 1000 + v.id, counterpart, platform, dexSize: dex.size });
    for (const [sid, number] of dex) dexEntries.push({ game: v.name, species: sid, number });
  }
}
const gameById = new Map(games.map((g) => [g.id, g]));
const dexOf = new Map(games.map((g) => [g.id, []]));
for (const e of dexEntries) dexOf.get(e.game).push(e.species);

console.log('Reading wild encounters...');
const wild = new Set(); // "game|species"
for (let id = 1; id <= SPECIES_COUNT; id++) {
  for (const area of read('pokemon', id, 'encounters')) {
    for (const vd of area.version_details) if (gameById.has(vd.version.name)) wild.add(`${vd.version.name}|${id}`);
  }
}

// ---------- The trainer's data (generated) ----------

console.log('Generating trainer data...');
const START = '2016-02-27';

// Games the trainer owns: most of them, with save files started over the last ten years.
const myGames = [];
for (const g of games) {
  if (!chance(g.generation >= 7 ? 0.9 : 0.7)) continue;
  const startedAt = randomDate(START, '2026-06-30');
  myGames.push({
    game: g.id,
    copies: chance(0.25) ? int(2, 3) : 1,
    playthroughs: int(1, chance(0.3) ? 6 : 2),
    startedAt,
    lastPlayed: randomDate(addDays(startedAt, 30) < TODAY ? addDays(startedAt, 30) : startedAt, TODAY),
    targetHours: int(25, g.generation >= 7 ? 420 : 160),
  });
}
const myGameIds = new Set(myGames.map((m) => m.game));

// Play sessions per game, adding up to roughly the game's target hours.
const sessions = [];
for (const m of myGames) {
  let minutes = 0;
  while (minutes < m.targetHours * 60) {
    const length = int(15, 240);
    sessions.push({ game: m.game, date: randomDate(m.startedAt, m.lastPlayed), minutes: length });
    minutes += length;
  }
}
sessions.sort((a, b) => a.date.localeCompare(b.date) || a.game.localeCompare(b.game));
const hoursOf = new Map();
for (const s of sessions) hoursOf.set(s.game, (hoursOf.get(s.game) ?? 0) + s.minutes / 60);

// Species the trainer has caught. Legendaries, mythicals and the newest generation are
// the most likely to be missing.
const caughtSet = new Set(
  species
    .filter((s) => chance(s.mythical ? 0.3 : s.legendary ? 0.6 : s.generation === 9 ? 0.78 : 0.93))
    .map((s) => s.id),
);

const BALLS = ['Poké Ball', 'Great Ball', 'Ultra Ball', 'Quick Ball', 'Dusk Ball', 'Repeat Ball', 'Luxury Ball', 'Heal Ball', 'Net Ball', 'Timer Ball', 'Love Ball', 'Friend Ball', 'Beast Ball', 'Master Ball'];
const NICKNAMES = ['Sparky', 'Bubbles', 'Ziggy', 'Pebble', 'Nimbus', 'Fang', 'Biscuit', 'Comet', 'Mochi', 'Pip', 'Rascal', 'Juniper', 'Echo', 'Tofu', 'Basil'];
const ball = () => pickWeighted(BALLS, (b) => (b === 'Poké Ball' ? 8 : b === 'Master Ball' ? 0.2 : b === 'Ultra Ball' ? 4 : 1));

const catches = [];
function addCatch({ speciesId, game, date, method, shiny = 0, tradeId = null, huntId = null }) {
  const c = {
    id: 0,
    species: speciesId,
    game,
    caughtAt: date,
    level: method === 'Egg' ? 1 : int(2, 70),
    shiny,
    method,
    ball: method === 'Trade' ? null : method === 'Egg' ? 'Poké Ball' : ball(),
    nickname: chance(0.06) ? pick(NICKNAMES) : null,
    tradeId,
    huntId,
  };
  catches.push(c);
  return c;
}
const gameDates = (game) => myGames.find((m) => m.game === game);

// At least one catch of every caught species, in a game whose Pokédex has it.
for (const sid of caughtSet) {
  const options = myGames.filter((m) => dexOf.get(m.game).includes(sid));
  const m = options.length ? pick(options) : pickWeighted(myGames, (x) => gameById.get(x.game).generation);
  addCatch({ speciesId: sid, game: m.game, date: randomDate(m.startedAt, m.lastPlayed), method: options.length ? pick(['Wild', 'Wild', 'Wild', 'Egg', 'Gift']) : 'Gift' });
}
// Then many more, in proportion to time played.
for (const m of myGames) {
  const pool = dexOf.get(m.game).filter((sid) => caughtSet.has(sid));
  if (!pool.length) continue;
  const n = Math.round((hoursOf.get(m.game) ?? 0) * 14);
  for (let i = 0; i < n; i++) {
    addCatch({ speciesId: pick(pool), game: m.game, date: randomDate(m.startedAt, m.lastPlayed), method: pickWeighted(['Wild', 'Egg', 'Gift', 'Raid'], (x) => ({ Wild: 12, Egg: 6, Gift: 0.5, Raid: m.game.match(/sword|shield|scarlet|violet/) ? 2 : 0 })[x]), shiny: chance(0.0025) ? 1 : 0 });
  }
}

// Friends.
const FIRST = ['Mika', 'Jordan', 'Priya', 'Tomás', 'Hana', 'Leo', 'Amara', 'Kenji', 'Sofia', 'Malik', 'Ines', 'Theo', 'Yara', 'Dev', 'Elif', 'Noah', 'Zoe', 'Ravi', 'Lucia', 'Omar', 'Freya', 'Kai', 'Nia', 'Sam', 'Aiko', 'Mateo', 'Ada', 'Felix', 'Lina', 'Jonah', 'Rosa', 'Ibrahim', 'Maya', 'Hugo', 'Saoirse', 'Tariq', 'Wren', 'Emil', 'Chloe', 'Arjun', 'Bea', 'Diego', 'Ingrid', 'Kofi', 'Luz', 'Nils', 'Oona', 'Pablo', 'Quinn', 'Rin'];
const LAST = ['Tanaka', 'Okafor', 'Silva', 'Novak', 'Lindqvist', 'Haddad', 'Moreau', 'Kowalski', 'Nguyen', 'Petrov', 'Garcia', 'Sato', 'Mensah', 'Rossi', 'Kaplan', 'Byrne', 'Iyer', 'Fischer', 'Costa', 'Abara', 'Larsen', 'Yilmaz', 'Duarte', 'Ito', 'Walsh', 'Bauer', 'Ortiz', 'Kim', 'Adeyemi', 'Varga'];
const names = shuffle(FIRST.flatMap((f) => LAST.map((l) => `${f} ${l}`)));
const friendCode = () => `SW-${[0, 0, 0].map(() => String(int(0, 9999)).padStart(4, '0')).join('-')}`;
const friends = [];
for (let i = 0; i < 150; i++) {
  const owned = shuffle(games).slice(0, int(3, 18)).map((g) => g.id);
  friends.push({ id: i + 1, name: names[i], friendCode: friendCode(), since: randomDate(START, '2026-08-31'), games: owned, activity: logInt(1, 200) });
}
// Species each friend has, from the Pokédexes of the games they own.
const friendSpecies = [];
for (const f of friends) {
  const pool = [...new Set(f.games.flatMap((g) => dexOf.get(g)))];
  const share = 0.3 + random() * 0.6;
  for (const sid of pool) if (chance(share)) friendSpecies.push({ friend: f.id, species: sid });
  // Some friends have legendaries from events and other games.
  for (const s of species) if ((s.legendary || s.mythical) && chance(0.08)) friendSpecies.push({ friend: f.id, species: s.id });
}
const dedupe = new Map(friendSpecies.map((x) => [`${x.friend}|${x.species}`, x]));
friendSpecies.length = 0;
friendSpecies.push(...dedupe.values());

// Trades: in a game both own, after both started playing. What the trainer received
// becomes one of their catches; a trade evolution evolves on arrival.
const tradeEvolutionOf = new Map(evolutions.filter((e) => e.trigger === 'trade').map((e) => [e.from, e.to]));
const trades = [];
for (let i = 0; i < 14000; i++) {
  const f = pickWeighted(friends, (x) => x.activity);
  const shared = f.games.filter((g) => myGameIds.has(g) && dexOf.get(g).length);
  if (!shared.length) continue;
  const game = pick(shared);
  const m = gameDates(game);
  const from = f.since > m.startedAt ? f.since : m.startedAt;
  if (from > m.lastPlayed) continue;
  const pool = dexOf.get(game).filter((sid) => caughtSet.has(sid));
  if (!pool.length) continue;
  const gave = pick(pool);
  let received = pick(pool);
  let evolved = 0;
  const evolvesTo = tradeEvolutionOf.get(received);
  if (evolvesTo && caughtSet.has(evolvesTo) && chance(0.8)) {
    received = evolvesTo;
    evolved = 1;
  }
  trades.push({ id: 0, tradedAt: randomDate(from, m.lastPlayed), friend: f.id, game, gave, received, evolved });
}
trades.sort((a, b) => a.tradedAt.localeCompare(b.tradedAt));
trades.forEach((t, i) => {
  t.id = i + 1;
  addCatch({ speciesId: t.received, game: t.game, date: t.tradedAt, method: 'Trade', tradeId: t.id });
});

// Shiny hunts. A completed hunt ends with a shiny catch.
// Hunting methods available in each generation.
const HUNT_METHODS = {
  1: ['Random encounters', 'Soft resets'], 2: ['Random encounters', 'Soft resets'], 3: ['Random encounters', 'Soft resets'],
  4: ['Random encounters', 'Soft resets', 'Masuda method', 'Poké Radar'], 5: ['Random encounters', 'Soft resets', 'Masuda method'],
  6: ['Random encounters', 'Soft resets', 'Masuda method', 'Chain fishing', 'Poké Radar'], 7: ['Random encounters', 'Soft resets', 'Masuda method', 'SOS chaining'],
  8: ['Random encounters', 'Soft resets', 'Masuda method', 'Dynamax Adventures', 'Outbreaks'], 9: ['Random encounters', 'Soft resets', 'Masuda method', 'Outbreaks'],
};
const hunts = [];
for (let i = 0; i < 420; i++) {
  const m = pickWeighted(myGames, (x) => hoursOf.get(x.game) ?? 1);
  const pool = dexOf.get(m.game).filter((sid) => caughtSet.has(sid));
  if (!pool.length) continue;
  const active = i >= 412;
  const startedAt = active ? randomDate(addDays(TODAY, -60), TODAY) : randomDate(m.startedAt, minDate(addDays(m.lastPlayed, -1), TODAY));
  const encounters = active ? logInt(10, 3000) : logInt(30, 25000);
  const status = active ? 'active' : chance(0.87) ? 'completed' : 'failed';
  const endedAt = active ? null : minDate(addDays(startedAt, Math.max(1, Math.round(encounters / int(150, 900)))), TODAY);
  hunts.push({ id: 0, species: pick(pool), game: m.game, method: pick(HUNT_METHODS[gameById.get(m.game).generation]), startedAt, endedAt, status, encounters });
}
hunts.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
hunts.forEach((h, i) => {
  h.id = i + 1;
  if (h.status === 'completed') addCatch({ speciesId: h.species, game: h.game, date: h.endedAt, method: h.method === 'Masuda method' ? 'Egg' : 'Wild', shiny: 1, huntId: h.id });
});

catches.sort((a, b) => a.caughtAt.localeCompare(b.caughtAt) || a.species - b.species);
catches.forEach((c, i) => (c.id = i + 1));

// ---------- Write the database ----------

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.rmSync(outFile, { force: true });
const db = new DatabaseSync(outFile);
db.exec(`
PRAGMA journal_mode = OFF;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE generation (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL);
CREATE TABLE type (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL);
CREATE TABLE species (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, genus TEXT,
  generation_id INTEGER NOT NULL REFERENCES generation, type1 TEXT NOT NULL, type2 TEXT,
  legendary INTEGER NOT NULL, mythical INTEGER NOT NULL, chain_id INTEGER NOT NULL,
  sprite TEXT, artwork TEXT
);
CREATE TABLE evolution (from_id INTEGER NOT NULL REFERENCES species, to_id INTEGER NOT NULL REFERENCES species, trigger TEXT NOT NULL, how TEXT NOT NULL);
CREATE TABLE game (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, generation_id INTEGER NOT NULL, release_order INTEGER NOT NULL,
  counterpart TEXT, platform TEXT NOT NULL, dex_size INTEGER NOT NULL
);
CREATE TABLE dex_entry (game_id TEXT NOT NULL REFERENCES game, species_id INTEGER NOT NULL REFERENCES species, number INTEGER NOT NULL, PRIMARY KEY (game_id, species_id));
CREATE TABLE wild (game_id TEXT NOT NULL REFERENCES game, species_id INTEGER NOT NULL REFERENCES species, PRIMARY KEY (game_id, species_id));
CREATE TABLE my_game (game_id TEXT PRIMARY KEY REFERENCES game, copies INTEGER NOT NULL, playthroughs INTEGER NOT NULL, started_at TEXT NOT NULL, last_played TEXT NOT NULL);
CREATE TABLE session (id INTEGER PRIMARY KEY, game_id TEXT NOT NULL REFERENCES game, date TEXT NOT NULL, minutes INTEGER NOT NULL);
CREATE TABLE friend (id INTEGER PRIMARY KEY, name TEXT NOT NULL, friend_code TEXT NOT NULL, since TEXT NOT NULL);
CREATE TABLE friend_game (friend_id INTEGER NOT NULL REFERENCES friend, game_id TEXT NOT NULL REFERENCES game, PRIMARY KEY (friend_id, game_id));
CREATE TABLE friend_species (friend_id INTEGER NOT NULL REFERENCES friend, species_id INTEGER NOT NULL REFERENCES species, PRIMARY KEY (friend_id, species_id));
CREATE TABLE trade (
  id INTEGER PRIMARY KEY, traded_at TEXT NOT NULL, friend_id INTEGER NOT NULL REFERENCES friend, game_id TEXT NOT NULL REFERENCES game,
  gave_id INTEGER NOT NULL REFERENCES species, received_id INTEGER NOT NULL REFERENCES species, evolved INTEGER NOT NULL
);
CREATE TABLE hunt (
  id INTEGER PRIMARY KEY, species_id INTEGER NOT NULL REFERENCES species, game_id TEXT NOT NULL REFERENCES game, method TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL, encounters INTEGER NOT NULL
);
CREATE TABLE catch (
  id INTEGER PRIMARY KEY, species_id INTEGER NOT NULL REFERENCES species, game_id TEXT NOT NULL REFERENCES game,
  caught_at TEXT NOT NULL, level INTEGER NOT NULL, shiny INTEGER NOT NULL, method TEXT NOT NULL, ball TEXT, nickname TEXT,
  trade_id INTEGER REFERENCES trade, hunt_id INTEGER REFERENCES hunt
);
`);

function insertAll(table, columns, rows) {
  const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  db.exec('BEGIN');
  for (const row of rows) stmt.run(...row);
  db.exec('COMMIT');
}
insertAll('meta', ['key', 'value'], [['today', TODAY], ['trainer', 'Robin'], ['friend_code', 'SW-2702-1996-0227'], ['since', START]]);
insertAll('generation', ['id', 'name', 'display_name'], generations.map((g) => [g.id, g.name, g.displayName]));
insertAll('type', ['id', 'name', 'display_name'], types.map((t) => [t.id, t.name, t.displayName]));
insertAll('species', ['id', 'name', 'display_name', 'genus', 'generation_id', 'type1', 'type2', 'legendary', 'mythical', 'chain_id', 'sprite', 'artwork'],
  species.map((s) => [s.id, s.name, s.displayName, s.genus, s.generation, s.type1, s.type2, s.legendary, s.mythical, s.chain, s.sprite, s.artwork]));
insertAll('evolution', ['from_id', 'to_id', 'trigger', 'how'], evolutions.map((e) => [e.from, e.to, e.trigger, e.how]));
insertAll('game', ['id', 'display_name', 'generation_id', 'release_order', 'counterpart', 'platform', 'dex_size'],
  games.map((g) => [g.id, g.displayName, g.generation, g.order, g.counterpart, g.platform, g.dexSize]));
insertAll('dex_entry', ['game_id', 'species_id', 'number'], dexEntries.map((e) => [e.game, e.species, e.number]));
insertAll('wild', ['game_id', 'species_id'], [...wild].map((k) => k.split('|')).map(([g, s]) => [g, Number(s)]));
insertAll('my_game', ['game_id', 'copies', 'playthroughs', 'started_at', 'last_played'], myGames.map((m) => [m.game, m.copies, m.playthroughs, m.startedAt, m.lastPlayed]));
insertAll('session', ['game_id', 'date', 'minutes'], sessions.map((s) => [s.game, s.date, s.minutes]));
insertAll('friend', ['id', 'name', 'friend_code', 'since'], friends.map((f) => [f.id, f.name, f.friendCode, f.since]));
insertAll('friend_game', ['friend_id', 'game_id'], friends.flatMap((f) => f.games.map((g) => [f.id, g])));
insertAll('friend_species', ['friend_id', 'species_id'], friendSpecies.map((x) => [x.friend, x.species]));
insertAll('trade', ['id', 'traded_at', 'friend_id', 'game_id', 'gave_id', 'received_id', 'evolved'], trades.map((t) => [t.id, t.tradedAt, t.friend, t.game, t.gave, t.received, t.evolved]));
insertAll('hunt', ['id', 'species_id', 'game_id', 'method', 'started_at', 'ended_at', 'status', 'encounters'], hunts.map((h) => [h.id, h.species, h.game, h.method, h.startedAt, h.endedAt, h.status, h.encounters]));
insertAll('catch', ['id', 'species_id', 'game_id', 'caught_at', 'level', 'shiny', 'method', 'ball', 'nickname', 'trade_id', 'hunt_id'],
  catches.map((c) => [c.id, c.species, c.game, c.caughtAt, c.level, c.shiny, c.method, c.ball, c.nickname, c.tradeId, c.huntId]));

db.exec(`
CREATE INDEX catch_species ON catch (species_id);
CREATE INDEX catch_game ON catch (game_id, species_id);
CREATE INDEX catch_date ON catch (caught_at, id);
CREATE INDEX catch_shiny ON catch (shiny, caught_at);
CREATE INDEX trade_friend ON trade (friend_id, traded_at);
CREATE INDEX trade_date ON trade (traded_at, id);
CREATE INDEX trade_game ON trade (game_id);
CREATE INDEX hunt_status ON hunt (status, started_at);
CREATE INDEX hunt_ended ON hunt (ended_at);
CREATE INDEX session_game ON session (game_id, date);
CREATE INDEX friend_species_species ON friend_species (species_id);
CREATE INDEX evolution_to ON evolution (to_id);
CREATE INDEX evolution_from ON evolution (from_id);
CREATE INDEX species_chain ON species (chain_id);
CREATE INDEX wild_species ON wild (species_id);
CREATE INDEX dex_species ON dex_entry (species_id);
ANALYZE;
`);
db.close();

const count = (xs) => xs.length.toLocaleString('en-US');
console.log(`Wrote ${outFile}: ${species.length} species, ${games.length} games (${myGames.length} owned), ${count(sessions)} sessions,`);
console.log(`  ${count(catches)} catches of ${caughtSet.size} species, ${friends.length} friends, ${count(trades)} trades, ${hunts.length} hunts`);
