#!/usr/bin/env node
// Writes template/api/openapi.json, the API description agents get. This script is the
// source of truth; edit it and run `node api-tests/build-openapi.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../template/api/openapi.json');

// ---------- Schema helpers ----------

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const str = (description, extra = {}) => ({ type: 'string', ...(description && { description }), ...extra });
const int = (description, extra = {}) => ({ type: 'integer', ...(description && { description }), ...extra });
const bool = (description) => ({ type: 'boolean', ...(description && { description }) });
const date = (description) => str(description, { format: 'date', example: '2026-10-15' });
const arr = (items, description) => ({ type: 'array', items, ...(description && { description }) });
const obj = (properties, description) => ({ type: 'object', required: Object.keys(properties), properties, ...(description && { description }) });
const page = (item) => obj({
  items: arr(item),
  page: int('The page returned, 1-based'),
  pageSize: int(),
  total: int('Number of matching items across all pages'),
  totalPages: int('At least 1, even when total is 0'),
});

const schemas = {
  Error: obj({ error: str() }),
  TypeRef: obj({ name: str('API name, such as `fire`'), displayName: str('English name, such as `Fire`') }),
  GenerationRef: obj({ name: str('such as `generation-i`'), displayName: str('such as `Generation I`') }),
  GameRef: obj({ id: str('API name of the game, such as `scarlet`'), displayName: str('English name, such as `Scarlet`') }),
  FriendRef: obj({ id: int(), name: str() }),
  SpeciesRef: obj({
    id: int('National Pokédex number'),
    name: str('API name, such as `mr-mime`'),
    displayName: str('English name, such as `Mr. Mime`'),
    sprite: nullable(str('Absolute URL of the 96×96 front sprite', { format: 'uri' })),
    types: arr(ref('TypeRef'), 'In slot order'),
  }),
  Catch: obj({
    id: int(),
    species: ref('SpeciesRef'),
    game: ref('GameRef'),
    caughtAt: date(),
    level: int(),
    shiny: bool(),
    method: str('How it was obtained: `Wild`, `Egg`, `Gift`, `Raid` or `Trade`'),
    ball: nullable(str('The ball it was caught in; null for trades')),
    nickname: nullable(str()),
    tradeId: nullable(int('The trade it came from, for method `Trade`')),
    huntId: nullable(int('The shiny hunt it came from')),
  }),
  Trade: obj({
    id: int(),
    tradedAt: date(),
    friend: ref('FriendRef'),
    game: ref('GameRef'),
    gave: ref('SpeciesRef'),
    received: ref('SpeciesRef'),
    evolved: bool('Whether what you received evolved on arrival (a trade evolution); `received` is the evolved species'),
  }),
  Hunt: obj({
    id: int(),
    species: ref('SpeciesRef'),
    game: ref('GameRef'),
    method: str('such as `Masuda method`'),
    startedAt: date(),
    endedAt: nullable(date('null while active')),
    status: str(null, { enum: ['active', 'completed', 'failed'] }),
    encounters: int('Encounters (or eggs, or resets) so far'),
  }),
  EvolutionNode: obj({
    species: ref('SpeciesRef'),
    how: nullable(str('How the previous stage evolves into this one, such as `Level 16` or `Trade holding Metal Coat`; null for the first stage')),
    trade: bool('Whether this evolution needs a trade'),
    evolvesTo: arr(ref('EvolutionNode'), 'Next stages; several for branching families such as Eevee'),
  }),
  ActivityItem: {
    description: 'A trade, a completed shiny hunt (`type: hunt`), or a catch that didn\'t come from a trade or hunt. Has the fields of the Trade, Hunt or Catch it describes, plus `type` and `date`.',
    anyOf: [
      { allOf: [ref('Trade'), obj({ type: str(null, { enum: ['trade'] }), date: date() })] },
      { allOf: [ref('Hunt'), obj({ type: str(null, { enum: ['hunt'] }), date: date('When the hunt ended') })] },
      { allOf: [ref('Catch'), obj({ type: str(null, { enum: ['catch'] }), date: date() })] },
    ],
  },
};

