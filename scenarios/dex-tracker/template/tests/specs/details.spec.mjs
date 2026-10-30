// Games, friends and Pokémon: the list and detail pages.
import { test, expect } from '@playwright/test';
import {
  api, num, dex, yesNo, orDash, ratioPercents, parts, main, section, table, phrase, rows, optionTexts,
  expectHeaders, expectRows, expectQuery, expectHref, expectDefinitions, expectChart, textOf,
} from './helpers.mjs';

test.describe('Games', () => {
  test('lists owned games', async ({ page }) => {
    const { items } = await api('/api/games');
    await page.goto('/games');
    const t = table(main(page), 'Games');
    await expectHeaders(t, ['Game', 'Platform', 'Copies', 'Playthroughs', 'Hours', 'Started', 'Last played', 'Pokédex', 'Completion']);
    const found = await rows(t);
    expect(found.map((r) => r.slice(0, 8))).toEqual(
      items.map((g) => [g.game.displayName, g.platform, num(g.copies), num(g.playthroughs), num(g.hours), g.startedAt, g.lastPlayed, `${num(g.dexCaught)} / ${num(g.dexSize)}`]),
    );
    found.forEach((r, i) => expect(ratioPercents(items[i].dexCaught, items[i].dexSize)).toContain(r[8]));
    await expectHref(t.getByRole('link', { name: items[0].game.displayName, exact: true }), `/games/${items[0].game.id}`);
  });

  test('shows an owned game', async ({ page }) => {
    // The most recently played game, so its hours chart has data.
    const id = (await api('/api/games')).items.sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed))[0].game.id;
    const g = await api(`/api/games/${id}`);
    await page.goto(`/games/${id}`);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(g.game.displayName);
    await expectDefinitions(main(page), [
      ['Generation', g.game.generation.displayName],
      ['Platform', g.game.platform],
      ['Counterpart', g.counterpart ? g.counterpart.displayName : '—'],
      ['Copies', num(g.mine.copies)],
      ['Playthroughs', num(g.mine.playthroughs)],
      ['Hours', num(g.mine.hours)],
      ['Started', g.mine.startedAt],
      ['Last played', g.mine.lastPlayed],
      ['Catches', num(g.mine.catchCount)],
      ['Shiny', num(g.mine.shinyCount)],
    ]);
    const data = await expectChart(section(page, 'Hours per month'), 'Hours per month', g.hoursByMonth.map((h) => ({ label: h.month, value: h.hours.toFixed(1), n: h.hours })), { horizontal: false });
    await expectHeaders(data, ['Month', 'Hours']);
    await expectRows(data, g.hoursByMonth.map((h) => [h.month, h.hours.toFixed(1)]));

    if (g.counterpart) {
      const s = section(page, 'Version exclusives');
      await expect(s).toContainText(`Found in the wild in ${g.counterpart.displayName} but not in ${g.game.displayName}`);
      if (g.counterpartExclusives.length) {
        const items = s.getByRole('listitem');
        await expect(items).toHaveCount(g.counterpartExclusives.length);
        for (const [i, e] of g.counterpartExclusives.entries()) expect(await textOf(items.nth(i))).toMatch(parts(e.species.displayName, `(${e.caught ? 'caught' : 'needed'})`));
        await expectHref(s.getByRole('link', { name: g.counterpartExclusives[0].species.displayName, exact: true }), `/pokemon/${g.counterpartExclusives[0].species.name}`);
      } else await expect(phrase(s, 'None')).toBeVisible();
    }
  });

  test("shows a game's Pokédex, filtered and paged", async ({ page }) => {
    const id = (await api('/api/games')).items.find((g) => g.dexSize > 100).game.id;
    const g = await api(`/api/games/${id}`);
    const dexRow = (e) => [String(e.number), e.species.displayName, yesNo(e.caught)];
    await page.goto(`/games/${id}`);
    const s = section(page, 'Pokédex');
    await expect(phrase(s, `${num(g.mine.dexCaught)} of ${num(g.dexSize)} caught`)).toBeVisible();
    expect(await optionTexts(s.getByLabel('Show', { exact: true }))).toEqual(['All', 'Caught', 'Missing']);
    const t = table(s, 'Regional Pokédex');
    await expectHeaders(t, ['No.', 'Pokémon', 'Caught']);
    await expectRows(t, (await api(`/api/games/${id}/dex`)).items.map(dexRow));
    await s.getByRole('link', { name: 'Next page', exact: true }).click();
    await expectQuery(page, { page: '2' });
    await expectRows(table(section(page, 'Pokédex'), 'Regional Pokédex'), (await api(`/api/games/${id}/dex?page=2`)).items.map(dexRow));
    await section(page, 'Pokédex').getByLabel('Show', { exact: true }).selectOption({ label: 'Missing' });
    await expectQuery(page, { status: 'missing' });
    await expectRows(table(section(page, 'Pokédex'), 'Regional Pokédex'), (await api(`/api/games/${id}/dex?status=missing`)).items.map(dexRow));
  });

  test("shows a game Robin doesn't own", async ({ page }) => {
    const owned = new Set((await api('/api/games')).items.map((g) => g.game.id));
    const id = (await api('/api/meta')).games.find((g) => !owned.has(g.id)).id;
    const g = await api(`/api/games/${id}`);
    await page.goto(`/games/${id}`);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(g.game.displayName);
    await expect(phrase(main(page), "You don't own this game.")).toBeVisible();
    await expect(section(page, 'Hours per month')).toHaveCount(0);
    await expect(phrase(section(page, 'Pokédex'), `0 of ${num(g.dexSize)} caught`)).toBeVisible();
  });
});

