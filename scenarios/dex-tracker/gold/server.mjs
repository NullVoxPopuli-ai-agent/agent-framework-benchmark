// Gold-standard Dex Tracker implementation (harness only; never shown to agents).
// A dependency-free Node server that renders every page to HTML from the Dex Tracker API.
// The only client script is a few inline lines that apply filter changes to the URL.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const API = (process.env.API_BASE_URL ?? 'http://localhost:9000').replace(/\/$/, '');

const STATIC = {
  '/tokens.css': path.join(ROOT, 'public/tokens.css'),
  '/styles.css': path.join(ROOT, 'public/styles.css'),
};

// ---------- API access ----------

class NotFound extends Error {}
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(pathname, init) {
  const res = await fetch(`${API}/api/${pathname}`, init);
  const body = await res.json().catch(() => ({}));
  if (res.status === 404) throw new NotFound(pathname);
  if (!res.ok) throw new ApiError(res.status, body.error ?? `${res.status} ${pathname}`);
  return body;
}

const api = (pathname, params) => request(params ? `${pathname}?${query(params)}` : pathname);
const post = (pathname, data) =>
  request(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

// /api/meta (generations, games, catch methods) never changes, so it's the one cached response.
let metaPromise;
function meta() {
  metaPromise ??= api('meta').catch((err) => {
    metaPromise = undefined;
    throw err;
  });
  return metaPromise;
}

// Every friend, by name (the API pages them 100 at a time).
async function allFriends() {
  const first = await api('friends', { sort: 'name', pageSize: 100 });
  const rest = await Promise.all(
    Array.from({ length: first.totalPages - 1 }, (_, i) => api('friends', { sort: 'name', pageSize: 100, page: i + 2 })),
  );
  return [first, ...rest].flatMap((p) => p.items.map((f) => f.friend));
}

// Builds a query string, leaving out empty values.
function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  return q.toString();
}

// ---------- Formatting ----------

const nf = new Intl.NumberFormat('en-US');
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const num = (n) => nf.format(n);
const pct = (n) => `${nf1.format(n)}%`;
const percentOf = (part, whole) => (whole ? (part / whole) * 100 : 0);
const dexNumber = (id) => `#${String(id).padStart(4, '0')}`;
const yesNo = (b) => (b ? 'Yes' : 'No');
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

// ---------- HTML helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class Raw {
  constructor(value) {
    this.value = value;
  }
}
const fragment = (v) =>
  v instanceof Raw ? v.value : Array.isArray(v) ? v.map(fragment).join('') : v === null || v === undefined || v === false ? '' : esc(v);

// Tagged template that escapes interpolated values; nested html`` results and arrays pass through.
function html(strings, ...values) {
  return new Raw(strings.reduce((out, s, i) => out + fragment(values[i - 1]) + s));
}

const NAV = [
  ['Overview', '/'],
  ['Needs', '/needs'],
  ['Catches', '/catches'],
  ['Games', '/games'],
  ['Friends', '/friends'],
  ['Trades', '/trades'],
  ['Hunts', '/hunts'],
];

// Applies a filter change: rebuilds the query from the form, leaving out empty and default
// values (and the page), and loads it.
const FILTER_SCRIPT = `document.addEventListener('change', (e) => {
  const form = e.target.closest('form[data-filters]');
  if (!form) return;
  const q = new URLSearchParams();
  for (const el of form.elements) {
    if (!el.name || (el.type === 'checkbox' && !el.checked)) continue;
    if (el.value && el.value !== el.dataset.default) q.set(el.name, el.value);
  }
  location.assign(form.getAttribute('action') + (q.size ? '?' + q : ''));
});`;

