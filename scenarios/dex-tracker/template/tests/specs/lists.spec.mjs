// The paged, filtered lists: Needs, Catches, Trades and Shiny hunts.
import { test, expect } from '@playwright/test';
import { api, num, dex, orDash, yesNo, main, table, phrase, expectOptions, expectHeaders, expectRows, expectQuery, expectHref, expectDefinitions, rows } from './helpers.mjs';

const needRow = (n) => [
  dex(n.species.id),
  n.species.displayName,
  n.species.types.map((t) => t.displayName).join(', '),
  n.wildIn.length ? n.wildIn.map((g) => g.displayName).join(', ') : '—',
  num(n.friendCount),
  n.tradeEvolution ? `${n.tradeEvolution.how} from ${n.tradeEvolution.from.displayName}` : '—',
];
const catchRow = (c) => [c.caughtAt, c.species.displayName, c.game.displayName, String(c.level), c.method, orDash(c.ball), yesNo(c.shiny)];
const tradeRow = (t) => [t.tradedAt, t.friend.name, t.game.displayName, t.gave.displayName, t.received.displayName, yesNo(t.evolved)];
const status = (s) => s[0].toUpperCase() + s.slice(1);
const huntRow = (h) => [h.species.displayName, h.game.displayName, h.method, h.startedAt, orDash(h.endedAt), status(h.status), num(h.encounters)];

const pageText = (data) => `Page ${num(data.page)} of ${num(data.totalPages)}`;

test.describe('Needs', () => {
  test('lists needed species, 50 per page', async ({ page }) => {
    const data = await api('/api/needs');
    await page.goto('/needs');
    const m = main(page);
    await expect(phrase(m, `${num(data.total)} species needed`)).toBeVisible();
    const t = table(m, 'Needed species');
    await expectHeaders(t, ['#', 'Pokémon', 'Types', 'Wild in', 'Friends', 'Trade evolution']);
    await expectRows(t, data.items.map(needRow));
    const first = data.items[0].species;
    await expectHref(t.getByRole('link', { name: first.displayName, exact: true }), `/pokemon/${first.name}`);
    await expect(t.getByRole('row').nth(1).locator('img')).toHaveCount(1);
    await expect(phrase(m, pageText(data))).toBeVisible();
    await expect(m.getByRole('link', { name: 'Previous page', exact: true })).toHaveCount(0);

    await m.getByRole('link', { name: 'Next page', exact: true }).click();
    await expectQuery(page, { page: '2' });
    await expectRows(t, (await api('/api/needs?page=2')).items.map(needRow));
    await expect(m.getByRole('link', { name: 'Previous page', exact: true })).toBeVisible();
  });

  test('has labelled filters', async ({ page }) => {
    const meta = await api('/api/meta');
    await page.goto('/needs');
    await expectOptions(page.getByLabel('Generation', { exact: true }), ['All generations', ...meta.generations.map((g) => g.displayName)]);
    await expectOptions(page.getByLabel('Source', { exact: true }), ['All sources', 'Wild in my games', 'Friends have it', 'Trade evolution']);
    await expectOptions(page.getByLabel('Sort', { exact: true }), ['Pokédex number', 'Most friends']);
  });

  test('filters and sorts, in the URL', async ({ page }) => {
    await page.goto('/needs?page=2');
    await page.getByLabel('Source', { exact: true }).selectOption({ label: 'Trade evolution' });
    await expectQuery(page, { source: 'trade-evolution' });
    const trade = await api('/api/needs?source=trade-evolution');
    await expect(phrase(main(page), `${num(trade.total)} species needed`)).toBeVisible();
    await expectRows(table(main(page), 'Needed species'), trade.items.map(needRow));

    await page.getByLabel('Sort', { exact: true }).selectOption({ label: 'Most friends' });
    await expectQuery(page, { source: 'trade-evolution', sort: 'friends' });
    await expectRows(table(main(page), 'Needed species'), (await api('/api/needs?source=trade-evolution&sort=friends')).items.map(needRow));

    await page.getByLabel('Source', { exact: true }).selectOption({ label: 'All sources' });
    await page.getByLabel('Generation', { exact: true }).selectOption({ label: 'Generation I' });
    await expectQuery(page, { sort: 'friends', generation: 'generation-i' });
    await expectRows(table(main(page), 'Needed species'), (await api('/api/needs?generation=generation-i&sort=friends')).items.map(needRow));
  });

  test('loads a filtered view from the URL', async ({ page }) => {
    const data = await api('/api/needs?source=wild&generation=generation-iv');
    await page.goto('/needs?source=wild&generation=generation-iv');
    await expect(page.getByLabel('Source', { exact: true })).toHaveValue('wild');
    await expect(page.getByLabel('Generation', { exact: true })).toHaveValue('generation-iv');
    await expectRows(table(main(page), 'Needed species'), data.items.map(needRow));
  });

  test('says when nothing is needed', async ({ page }) => {
    const meta = await api('/api/meta');
    let empty;
    for (const g of meta.generations) {
      for (const source of ['wild', 'trade-evolution']) {
        if ((await api(`/api/needs?generation=${g.name}&source=${source}`)).total === 0) empty ??= `generation=${g.name}&source=${source}`;
      }
    }
    test.skip(!empty, 'no empty combination in this data');
    await page.goto(`/needs?${empty}`);
    await expect(phrase(main(page), 'Nothing needed')).toBeVisible();
    await expect(table(main(page), 'Needed species')).toHaveCount(0);
  });
});