test.describe('Friends', () => {
  const friendRow = (f) => [f.friend.name, f.friendCode, num(f.gameCount), num(f.tradeCount), num(f.canHelp), orDash(f.lastTradeAt)];

  test('lists friends by name, 25 per page', async ({ page }) => {
    const data = await api('/api/friends');
    await page.goto('/friends');
    const m = main(page);
    await expect(phrase(m, `${num(data.total)} friends`)).toBeVisible();
    const t = table(m, 'Friends');
    await expectHeaders(t, ['Name', 'Friend code', 'Games', 'Trades', 'Can help', 'Last trade']);
    await expectRows(t, data.items.map(friendRow));
    await expect(t.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
    await expectHref(t.getByRole('link', { name: data.items[0].friend.name, exact: true }), `/friends/${data.items[0].friend.id}`);
    await m.getByRole('link', { name: 'Next page', exact: true }).click();
    await expectQuery(page, { page: '2' });
    await expectRows(table(main(page), 'Friends'), (await api('/api/friends?page=2')).items.map(friendRow));
  });

  test('sorts by column headers, in the URL', async ({ page }) => {
    await page.goto('/friends?page=3');
    for (const [header, sort] of [['Trades', 'trades'], ['Can help', 'can-help'], ['Last trade', 'last-trade'], ['Name', 'name']]) {
      const t = table(main(page), 'Friends');
      const h = t.getByRole('columnheader', { name: header });
      await h.getByRole('link', { name: header }).or(h.getByRole('button', { name: header })).click();
      await expectQuery(page, sort === 'name' ? {} : { sort });
      await expect(table(main(page), 'Friends').getByRole('columnheader', { name: header })).toHaveAttribute('aria-sort', sort === 'name' ? 'ascending' : 'descending');
      for (const other of ['Name', 'Trades', 'Can help', 'Last trade'].filter((o) => o !== header)) {
        await expect(table(main(page), 'Friends').getByRole('columnheader', { name: other })).not.toHaveAttribute('aria-sort', /ascending|descending/);
      }
      await expectRows(table(main(page), 'Friends'), (await api(`/api/friends?sort=${sort}`)).items.map(friendRow));
    }
  });

  test('includes a friend added after the build', async ({ page }) => {
    await page.goto('/friends?sort=last-trade');
    expect((await rows(table(main(page), 'Friends')))[0][0]).toBe('Benchmon Fan');
  });

  test('shows a friend', async ({ page }) => {
    const top = (await api('/api/friends?sort=trades&pageSize=1')).items[0].friend;
    const f = await api(`/api/friends/${top.id}`);
    const recent = await api(`/api/trades?friend=${f.friend.id}&pageSize=10`);
    await page.goto(`/friends/${f.friend.id}`);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(f.friend.name);
    await expectDefinitions(main(page), [
      ['Friend code', f.friendCode],
      ['Friends since', f.since],
      ['Trades', num(f.tradeCount)],
      ['First trade', orDash(f.firstTradeAt)],
      ['Last trade', orDash(f.lastTradeAt)],
    ]);
    const games = section(page, 'Games').getByRole('link');
    await expect(games).toHaveText(f.games.map((g) => g.displayName));
    await expectHref(games.first(), `/games/${f.games[0].id}`);

    const help = section(page, 'Can help with');
    if (f.canHelp.length) {
      await expect(phrase(help, `${num(f.canHelp.length)} species you need`)).toBeVisible();
      await expect(help.getByRole('link')).toHaveText(f.canHelp.map((s) => s.displayName));
    } else await expect(phrase(help, 'Nothing you need')).toBeVisible();

    const data = await expectChart(section(page, 'Trades per year'), 'Trades per year', f.tradesByYear.map((y) => ({ label: y.year, value: num(y.count), n: y.count })), { horizontal: false });
    await expectRows(data, f.tradesByYear.map((y) => [y.year, num(y.count)]));

    const s = section(page, 'Recent trades');
    const t = table(s, `Recent trades with ${f.friend.name}`);
    await expectHeaders(t, ['Date', 'Game', 'Gave', 'Received']);
    await expectRows(t, recent.items.map((r) => [r.tradedAt, r.game.displayName, r.gave.displayName, r.received.displayName]));
    await expectHref(t.getByRole('link', { name: recent.items[0].tradedAt, exact: true }).first(), `/trades/${recent.items[0].id}`);
    await expectHref(s.getByRole('link', { name: `All trades with ${f.friend.name}`, exact: true }), `/trades?friend=${f.friend.id}`);
  });
});

test.describe('Pokémon', () => {
  test('shows a species with a trade evolution', async ({ page }) => {
    const p = await api('/api/species/slowpoke');
    const catches = await api('/api/species/slowpoke/catches');
    await page.goto('/pokemon/slowpoke');
    const m = main(page);
    await expect(m.getByRole('heading', { level: 1 })).toHaveText('Slowpoke');
    await expect(m.getByText(dex(p.species.id), { exact: true })).toBeVisible();
    await expect(m.getByText(p.species.genus, { exact: true })).toBeVisible();
    await expect(m.getByRole('img', { name: 'Slowpoke', exact: true }).first()).toBeVisible();
    await expectDefinitions(m, [
      ['Caught', num(p.mine.caught)],
      ['Shiny', num(p.mine.shiny)],
      ['First caught', orDash(p.mine.firstCaught)],
      ['Last caught', orDash(p.mine.lastCaught)],
    ]);

    const evo = section(page, 'Evolution');
    const top = evo.getByRole('list').first().getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Slowpoke', exact: true }) }).first();
    const next = top.getByRole('list').getByRole('listitem');
    await expect(next).toHaveCount(2);
    expect(await textOf(next.filter({ hasText: 'Slowking' }))).toMatch(parts('Slowking', 'Trade holding King’s Rock'));
    expect(await textOf(next.filter({ hasText: 'Slowbro' }))).toMatch(parts('Slowbro', 'Level 37'));
    await expectHref(evo.getByRole('link', { name: 'Slowking', exact: true }), '/pokemon/slowking');

    const t = table(section(page, 'Where to find'), 'Availability');
    await expectHeaders(t, ['Game', 'In the wild', 'Owned']);
    await expectRows(t, p.availability.map((a) => [a.game.displayName, yesNo(a.wild), yesNo(a.owned)]));

    const friends = section(page, 'Friends who have it');
    await expect(phrase(friends, `${num(p.friends.total)} friends`)).toBeVisible();
    await expect(friends.getByRole('link')).toHaveText(p.friends.items.map((f) => f.name));

    const mine = table(section(page, 'My catches'), 'My catches of Slowpoke');
    await expectHeaders(mine, ['Date', 'Game', 'Level', 'Method', 'Shiny']);
    await expectRows(mine, catches.items.map((c) => [c.caughtAt, c.game.displayName, String(c.level), c.method, yesNo(c.shiny)]));
  });

  test("shows Eevee's branching family", async ({ page }) => {
    await page.goto('/pokemon/eevee');
    const evo = section(page, 'Evolution');
    const eevee = evo.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Eevee', exact: true }) }).first();
    await expect(eevee.getByRole('list').first().getByRole('listitem')).toHaveCount(8);
    await expect(evo.getByRole('link', { name: 'Sylveon', exact: true })).toBeVisible();
  });

  test('shows a species not caught yet', async ({ page }) => {
    const need = (await api('/api/needs')).items[0].species;
    await page.goto(`/pokemon/${need.name}`);
    await expectDefinitions(main(page), [
      ['Caught', '0'],
      ['Shiny', '0'],
      ['First caught', '—'],
      ['Last caught', '—'],
    ]);
    await expect(phrase(section(page, 'My catches'), 'Not caught yet')).toBeVisible();
  });
});