function layout({ h1, title = `${h1} – Dex Tracker`, nav, body, status = 200 }) {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="site-header">
  <div class="site-header__inner">
    <a class="site-header__brand" href="/">Dex Tracker</a>
    <nav aria-label="Main">
      <ul class="site-nav">
        ${NAV.map(([label, href]) => html`<li><a href="${href}"${new Raw(href === nav ? ' aria-current="page"' : '')}>${label}</a></li>`)}
      </ul>
    </nav>
  </div>
</header>
<main class="page">
${body}
</main>
<footer class="site-footer">
  <p>Dex Tracker is a fan project. Pokémon and Pokémon character names are trademarks of Nintendo.</p>
</footer>
<script>${new Raw(FILTER_SCRIPT)}</script>
</body>
</html>`;
  return { status, body: doc.value };
}

const pokemonLink = (s) => html`<a href="/pokemon/${s.name}">${s.displayName}</a>`;
const gameLink = (g) => html`<a href="/games/${g.id}">${g.displayName}</a>`;
const friendLink = (f) => html`<a href="/friends/${f.id}">${f.name}</a>`;
const sprite = (s) => html`<img class="sprite" src="${s.sprite}" alt="" width="48" height="48" loading="lazy">`;
const pokemonCell = (s) => html`<span class="pokemon-cell">${sprite(s)}${pokemonLink(s)}</span>`;
const typeBadges = (types) =>
  html`<span class="types">${types.map((t) => html`<span class="type-badge" style="--badge-color: var(--type-${t.name})">${t.displayName}</span>`)}</span>`;

const section = (id, heading, content) => html`<section class="panel" aria-labelledby="${id}-heading">
  <h2 id="${id}-heading">${heading}</h2>
  ${content}
</section>`;

// A description list from [term, value] pairs.
const facts = (pairs, cls = 'facts') =>
  html`<dl class="${cls}">${pairs.map(([term, value]) => html`<div><dt>${term}</dt><dd>${value}</dd></div>`)}</dl>`;

// A data table. `columns` are [header, cellFn, className?] triples.
function table({ caption, columns, rows, captionClass = 'sr-only' }) {
  return html`<div class="table-scroll">
<table class="data-table">
  <caption class="${captionClass}">${caption}</caption>
  <thead><tr>${columns.map(([h, , cls]) => html`<th scope="col" class="${cls ?? ''}">${h}</th>`)}</tr></thead>
  <tbody>${rows.map((r) => html`<tr>${columns.map(([, cell, cls]) => html`<td class="${cls ?? ''}">${cell(r)}</td>`)}</tr>`)}</tbody>
</table>
</div>`;
}

function pagination({ page, totalPages }, href) {
  if (totalPages <= 1) return html`<p class="pagination">Page ${num(page)} of ${num(totalPages)}</p>`;
  return html`<nav class="pagination" aria-label="Pagination">
  ${page > 1 ? html`<a href="${href(page - 1)}">Previous page</a>` : ''}
  <span>Page ${num(page)} of ${num(totalPages)}</span>
  ${page < totalPages ? html`<a href="${href(page + 1)}">Next page</a>` : ''}
</nav>`;
}

// Reads the 1-based `page` query parameter (anything invalid means page 1).
const pageParam = (url) => Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);

// A URL for `pathname` with the given state; empty values and defaults are left out.
function hrefWith(pathname, params, defaults = {}) {
  const kept = Object.fromEntries(Object.entries(params).filter(([k, v]) => v !== defaults[k]));
  const q = query(kept);
  return q ? `${pathname}?${q}` : pathname;
}

// A paged API list that names a page past the end is a page that doesn't exist.
function checkPage(list) {
  if (list.page > 1 && list.page > list.totalPages) throw new NotFound('page');
  return list;
}

// ---------- Filters ----------

const option = (value, label, selected) => html`<option value="${value}"${new Raw(value === selected ? ' selected' : '')}>${label}</option>`;

const selectFilter = ({ name, label, options, value, defaultValue = '' }) => html`<div class="field">
  <label for="f-${name}">${label}</label>
  <select id="f-${name}" name="${name}" data-default="${defaultValue}">${options.map(([v, l]) => option(v, l, value))}</select>
</div>`;

const checkboxFilter = ({ name, label, checked }) => html`<div class="field field--check">
  <input type="checkbox" id="f-${name}" name="${name}" value="true"${new Raw(checked ? ' checked' : '')}>
  <label for="f-${name}">${label}</label>
</div>`;

const filters = (action, fields) => html`<form class="filters" action="${action}" method="get" data-filters>
  ${fields}
  <noscript><button type="submit">Apply</button></noscript>
</form>`;

// ---------- Charts ----------

const CHART_ROW = 28; // bar chart row pitch, px
const CHART_HEIGHT = 200; // column chart plot height, px (--chart-height)
const LABEL_BAND = 24; // space under columns for their labels

// Round tick values from 0 up to (at most) max; whole numbers only for whole-number data.
function ticks(max, integer) {
  if (max <= 0) return [0];
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough);
  if (integer) step = Math.max(1, Math.ceil(step));
  const out = [];
  for (let t = 0; t <= max + 1e-9; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}

// Every chart has a visually hidden data table of the same items. `columns` are
// [header, cellFn] pairs.
const chartTable = (title, items, columns) =>
  html`<div class="sr-only">${table({ caption: `${title} data`, columns, rows: items })}</div>`;
const labelValueColumns = (labelHeader, valueHeader) => [
  [labelHeader, (i) => i.label],
  [valueHeader, (i) => i.formatted],
];

// Horizontal bars, one per item, labels (HTML, so they can be links) to the left and values
// to the right. items: { label, labelHtml?, value, formatted }
function barChart(title, items, columns) {
  const max = Math.max(0, ...items.map((i) => i.value));
  const height = items.length * CHART_ROW;
  const thickness = 18; // --chart-bar-thickness
  return html`<figure class="chart chart--bars">
  <ul class="chart__bar-labels">${items.map((i) => html`<li>${i.labelHtml ?? i.label}</li>`)}</ul>
  <svg role="img" aria-label="${title}" width="100%" height="${height}" class="chart__svg">
    ${items.map(
      (i, n) =>
        html`<rect class="chart__mark" x="0" y="${n * CHART_ROW + (CHART_ROW - thickness) / 2}" width="${max ? ((i.value / max) * 100).toFixed(4) : 0}%" height="${thickness}" rx="2"><title>${i.label}: ${i.formatted}</title></rect>`,
    )}
    <line class="chart__axis" x1="0.5" x2="0.5" y1="0" y2="${height}"/>
  </svg>
  <ul class="chart__bar-values" aria-hidden="true">${items.map((i) => html`<li>${i.formatted}</li>`)}</ul>
</figure>
${chartTable(title, items, columns)}`;
}

// Vertical columns, one per item, labels below, with round-number gridlines. To fit, only
// every `every`th label is shown (every `everyNarrow`th on narrow screens), counting back
// from the newest.
function columnChart(title, items, columns, { every = 1, everyNarrow = every } = {}) {
  const max = Math.max(0, ...items.map((i) => i.value));
  const slot = 100 / items.length;
  const gap = slot * 0.3;
  const y = (v) => CHART_HEIGHT - (max ? (v / max) * CHART_HEIGHT : 0);
  const tickValues = ticks(max, items.every((i) => Number.isInteger(i.value)));
  const labelClass = (n) => {
    const fromEnd = items.length - 1 - n;
    if (fromEnd % every) return 'chart__label chart__label--hidden';
    return fromEnd % everyNarrow ? 'chart__label chart__label--wide' : 'chart__label';
  };
  return html`<figure class="chart chart--columns" style="max-width: ${items.length * 4 + 3}rem">
  <div class="chart__y-axis" aria-hidden="true">${tickValues.map((t) => html`<span style="top: ${y(t)}px">${num(t)}</span>`)}</div>
  <svg role="img" aria-label="${title}" width="100%" height="${CHART_HEIGHT + LABEL_BAND}" class="chart__svg">
    ${tickValues.filter((t) => t > 0).map((t) => html`<line class="chart__grid" x1="0" x2="100%" y1="${y(t)}" y2="${y(t)}"/>`)}
    ${items.map(
      (i, n) =>
        html`<rect class="chart__mark" x="${(n * slot + gap / 2).toFixed(4)}%" y="${y(i.value).toFixed(3)}" width="${(slot - gap).toFixed(4)}%" height="${(CHART_HEIGHT - y(i.value)).toFixed(3)}" rx="2"><title>${i.label}: ${i.formatted}</title></rect>`,
    )}
    <line class="chart__axis" x1="0" x2="100%" y1="${CHART_HEIGHT - 0.5}" y2="${CHART_HEIGHT - 0.5}"/>
    ${items.map((i, n) => html`<text class="${labelClass(n)}" x="${((n + 0.5) * slot).toFixed(4)}%" y="${CHART_HEIGHT + 16}" text-anchor="middle">${i.label}</text>`)}
  </svg>
</figure>
${chartTable(title, items, columns)}`;
}

// ---------- Pages ----------

const activityLimit = (url) => Math.min(500, Math.max(10, Math.ceil((parseInt(url.searchParams.get('activity'), 10) || 10) / 10) * 10));

// Fetches the newest `limit` activity items, 50 per request, in parallel.
async function activity(limit) {
  const pages = await Promise.all(
    Array.from({ length: Math.ceil(limit / 50) }, (_, i) => api('activity', { limit: Math.min(50, limit - i * 50), offset: i * 50 })),
  );
  return { items: pages.flatMap((p) => p.items), hasMore: pages.at(-1).hasMore };
}

function activityItem(a) {
  let text;
  if (a.type === 'trade') {
    text = html`Traded ${pokemonLink(a.gave)} to ${friendLink(a.friend)} for ${pokemonLink(a.received)}${a.evolved ? ' (evolved)' : ''}`;
  } else if (a.type === 'hunt') {
    text = html`Shiny ${pokemonLink(a.species)} found in ${gameLink(a.game)} after ${num(a.encounters)} encounters`;
  } else {
    text = html`Caught ${pokemonLink(a.species)} in ${gameLink(a.game)}${a.shiny ? ' (shiny)' : ''}`;
  }
  const icon = a.type === 'trade' ? a.received : a.species;
  return html`<li class="activity__item activity__item--${a.type}">
  <time datetime="${a.date}">${a.date}</time>
  ${sprite(icon)}
  <span>${text}</span>
</li>`;
}

async function overviewPage(url) {
  const limit = activityLimit(url);
  const [me, completion, months, recent] = await Promise.all([
    api('me'),
    api('stats/completion-by-game'),
    api('stats/catches-by-month'),
    activity(limit),
  ]);
  const s = me.stats;
  const completionItems = completion.items.map((i) => ({
    label: i.game.displayName,
    labelHtml: gameLink(i.game),
    value: i.percent,
    formatted: pct(i.percent),
    ...i,
  }));
  const body = html`<h1>Overview</h1>
${section(
  'summary',
  'Summary',
  facts(
    [
      ['Species caught', `${num(s.speciesCaught)} of ${num(s.speciesTotal)}`],
      ['Shiny Pokémon', num(s.shinyCount)],
      ['Trades', num(s.tradeCount)],
      ['Hours played', num(s.hoursPlayed)],
      ['Active hunts', num(s.activeHunts)],
    ],
    'facts facts--stats',
  ),
)}
<div class="overview-charts">
${section(
  'completion',
  'Completion by game',
  barChart('Completion by game', completionItems, [
    ['Game', (i) => i.label],
    ['Caught', (i) => num(i.caught)],
    ['Pokédex', (i) => num(i.dexSize)],
    ['Completion', (i) => i.formatted],
  ]),
)}
${section(
  'catches-per-month',
  'Catches per month',
  columnChart(
    'Catches per month',
    months.items.map((m) => ({ label: m.month, value: m.count, formatted: num(m.count) })),
    labelValueColumns('Month', 'Catches'),
    { every: 3, everyNarrow: 6 },
  ),
)}
</div>
${section(
  'recent-activity',
  'Recent activity',
  html`<ol class="activity">${recent.items.map(activityItem)}</ol>
  ${recent.hasMore ? html`<p class="more"><a class="button" href="/?activity=${limit + 10}#recent-activity-heading">Show more</a></p>` : ''}`,
)}`;
  return layout({ h1: 'Overview', title: 'Dex Tracker', nav: '/', body });
}

async function needsPage(url) {
  const sp = url.searchParams;
  const state = { generation: sp.get('generation') ?? '', source: sp.get('source') || 'all', sort: sp.get('sort') || 'dex' };
  const defaults = { generation: '', source: 'all', sort: 'dex' };
  const page = pageParam(url);
  const [m, list] = await Promise.all([meta(), api('needs', { ...state, page, pageSize: 50 }).then(checkPage)]);
  const body = html`<h1>Needs</h1>
${filters('/needs', [
  selectFilter({
    name: 'generation',
    label: 'Generation',
    value: state.generation,
    options: [['', 'All generations'], ...m.generations.map((g) => [g.name, g.displayName])],
  }),
  selectFilter({
    name: 'source',
    label: 'Source',
    value: state.source,
    defaultValue: 'all',
    options: [
      ['all', 'All sources'],
      ['wild', 'Wild in my games'],
      ['friends', 'Friends have it'],
      ['trade-evolution', 'Trade evolution'],
    ],
  }),
  selectFilter({
    name: 'sort',
    label: 'Sort',
    value: state.sort,
    defaultValue: 'dex',
    options: [
      ['dex', 'Pokédex number'],
      ['friends', 'Most friends'],
    ],
  }),
])}
${
  list.total
    ? html`<p class="count">${num(list.total)} species needed</p>
${table({
  caption: 'Needed species',
  columns: [
    ['#', (i) => dexNumber(i.species.id), 'num-col muted'],
    ['Pokémon', (i) => pokemonCell(i.species)],
    ['Types', (i) => i.species.types.map((t) => t.displayName).join(', ')],
    ['Wild in', (i) => dash(i.wildIn.map((g) => g.displayName).join(', ')), 'wrap'],
    ['Friends', (i) => num(i.friendCount), 'num'],
    ['Trade evolution', (i) => (i.tradeEvolution ? html`${i.tradeEvolution.how} from ${pokemonLink(i.tradeEvolution.from)}` : '—')],
  ],
  rows: list.items,
})}
${pagination(list, (n) => hrefWith('/needs', { ...state, page: n }, { ...defaults, page: 1 }))}`
    : html`<p class="empty">Nothing needed</p>`
}`;
  return layout({ h1: 'Needs', nav: '/needs', body });
}

const CATCH_SORTS = [
  ['-date', 'Newest first'],
  ['date', 'Oldest first'],
  ['-level', 'Highest level'],
  ['level', 'Lowest level'],
  ['dex', 'Pokédex number'],
];

async function catchesPage(url) {
  const sp = url.searchParams;
  const state = {
    game: sp.get('game') ?? '',
    method: sp.get('method') ?? '',
    shiny: sp.get('shiny') === 'true' ? 'true' : '',
    sort: sp.get('sort') || '-date',
  };
  const defaults = { game: '', method: '', shiny: '', sort: '-date', page: 1 };
  const page = pageParam(url);
  const [m, list] = await Promise.all([meta(), api('catches', { ...state, page, pageSize: 50 }).then(checkPage)]);
  const body = html`<h1>Catches</h1>
${filters('/catches', [
  selectFilter({ name: 'game', label: 'Game', value: state.game, options: [['', 'All games'], ...m.games.map((g) => [g.id, g.displayName])] }),
  selectFilter({ name: 'method', label: 'Method', value: state.method, options: [['', 'All methods'], ...m.catchMethods.map((x) => [x, x])] }),
  selectFilter({ name: 'sort', label: 'Sort', value: state.sort, defaultValue: '-date', options: CATCH_SORTS }),
  checkboxFilter({ name: 'shiny', label: 'Shiny only', checked: state.shiny === 'true' }),
])}
${
  list.total
    ? html`<p class="count">${plural(list.total, 'catch', 'catches')}</p>
${table({
  caption: 'Catches',
  columns: [
    ['Date', (c) => c.caughtAt],
    ['Pokémon', (c) => pokemonCell(c.species)],
    ['Game', (c) => gameLink(c.game)],
    ['Level', (c) => c.level, 'num'],
    ['Method', (c) => c.method],
    ['Ball', (c) => dash(c.ball)],
    ['Shiny', (c) => yesNo(c.shiny)],
  ],
  rows: list.items,
})}
${pagination(list, (n) => hrefWith('/catches', { ...state, page: n }, defaults))}`
    : html`<p class="empty">No catches</p>`
}`;
  return layout({ h1: 'Catches', nav: '/catches', body });
}

async function gamesPage() {
  const games = await api('games');
  const body = html`<h1>Games</h1>
${table({
  caption: 'Games',
  columns: [
    ['Game', (g) => gameLink(g.game)],
    ['Platform', (g) => g.platform],
    ['Copies', (g) => num(g.copies), 'num'],
    ['Playthroughs', (g) => num(g.playthroughs), 'num'],
    ['Hours', (g) => num(g.hours), 'num'],
    ['Started', (g) => dash(g.startedAt)],
    ['Last played', (g) => dash(g.lastPlayed)],
    ['Pokédex', (g) => `${num(g.dexCaught)} / ${num(g.dexSize)}`, 'num'],
    ['Completion', (g) => pct(percentOf(g.dexCaught, g.dexSize)), 'num'],
  ],
  rows: games.items,
})}`;
  return layout({ h1: 'Games', nav: '/games', body });
}

async function gamePage(id, url) {
  const status = ['caught', 'missing'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'all';
  const page = pageParam(url);
  const [g, dex] = await Promise.all([api(`games/${encodeURIComponent(id)}`), api(`games/${encodeURIComponent(id)}/dex`, { status, page, pageSize: 50 })]);
  checkPage(dex);
  const name = g.game.displayName;
  const mine = g.mine;
  const pairs = [
    ['Generation', g.game.generation.displayName],
    ['Platform', g.game.platform],
    ['Counterpart', g.counterpart ? gameLink(g.counterpart) : '—'],
    ...(mine
      ? [
          ['Copies', num(mine.copies)],
          ['Playthroughs', num(mine.playthroughs)],
          ['Hours', num(mine.hours)],
          ['Started', dash(mine.startedAt)],
          ['Last played', dash(mine.lastPlayed)],
          ['Catches', num(mine.catchCount)],
          ['Shiny', num(mine.shinyCount)],
        ]
      : []),
  ];
  const self = `/games/${g.game.id}`;
  const body = html`<h1>${name}</h1>
<div class="panel panel--facts">
${facts(pairs)}
${mine ? '' : html`<p class="note">You don't own this game.</p>`}
</div>
${
  mine
    ? section(
        'hours',
        'Hours per month',
        columnChart(
          'Hours per month',
          g.hoursByMonth.map((h) => ({ label: h.month, value: h.hours, formatted: nf1.format(h.hours) })),
          labelValueColumns('Month', 'Hours'),
          { every: 1, everyNarrow: 3 },
        ),
      )
    : ''
}
${section(
  'pokedex',
  'Pokédex',
  html`<p class="lead">${num(mine?.dexCaught ?? 0)} of ${num(g.dexSize)} caught</p>
${filters(self, [
  selectFilter({
    name: 'status',
    label: 'Show',
    value: status,
    defaultValue: 'all',
    options: [
      ['all', 'All'],
      ['caught', 'Caught'],
      ['missing', 'Missing'],
    ],
  }),
])}
${
  dex.total
    ? html`${table({
        caption: 'Regional Pokédex',
        columns: [
          ['No.', (i) => i.number, 'num-col muted'],
          ['Pokémon', (i) => pokemonCell(i.species)],
          ['Caught', (i) => yesNo(i.caught)],
        ],
        rows: dex.items,
      })}
${pagination(dex, (n) => hrefWith(self, { status, page: n }, { status: 'all', page: 1 }))}`
    : html`<p class="empty">Nothing to show</p>`
}`,
)}
${
  g.counterpart
    ? section(
        'exclusives',
        'Version exclusives',
        html`<p class="lead">Found in the wild in ${g.counterpart.displayName} but not in ${name}</p>
${
  g.counterpartExclusives.length
    ? html`<ul class="link-columns">${g.counterpartExclusives.map(
        (e) => html`<li>${pokemonLink(e.species)} <span class="${e.caught ? 'status-yes' : 'status-no'}">(${e.caught ? 'caught' : 'needed'})</span></li>`,
      )}</ul>`
    : html`<p>None</p>`
}`,
      )
    : ''
}`;
  return layout({ h1: name, nav: '/games', body });
}

const FRIEND_SORTS = { name: 'ascending', trades: 'descending', 'can-help': 'descending', 'last-trade': 'descending' };

async function friendsPage(url) {
  const sort = FRIEND_SORTS[url.searchParams.get('sort')] ? url.searchParams.get('sort') : 'name';
  const page = pageParam(url);
  const list = checkPage(await api('friends', { sort, page, pageSize: 25 }));
  const sortable = (label, key) => {
    const header = html`<a class="sort-link" href="${hrefWith('/friends', { sort: key }, { sort: 'name' })}">${label}</a>`;
    return [header, key];
  };
  const columns = [
    [...sortable('Name', 'name'), (f) => friendLink(f.friend)],
    ['Friend code', null, (f) => f.friendCode],
    ['Games', null, (f) => num(f.gameCount), 'num'],
    [...sortable('Trades', 'trades'), (f) => num(f.tradeCount), 'num'],
    [...sortable('Can help', 'can-help'), (f) => num(f.canHelp), 'num'],
    [...sortable('Last trade', 'last-trade'), (f) => dash(f.lastTradeAt)],
  ];
  const body = html`<h1>Friends</h1>
<p class="count">${plural(list.total, 'friend', 'friends')}</p>
<div class="table-scroll">
<table class="data-table">
  <caption class="sr-only">Friends</caption>
  <thead><tr>${columns.map(
    ([h, key, , cls]) =>
      html`<th scope="col" class="${cls ?? ''}${key === sort ? ' sorted' : ''}"${new Raw(key === sort ? ` aria-sort="${FRIEND_SORTS[key]}"` : '')}>${h}</th>`,
  )}</tr></thead>
  <tbody>${list.items.map((f) => html`<tr>${columns.map(([, , cell, cls]) => html`<td class="${cls ?? ''}">${cell(f)}</td>`)}</tr>`)}</tbody>
</table>
</div>
${pagination(list, (n) => hrefWith('/friends', { sort, page: n }, { sort: 'name', page: 1 }))}`;
  return layout({ h1: 'Friends', nav: '/friends', body });
}

async function friendPage(id) {
  if (!/^\d+$/.test(id)) throw new NotFound(id);
  const [f, trades] = await Promise.all([api(`friends/${id}`), api('trades', { friend: id, pageSize: 10 })]);
  const name = f.friend.name;
  const body = html`<h1>${name}</h1>
<div class="panel panel--facts">
${facts([
  ['Friend code', f.friendCode],
  ['Friends since', f.since],
  ['Trades', num(f.tradeCount)],
  ['First trade', dash(f.firstTradeAt)],
  ['Last trade', dash(f.lastTradeAt)],
])}
</div>
<div class="two-col">
${section('games', 'Games', html`<ul class="link-columns">${f.games.map((g) => html`<li>${gameLink(g)}</li>`)}</ul>`)}
${section(
  'can-help',
  'Can help with',
  f.canHelp.length
    ? html`<p class="lead">${plural(f.canHelp.length, 'species you need', 'species you need')}</p>
<ul class="link-columns">${f.canHelp.map((s) => html`<li>${pokemonLink(s)}</li>`)}</ul>`
    : html`<p>Nothing you need</p>`,
)}
</div>
${section(
  'trades-per-year',
  'Trades per year',
  columnChart(
    'Trades per year',
    f.tradesByYear.map((y) => ({ label: y.year, value: y.count, formatted: num(y.count) })),
    labelValueColumns('Year', 'Trades'),
  ),
)}
${section(
  'recent-trades',
  'Recent trades',
  html`${
    trades.items.length
      ? table({
          caption: `Recent trades with ${name}`,
          columns: [
            ['Date', (t) => html`<a href="/trades/${t.id}">${t.tradedAt}</a>`],
            ['Game', (t) => gameLink(t.game)],
            ['Gave', (t) => pokemonLink(t.gave)],
            ['Received', (t) => pokemonLink(t.received)],
          ],
          rows: trades.items,
        })
      : html`<p>No trades yet</p>`
  }
<p class="more"><a href="/trades?friend=${f.friend.id}">All trades with ${name}</a></p>`,
)}`;
  return layout({ h1: name, nav: '/friends', body });
}

async function tradesPage(url) {
  const sp = url.searchParams;
  const state = {
    friend: /^\d+$/.test(sp.get('friend') ?? '') ? sp.get('friend') : '',
    game: sp.get('game') ?? '',
    year: /^\d{4}$/.test(sp.get('year') ?? '') ? sp.get('year') : '',
    evolved: sp.get('evolved') === 'true' ? 'true' : '',
    sort: sp.get('sort') === 'date' ? 'date' : '-date',
  };
  const defaults = { friend: '', game: '', year: '', evolved: '', sort: '-date', page: 1 };
  const page = pageParam(url);
  const [m, me, friends, list] = await Promise.all([
    meta(),
    api('me'),
    allFriends(),
    api('trades', { ...state, page, pageSize: 50 }).then(checkPage),
  ]);
  const currentYear = Number(me.today.slice(0, 4));
  const years = Array.from({ length: currentYear - 2016 + 1 }, (_, i) => String(currentYear - i));
  const body = html`<div class="page-head">
<h1>Trades</h1>
<a class="button" href="/trades/new">Log a trade</a>
</div>
${filters('/trades', [
  selectFilter({ name: 'friend', label: 'Friend', value: state.friend, options: [['', 'All friends'], ...friends.map((f) => [String(f.id), f.name])] }),
  selectFilter({ name: 'game', label: 'Game', value: state.game, options: [['', 'All games'], ...m.games.map((g) => [g.id, g.displayName])] }),
  selectFilter({ name: 'year', label: 'Year', value: state.year, options: [['', 'All years'], ...years.map((y) => [y, y])] }),
  selectFilter({
    name: 'sort',
    label: 'Sort',
    value: state.sort,
    defaultValue: '-date',
    options: [
      ['-date', 'Newest first'],
      ['date', 'Oldest first'],
    ],
  }),
  checkboxFilter({ name: 'evolved', label: 'Trade evolutions only', checked: state.evolved === 'true' }),
])}
${
  list.total
    ? html`<p class="count">${plural(list.total, 'trade', 'trades')}</p>
${table({
  caption: 'Trades',
  columns: [
    ['Date', (t) => html`<a href="/trades/${t.id}">${t.tradedAt}</a>`],
    ['Friend', (t) => friendLink(t.friend)],
    ['Game', (t) => gameLink(t.game)],
    ['Gave', (t) => pokemonLink(t.gave)],
    ['Received', (t) => pokemonLink(t.received)],
    ['Evolved', (t) => yesNo(t.evolved)],
  ],
  rows: list.items,
})}
${pagination(list, (n) => hrefWith('/trades', { ...state, page: n }, defaults))}`
    : html`<p class="empty">No trades</p>`
}`;
  return layout({ h1: 'Trades', nav: '/trades', body });
}

async function tradePage(id) {
  if (!/^\d+$/.test(id)) throw new NotFound(id);
  const t = await api(`trades/${id}`);
  const h1 = `Trade #${t.id}`;
  const evolved = t.evolved
    ? html`Yes, from ${t.evolvedFrom ? pokemonLink(t.evolvedFrom) : '—'} (${dash(t.evolutionMethod)})`
    : 'No';
  const body = html`<h1>${h1}</h1>
<div class="panel trade">
  <p class="trade__sprites" aria-hidden="true">${sprite(t.gave)}<span>⇄</span>${sprite(t.received)}</p>
${facts([
  ['Date', t.tradedAt],
  ['Friend', friendLink(t.friend)],
  ['Game', gameLink(t.game)],
  ['You gave', pokemonLink(t.gave)],
  ['You received', pokemonLink(t.received)],
  ['Evolved', evolved],
])}
</div>`;
  return layout({ h1, nav: '/trades', body });
}