// ---------- Parameter helpers ----------

const q = (name, schema, description) => ({ name, in: 'query', required: false, schema, ...(description && { description }) });
const p = (name, schema, description) => ({ name, in: 'path', required: true, schema, ...(description && { description }) });
const paging = (size) => [q('page', int(null, { minimum: 1, default: 1 })), q('pageSize', int(null, { minimum: 1, maximum: 200, default: size }))];
const gameQ = q('game', str(), 'Game id, such as `scarlet`');

const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const errors = (...codes) => Object.fromEntries(codes.map((c) => [c, json(ref('Error'), { 400: 'Invalid parameter', 404: 'Not found', 409: 'Conflict' }[c])]));
const get = (summary, { params = [], schema, description, codes = [400] }) => ({
  get: { summary, ...(description && { description }), parameters: params, responses: { 200: json(schema), ...errors(...codes) } },
});

// ---------- Paths ----------

const paths = {
  '/api/me': get('The trainer and their totals', {
    codes: [],
    schema: obj({
      name: str(),
      friendCode: str(),
      since: date('When they started tracking'),
      today: date('The data\'s current date. Dates never go past it.'),
      stats: obj({
        speciesCaught: int('Species with at least one catch'),
        speciesTotal: int('Species that exist'),
        catchCount: int(),
        shinyCount: int(),
        tradeCount: int(),
        hoursPlayed: int('Across every game, rounded'),
        gamesOwned: int(),
        activeHunts: int(),
      }),
    }),
  }),
  '/api/meta': get('Lists for filters and forms', {
    codes: [],
    schema: obj({
      today: date(),
      generations: arr(ref('GenerationRef')),
      types: arr(ref('TypeRef'), 'The 18 types'),
      games: arr({ allOf: [ref('GameRef'), obj({ generation: ref('GenerationRef'), platform: str() })] }, 'Every game, owned or not, in release order'),
      catchMethods: arr(str()),
      huntMethods: arr(str()),
    }),
  }),
  '/api/stats/completion-by-game': get('Regional Pokédex completion for each owned game', {
    codes: [],
    description: 'A species counts as caught in a game when it was caught in that game.',
    schema: obj({ items: arr(obj({ game: ref('GameRef'), caught: int(), dexSize: int(), percent: { type: 'number', description: 'caught / dexSize × 100, one decimal' } }), 'Owned games, in release order') }),
  }),
  '/api/stats/catches-by-month': get('Catches per month for the last 24 months', {
    codes: [],
    schema: obj({ items: arr(obj({ month: str('`YYYY-MM`'), count: int() }), 'Oldest first, ending with the current month; months without catches have count 0') }),
  }),
  '/api/activity': get('Recent activity, newest first', {
    params: [q('limit', int(null, { minimum: 1, maximum: 50, default: 10 })), q('offset', int(null, { minimum: 0, default: 0 }))],
    schema: obj({ items: arr(ref('ActivityItem')), hasMore: bool() }),
  }),
  '/api/needs': get('Species the trainer has never caught, and how to get them', {
    params: [
      q('generation', str(), 'Generation API name, such as `generation-i`'),
      q('source', str(null, { enum: ['all', 'wild', 'friends', 'trade-evolution'], default: 'all' }), '`wild`: catchable in an owned game. `friends`: a friend has one. `trade-evolution`: evolves by trade.'),
      q('sort', str(null, { enum: ['dex', 'friends'], default: 'dex' }), '`dex`: by National Pokédex number. `friends`: most friends first, then by number.'),
      ...paging(50),
    ],
    schema: page(obj({
      species: ref('SpeciesRef'),
      generation: ref('GenerationRef'),
      wildIn: arr(ref('GameRef'), 'Owned games where it can be caught in the wild, in release order'),
      friendCount: int('Friends who have one'),
      tradeEvolution: nullable(obj({ from: ref('SpeciesRef'), how: str('such as `Trade holding Metal Coat`') }, 'Set when it evolves from another species by trade')),
    })),
  }),
  '/api/species': get('Search species by name', {
    params: [q('q', str(), 'Case-insensitive substring of the English or API name'), ...paging(20)],
    schema: page({ allOf: [ref('SpeciesRef'), obj({ caught: bool() })] }),
  }),
  '/api/species/{name}': get('One species, with the trainer\'s progress on it', {
    params: [p('name', str(), 'Species API name, such as `pikachu`')],
    codes: [404],
    schema: obj({
      species: { allOf: [ref('SpeciesRef'), obj({ genus: nullable(str('such as `Mouse Pokémon`')), generation: ref('GenerationRef'), artwork: nullable(str('Absolute URL of the official artwork, 475×475', { format: 'uri' })), legendary: bool(), mythical: bool() })] },
      mine: obj({ caught: int('Number of catches'), shiny: int('Number of shiny catches'), firstCaught: nullable(date()), lastCaught: nullable(date()) }),
      evolution: ref('EvolutionNode'),
      availability: arr(obj({ game: ref('GameRef'), wild: bool('Catchable in the wild (per the encounter data, which is missing for some newer games)'), owned: bool() }), 'Games whose regional Pokédex includes it, in release order'),
      friends: obj({ total: int('Friends who have one'), items: arr(ref('FriendRef'), 'The first 12 by name') }),
    }),
  }),
  '/api/species/{name}/catches': get('Catches of one species, newest first', {
    params: [p('name', str()), ...paging(20)],
    codes: [400, 404],
    schema: page(ref('Catch')),
  }),
  '/api/catches': get('Every catch, filtered and sorted', {
    params: [
      gameQ,
      q('species', str(), 'Species API name'),
      q('shiny', str(null, { enum: ['true', 'false'] })),
      q('method', str(), 'One of `catchMethods` from /api/meta'),
      q('sort', str(null, { enum: ['-date', 'date', '-level', 'level', 'dex'], default: '-date' }), 'A leading `-` means descending. Ties are broken newest first.'),
      ...paging(50),
    ],
    schema: page(ref('Catch')),
  }),
  '/api/games': get('Owned games, in release order', {
    codes: [],
    schema: obj({ items: arr(obj({ game: ref('GameRef'), generation: ref('GenerationRef'), platform: str(), copies: int('Cartridges or copies owned'), playthroughs: int(), hours: int(), startedAt: date(), lastPlayed: date(), dexSize: int('Species in its regional Pokédex'), dexCaught: int('Of those, species caught in this game') })) }),
  }),
  '/api/games/{id}': get('One game (owned or not)', {
    params: [p('id', str(), 'Game id, such as `red`')],
    codes: [404],
    schema: obj({
      game: { allOf: [ref('GameRef'), obj({ generation: ref('GenerationRef'), platform: str() })] },
      counterpart: nullable(ref('GameRef')),
      dexSize: int(),
      mine: nullable(obj({ copies: int(), playthroughs: int(), startedAt: date(), lastPlayed: date(), hours: int(), dexCaught: int(), catchCount: int(), shinyCount: int() }, 'null when the game isn\'t owned')),
      hoursByMonth: arr(obj({ month: str('`YYYY-MM`'), hours: { type: 'number', description: 'One decimal' } }), 'The last 12 months, oldest first'),
      counterpartExclusives: arr(obj({ species: ref('SpeciesRef'), caught: bool('Caught in any game') }), 'Species found in the wild in the counterpart version but not in this one, by Pokédex number. Empty without a counterpart.'),
    }),
  }),
  '/api/games/{id}/dex': get('A game\'s regional Pokédex, with what was caught in that game', {
    params: [p('id', str()), q('status', str(null, { enum: ['all', 'caught', 'missing'], default: 'all' })), ...paging(50)],
    codes: [400, 404],
    schema: page(obj({ number: int('Regional Pokédex number'), species: ref('SpeciesRef'), caught: bool('Caught in this game') })),
  }),
  '/api/friends': get('Friends', {
    params: [q('sort', str(null, { enum: ['name', 'trades', 'can-help', 'last-trade'], default: 'name' }), '`trades`, `can-help` and `last-trade` sort descending; ties by name'), ...paging(25)],
    schema: page(obj({ friend: ref('FriendRef'), friendCode: str(), since: date(), gameCount: int(), tradeCount: int(), lastTradeAt: nullable(date()), canHelp: int('Species the trainer needs that this friend has') })),
  }),
  '/api/friends/{id}': get('One friend', {
    params: [p('id', int())],
    codes: [404],
    schema: obj({
      friend: ref('FriendRef'),
      friendCode: str(),
      since: date(),
      games: arr(ref('GameRef'), 'Games they own, in release order'),
      tradeCount: int(),
      firstTradeAt: nullable(date()),
      lastTradeAt: nullable(date()),
      canHelp: arr(ref('SpeciesRef'), 'Species the trainer needs that this friend has, by Pokédex number'),
      tradesByYear: arr(obj({ year: str('`YYYY`'), count: int() }), 'From the year of the first trade (or of `since`) to the current year'),
    }),
  }),
  '/api/trades': {
    ...get('Trades', {
      params: [
        q('friend', int(), 'Friend id'),
        gameQ,
        q('evolved', str(null, { enum: ['true', 'false'] }), 'Only trade evolutions (or only others)'),
        q('year', int()),
        q('sort', str(null, { enum: ['-date', 'date'], default: '-date' }), 'Ties are broken by id, the same way'),
        ...paging(50),
      ],
      schema: page(ref('Trade')),
    }),
    post: {
      summary: 'Log a trade',
      description: 'Creates the trade and a catch (method `Trade`) of what you received. Trades logged this way never evolve.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['friendId', 'game', 'gave', 'received'],
              properties: { friendId: int(), game: str('Id of a game you own'), gave: str('Species API name'), received: str('Species API name'), tradedAt: date('Defaults to today; can\'t be later') },
            },
          },
        },
      },
      responses: { 201: json(ref('Trade'), 'Created'), ...errors(400) },
    },
  },
  '/api/trades/{id}': get('One trade', {
    params: [p('id', int())],
    codes: [404],
    schema: { allOf: [ref('Trade'), obj({ evolvedFrom: nullable(ref('SpeciesRef')), evolutionMethod: nullable(str('such as `Trade holding Metal Coat`')) })] },
  }),
  '/api/hunts': get('Shiny hunts', {
    params: [q('status', str(null, { enum: ['active', 'completed', 'failed'] })), q('sort', str(null, { enum: ['-started', 'encounters'], default: '-started' }), '`encounters`: most first'), ...paging(25)],
    schema: page(ref('Hunt')),
  }),
  '/api/hunts/{id}': get('One shiny hunt', { params: [p('id', int())], codes: [404], schema: ref('Hunt') }),
  '/api/hunts/{id}/encounters': {
    post: {
      summary: 'Add encounters to an active hunt',
      parameters: [p('id', int())],
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { count: int('Default 1', { minimum: 1, maximum: 1000 }) } } } } },
      responses: { 200: json(ref('Hunt'), 'The updated hunt'), ...errors(400, 404, 409) },
    },
  },
};

const doc = {
  openapi: '3.1.0',
  info: {
    title: 'Dex Tracker API',
    version: '1.0.0',
    description: [
      'The backend for Dex Tracker, maintained by another team. It covers one trainer: their games, catches, friends, trades and shiny hunts, plus Pokémon reference data.',
      '',
      '- All responses are JSON, except images under `/media/`. Errors are `{ "error": "..." }` with status 400, 404 or 409.',
      '- Lists that page take `page` (1-based) and `pageSize`, and return `{ items, page, pageSize, total, totalPages }`. A page past the end returns no items.',
      '- Every `/api` response takes about 30 ms, like a real service. Responses are `Cache-Control: no-store`: the data changes, including through the POST endpoints.',
      '- Dates are `YYYY-MM-DD` strings. The data has its own current date (`today` in /api/me and /api/meta).',
      '- Image URLs in responses are absolute. Images can be cached.',
      '- CORS is open, so browsers can call the API directly.',
    ].join('\n'),
  },
  paths,
  components: { schemas },
};

fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`Wrote ${OUT}`);