test.describe('Catches', () => {
  test('lists catches, newest first, 50 per page', async ({ page }) => {
    const data = await api('/api/catches');
    await page.goto('/catches');
    const m = main(page);
    await expect(phrase(m, `${num(data.total)} catches`)).toBeVisible();
    const t = table(m, 'Catches');
    await expectHeaders(t, ['Date', 'Pokémon', 'Game', 'Level', 'Method', 'Ball', 'Shiny']);
    await expectRows(t, data.items.map(catchRow));
    await expectHref(t.getByRole('link', { name: data.items[0].game.displayName, exact: true }).first(), `/games/${data.items[0].game.id}`);
    await expect(phrase(m, pageText(data))).toBeVisible();
  });

  test('has labelled filters', async ({ page }) => {
    const meta = await api('/api/meta');
    await page.goto('/catches');
    await expectOptions(page.getByLabel('Game', { exact: true }), ['All games', ...meta.games.map((g) => g.displayName)]);
    await expectOptions(page.getByLabel('Method', { exact: true }), ['All methods', ...meta.catchMethods]);
    await expectOptions(page.getByLabel('Sort', { exact: true }), ['Newest first', 'Oldest first', 'Highest level', 'Lowest level', 'Pokédex number']);
    await expect(page.getByRole('checkbox', { name: 'Shiny only', exact: true })).not.toBeChecked();
  });

  test('filters, sorts and pages, in the URL', async ({ page }) => {
    await page.goto('/catches');
    await page.getByRole('checkbox', { name: 'Shiny only', exact: true }).check();
    await expectQuery(page, { shiny: 'true' });
    const shiny = await api('/api/catches?shiny=true');
    await expect(phrase(main(page), `${num(shiny.total)} catches`)).toBeVisible();
    await expectRows(table(main(page), 'Catches'), shiny.items.map(catchRow));

    await page.getByLabel('Sort', { exact: true }).selectOption({ label: 'Highest level' });
    await expectQuery(page, { shiny: 'true', sort: '-level' });
    await expectRows(table(main(page), 'Catches'), (await api('/api/catches?shiny=true&sort=-level')).items.map(catchRow));

    await main(page).getByRole('link', { name: 'Next page', exact: true }).click();
    await expectQuery(page, { shiny: 'true', sort: '-level', page: '2' });
    await expectRows(table(main(page), 'Catches'), (await api('/api/catches?shiny=true&sort=-level&page=2')).items.map(catchRow));

    await page.getByLabel('Game', { exact: true }).selectOption({ label: 'Red' });
    await expectQuery(page, { shiny: 'true', sort: '-level', game: 'red' });
    await page.getByLabel('Method', { exact: true }).selectOption({ label: 'Egg' });
    await expectQuery(page, { shiny: 'true', sort: '-level', game: 'red', method: 'Egg' });
    const none = await api('/api/catches?shiny=true&game=red&method=Egg');
    if (none.total === 0) await expect(phrase(main(page), 'No catches')).toBeVisible();
    else await expectRows(table(main(page), 'Catches'), none.items.map(catchRow));
  });

  test('loads the last page from the URL', async ({ page }) => {
    const first = await api('/api/catches?method=Raid');
    const last = await api(`/api/catches?method=Raid&page=${first.totalPages}`);
    await page.goto(`/catches?method=Raid&page=${first.totalPages}`);
    await expectRows(table(main(page), 'Catches'), last.items.map(catchRow));
    await expect(phrase(main(page), pageText(last))).toBeVisible();
    await expect(main(page).getByRole('link', { name: 'Next page', exact: true })).toHaveCount(0);
  });
});