// Finds a species by its English name (case-insensitive) or API name.
async function findSpecies(input) {
  const needle = input.trim().toLowerCase();
  if (!needle) return null;
  const { items } = await api('species', { q: needle, pageSize: 100 });
  return items.find((s) => s.displayName.toLowerCase() === needle) ?? items.find((s) => s.name === needle) ?? null;
}

async function newTradePage({ values = {}, error } = {}) {
  const [friends, games, me] = await Promise.all([allFriends(), api('games'), api('me')]);
  const v = { friend: '', game: '', gave: '', received: '', date: me.today, ...values };
  const body = html`<h1>Log a trade</h1>
<form class="panel trade-form" action="/trades/new" method="post">
  ${error ? html`<p class="alert" role="alert">${error}</p>` : ''}
  <div class="field">
    <label for="friend">Friend</label>
    <select id="friend" name="friend" required>${friends.map((f) => option(String(f.id), f.name, v.friend))}</select>
  </div>
  <div class="field">
    <label for="game">Game</label>
    <select id="game" name="game" required>${games.items.map((g) => option(g.game.id, g.game.displayName, v.game))}</select>
  </div>
  <div class="field">
    <label for="gave">You gave</label>
    <input id="gave" name="gave" type="text" value="${v.gave}" autocomplete="off" placeholder="Pikachu">
  </div>
  <div class="field">
    <label for="received">You received</label>
    <input id="received" name="received" type="text" value="${v.received}" autocomplete="off" placeholder="Eevee">
  </div>
  <div class="field">
    <label for="date">Date</label>
    <input id="date" name="date" type="date" value="${v.date}">
  </div>
  <div class="form-actions">
    <button class="button" type="submit">Log trade</button>
    <a href="/trades">Cancel</a>
  </div>
</form>`;
  return layout({ h1: 'Log a trade', nav: '/trades', body, status: error ? 400 : 200 });
}

async function createTrade(form) {
  const values = Object.fromEntries(['friend', 'game', 'gave', 'received', 'date'].map((k) => [k, form.get(k) ?? '']));
  const [gave, received] = await Promise.all([findSpecies(values.gave), findSpecies(values.received)]);
  const unknown = (label, input) => (input.trim() ? `No Pokémon is named “${input.trim()}”.` : `Enter the Pokémon ${label}.`);
  let error;
  if (!gave) error = unknown('you gave', values.gave);
  else if (!received) error = unknown('you received', values.received);
  else {
    try {
      const trade = await post('trades', {
        friendId: Number(values.friend),
        game: values.game,
        gave: gave.name,
        received: received.name,
        ...(values.date ? { tradedAt: values.date } : {}),
      });
      return { redirect: `/trades/${trade.id}` };
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      error = err.message;
    }
  }
  return newTradePage({ values, error });
}

const HUNT_STATUS = { active: 'Active', completed: 'Completed', failed: 'Failed' };

async function huntsPage(url) {
  const sp = url.searchParams;
  const state = {
    status: HUNT_STATUS[sp.get('status')] ? sp.get('status') : '',
    sort: sp.get('sort') === 'encounters' ? 'encounters' : '-started',
  };
  const page = pageParam(url);
  const list = checkPage(await api('hunts', { ...state, page, pageSize: 25 }));
  const body = html`<h1>Shiny hunts</h1>
${filters('/hunts', [
  selectFilter({
    name: 'status',
    label: 'Status',
    value: state.status,
    options: [['', 'All statuses'], ...Object.entries(HUNT_STATUS)],
  }),
  selectFilter({
    name: 'sort',
    label: 'Sort',
    value: state.sort,
    defaultValue: '-started',
    options: [
      ['-started', 'Newest first'],
      ['encounters', 'Most encounters'],
    ],
  }),
])}
<p class="count">${plural(list.total, 'hunt', 'hunts')}</p>
${
  list.total
    ? html`${table({
        caption: 'Hunts',
        columns: [
          ['Pokémon', (h) => html`<span class="pokemon-cell">${sprite(h.species)}<a href="/hunts/${h.id}">${h.species.displayName}</a></span>`],
          ['Game', (h) => gameLink(h.game)],
          ['Method', (h) => h.method],
          ['Started', (h) => h.startedAt],
          ['Ended', (h) => dash(h.endedAt)],
          ['Status', (h) => statusBadge(h.status)],
          ['Encounters', (h) => num(h.encounters), 'num'],
        ],
        rows: list.items,
      })}
${pagination(list, (n) => hrefWith('/hunts', { ...state, page: n }, { status: '', sort: '-started', page: 1 }))}`
    : html`<p class="empty">No hunts</p>`
}`;
  return layout({ h1: 'Shiny hunts', nav: '/hunts', body });
}