test.describe('Trades', () => {
  test('lists trades, newest first, including one made after the build', async ({ page }) => {
    const data = await api('/api/trades');
    await page.goto('/trades');
    const m = main(page);
    await expectHref(m.getByRole('link', { name: 'Log a trade', exact: true }), '/trades/new');
    await expect(phrase(m, `${num(data.total)} trades`)).toBeVisible();
    const t = table(m, 'Trades');
    await expectHeaders(t, ['Date', 'Friend', 'Game', 'Gave', 'Received', 'Evolved']);
    await expectRows(t, data.items.map(tradeRow));
    await expect.poll(async () => (await rows(t))[0]?.[1]).toBe('Benchmon Fan'); // from tests/fixtures/live-data.sql
    const first = data.items[0];
    await expectHref(t.getByRole('link', { name: first.tradedAt, exact: true }).first(), `/trades/${first.id}`);
    await expectHref(t.getByRole('link', { name: first.friend.name, exact: true }).first(), `/friends/${first.friend.id}`);
    await expectHref(t.getByRole('link', { name: first.received.displayName, exact: true }).first(), `/pokemon/${first.received.name}`);
  });

  test('has labelled filters', async ({ page }) => {
    const meta = await api('/api/meta');
    const friends = (await api('/api/friends?pageSize=200')).items;
    await page.goto('/trades');
    await expectOptions(page.getByLabel('Friend', { exact: true }), ['All friends', ...friends.map((f) => f.friend.name)]);
    await expectOptions(page.getByLabel('Game', { exact: true }), ['All games', ...meta.games.map((g) => g.displayName)]);
    const year = Number(meta.today.slice(0, 4));
    await expectOptions(page.getByLabel('Year', { exact: true }), ['All years', ...Array.from({ length: year - 2015 }, (_, i) => String(year - i))]);
    await expectOptions(page.getByLabel('Sort', { exact: true }), ['Newest first', 'Oldest first']);
  });

  test('filters and sorts, in the URL', async ({ page }) => {
    const friend = (await api('/api/friends?sort=trades&pageSize=1')).items[0].friend;
    await page.goto('/trades');
    await page.getByLabel('Friend', { exact: true }).selectOption({ label: friend.name });
    await expectQuery(page, { friend: String(friend.id) });
    await expectRows(table(main(page), 'Trades'), (await api(`/api/trades?friend=${friend.id}`)).items.map(tradeRow));

    await page.getByLabel('Year', { exact: true }).selectOption({ label: '2024' });
    await page.getByRole('checkbox', { name: 'Trade evolutions only', exact: true }).check();
    await expectQuery(page, { friend: String(friend.id), year: '2024', evolved: 'true' });
    const filtered = await api(`/api/trades?friend=${friend.id}&year=2024&evolved=true`);
    if (filtered.total) await expectRows(table(main(page), 'Trades'), filtered.items.map(tradeRow));
    else await expect(phrase(main(page), 'No trades')).toBeVisible();

    await page.getByLabel('Friend', { exact: true }).selectOption({ label: 'All friends' });
    await page.getByLabel('Sort', { exact: true }).selectOption({ label: 'Oldest first' });
    await expectQuery(page, { year: '2024', evolved: 'true', sort: 'date' });
    const all = await api('/api/trades?year=2024&evolved=true&sort=date');
    await expect(phrase(main(page), `${num(all.total)} trades`)).toBeVisible();
    await expectRows(table(main(page), 'Trades'), all.items.map(tradeRow));
  });

  test('shows a trade', async ({ page }) => {
    const evolved = (await api('/api/trades?evolved=true&pageSize=1')).items[0];
    const t = await api(`/api/trades/${evolved.id}`);
    await page.goto(`/trades/${t.id}`);
    await expectDefinitions(main(page), [
      ['Date', t.tradedAt],
      ['Friend', t.friend.name],
      ['Game', t.game.displayName],
      ['You gave', t.gave.displayName],
      ['You received', t.received.displayName],
      ['Evolved', `Yes, from ${t.evolvedFrom.displayName} (${t.evolutionMethod})`],
    ]);
    await expectHref(main(page).getByRole('link', { name: t.friend.name, exact: true }), `/friends/${t.friend.id}`);
    await expectHref(main(page).getByRole('link', { name: t.evolvedFrom.displayName, exact: true }), `/pokemon/${t.evolvedFrom.name}`);

    const plain = await api('/api/trades/1');
    await page.goto('/trades/1');
    await expect(main(page).getByRole('definition').last()).toHaveText(plain.evolved ? /^Yes/ : 'No');
  });
});