const statusBadge = (status) => html`<span class="status status--${status}">${HUNT_STATUS[status]}</span>`;

async function huntPage(id) {
  if (!/^\d+$/.test(id)) throw new NotFound(id);
  const h = await api(`hunts/${id}`);
  const h1 = `${h.species.displayName} hunt`;
  const body = html`<h1>${h1}</h1>
<div class="panel hunt">
  <div class="hunt__species">
    <img class="hunt__sprite" src="${h.species.sprite}" alt="" width="96" height="96">
    ${pokemonLink(h.species)}
  </div>
  ${facts([
    ['Game', gameLink(h.game)],
    ['Method', h.method],
    ['Started', h.startedAt],
    ['Ended', dash(h.endedAt)],
    ['Status', statusBadge(h.status)],
    ['Encounters', num(h.encounters)],
  ])}
  ${
    h.status === 'active'
      ? html`<form class="hunt__action" action="/hunts/${h.id}/encounters" method="post"><button class="button" type="submit">Add encounter</button></form>`
      : ''
  }
</div>`;
  return layout({ h1, nav: '/hunts', body });
}

async function addEncounter(id) {
  if (!/^\d+$/.test(id)) throw new NotFound(id);
  try {
    await post(`hunts/${id}/encounters`, { count: 1 });
  } catch (err) {
    // A hunt that's no longer active just shows its current state.
    if (!(err instanceof ApiError && err.status === 409)) throw err;
  }
  return { redirect: `/hunts/${id}` };
}

function evolutionTree(node, first = true) {
  return html`<li>
  ${pokemonLink(node.species)}${!first && node.how ? html` <span class="evo-how">${node.how}</span>` : ''}
  ${node.evolvesTo.length ? html`<ul>${node.evolvesTo.map((n) => evolutionTree(n, false))}</ul>` : ''}
</li>`;
}

async function pokemonPage(name) {
  const [p, catches] = await Promise.all([
    api(`species/${encodeURIComponent(name)}`),
    api(`species/${encodeURIComponent(name)}/catches`, { pageSize: 20 }),
  ]);
  const s = p.species;
  const title = s.displayName;
  const body = html`<div class="hero">
  <div class="hero__art"><img src="${s.artwork}" alt="${title}" width="288" height="288"></div>
  <div class="hero__info">
    <p class="hero__number">${dexNumber(s.id)}</p>
    <h1>${title}</h1>
    <p class="hero__genus">${s.genus}</p>
    <p class="type-list">${typeBadges(s.types)}</p>
    ${facts([
      ['Caught', num(p.mine.caught)],
      ['Shiny', num(p.mine.shiny)],
      ['First caught', dash(p.mine.firstCaught)],
      ['Last caught', dash(p.mine.lastCaught)],
    ])}
  </div>
</div>
<div class="two-col">
${section('evolution', 'Evolution', html`<ul class="evolution">${evolutionTree(p.evolution)}</ul>`)}
${section(
  'friends',
  'Friends who have it',
  html`<p class="lead">${plural(p.friends.total, 'friend', 'friends')}</p>
${p.friends.items.length ? html`<ul class="link-columns">${p.friends.items.slice(0, 12).map((f) => html`<li>${friendLink(f)}</li>`)}</ul>` : ''}`,
)}
</div>
${section(
  'where',
  'Where to find',
  table({
    caption: 'Availability',
    columns: [
      ['Game', (a) => gameLink(a.game)],
      ['In the wild', (a) => yesNo(a.wild)],
      ['Owned', (a) => yesNo(a.owned)],
    ],
    rows: p.availability,
  }),
)}
${section(
  'my-catches',
  'My catches',
  catches.items.length
    ? table({
        caption: `My catches of ${title}`,
        columns: [
          ['Date', (c) => c.caughtAt],
          ['Game', (c) => gameLink(c.game)],
          ['Level', (c) => c.level, 'num'],
          ['Method', (c) => c.method],
          ['Shiny', (c) => yesNo(c.shiny)],
        ],
        rows: catches.items,
      })
    : html`<p>Not caught yet</p>`,
)}`;
  return layout({ h1: title, nav: null, body });
}