test.describe('Shiny hunts', () => {
  test('lists hunts, newest first, 25 per page', async ({ page }) => {
    const data = await api('/api/hunts');
    await page.goto('/hunts');
    const m = main(page);
    await expect(phrase(m, `${num(data.total)} hunts`)).toBeVisible();
    const t = table(m, 'Hunts');
    await expectHeaders(t, ['Pokémon', 'Game', 'Method', 'Started', 'Ended', 'Status', 'Encounters']);
    await expectRows(t, data.items.map(huntRow));
    await expectHref(t.getByRole('link', { name: data.items[0].species.displayName, exact: true }).first(), `/hunts/${data.items[0].id}`);
    await expect(phrase(m, pageText(data))).toBeVisible();
  });

  test('filters by status and sorts, in the URL', async ({ page }) => {
    await page.goto('/hunts');
    await expectOptions(page.getByLabel('Status', { exact: true }), ['All statuses', 'Active', 'Completed', 'Failed']);
    await expectOptions(page.getByLabel('Sort', { exact: true }), ['Newest first', 'Most encounters']);
    await page.getByLabel('Status', { exact: true }).selectOption({ label: 'Failed' });
    await expectQuery(page, { status: 'failed' });
    await page.getByLabel('Sort', { exact: true }).selectOption({ label: 'Most encounters' });
    await expectQuery(page, { status: 'failed', sort: 'encounters' });
    await expectRows(table(main(page), 'Hunts'), (await api('/api/hunts?status=failed&sort=encounters')).items.map(huntRow));
  });

  test('shows a hunt', async ({ page }) => {
    const h = (await api('/api/hunts?status=completed&pageSize=1')).items[0];
    await page.goto(`/hunts/${h.id}`);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(`${h.species.displayName} hunt`);
    await expectDefinitions(main(page), [
      ['Game', h.game.displayName],
      ['Method', h.method],
      ['Started', h.startedAt],
      ['Ended', orDash(h.endedAt)],
      ['Status', 'Completed'],
      ['Encounters', num(h.encounters)],
    ]);
    await expectHref(main(page).getByRole('link', { name: h.species.displayName, exact: true }), `/pokemon/${h.species.name}`);
    await expect(main(page).getByRole('button', { name: 'Add encounter' })).toHaveCount(0);
  });
});