function notFoundPage() {
  return layout({
    status: 404,
    h1: 'Not found',
    body: html`<h1>Not found</h1>
<div class="panel"><p>There's nothing at this address.</p><p><a href="/">Back to the overview</a></p></div>`,
  });
}

// ---------- Server ----------

async function route(req, url) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b, c] = parts;
  if (req.method === 'POST') {
    if (parts.length === 2 && a === 'trades' && b === 'new') return createTrade(new URLSearchParams(await readBody(req)));
    if (parts.length === 3 && a === 'hunts' && c === 'encounters') return addEncounter(b);
    return notFoundPage();
  }
  if (parts.length === 0) return overviewPage(url);
  if (parts.length === 1) {
    if (a === 'needs') return needsPage(url);
    if (a === 'catches') return catchesPage(url);
    if (a === 'games') return gamesPage();
    if (a === 'friends') return friendsPage(url);
    if (a === 'trades') return tradesPage(url);
    if (a === 'hunts') return huntsPage(url);
  }
  if (parts.length === 2) {
    if (a === 'games') return gamePage(b, url);
    if (a === 'friends') return friendPage(b);
    if (a === 'trades') return b === 'new' ? newTradePage() : tradePage(b);
    if (a === 'hunts') return huntPage(b);
    if (a === 'pokemon') return pokemonPage(b);
  }
  return notFoundPage();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = STATIC[url.pathname];
    if (file) {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }
    let page;
    try {
      page = await route(req, url);
    } catch (err) {
      // Unknown ids and names, and filter values the API rejects, are pages that don't exist.
      if (!(err instanceof NotFound || (err instanceof ApiError && err.status === 400))) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Internal error');
      }
      page = notFoundPage();
    }
    if (page.redirect) {
      res.writeHead(303, { Location: page.redirect });
      return res.end();
    }
    res.writeHead(page.status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page.body);
  })
  .listen(PORT, () => console.log(`Gold Dex Tracker on http://localhost:${PORT} (API ${API})`));
