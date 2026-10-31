import { test, expect } from '@playwright/test';
import { api, num, percent, parts, section, expectDefinitions, expectChart, expectHeaders, expectRows, expectHref, textOf, expectContainsText } from './helpers.mjs';

test.describe('Overview', () => {
  test('shows the summary', async ({ page }) => {
    const { stats } = await api('/api/me');
    await page.goto('/');
    await expectDefinitions(section(page, 'Summary'), [
      ['Species caught', `${num(stats.speciesCaught)} of ${num(stats.speciesTotal)}`],
      ['Shiny Pokémon', num(stats.shinyCount)],
      ['Trades', num(stats.tradeCount)],
      ['Hours played', num(stats.hoursPlayed)],
      ['Active hunts', num(stats.activeHunts)],
    ]);
  });

  test('charts completion by game', async ({ page }) => {
    const { items } = await api('/api/stats/completion-by-game');
    await page.goto('/');
    const s = section(page, 'Completion by game');
    const data = await expectChart(s, 'Completion by game', items.map((i) => ({ label: i.game.displayName, value: percent(i.percent), n: i.percent })), { horizontal: true });
    await expectHeaders(data, ['Game', 'Caught', 'Pokédex', 'Completion']);
    await expectRows(data, items.map((i) => [i.game.displayName, num(i.caught), num(i.dexSize), percent(i.percent)]));
    for (const i of items) await expectHref(s.getByRole('link', { name: i.game.displayName, exact: true }).first(), `/games/${i.game.id}`);
  });

  test('charts catches per month', async ({ page }) => {
    const { items } = await api('/api/stats/catches-by-month');
    await page.goto('/');
    const data = await expectChart(section(page, 'Catches per month'), 'Catches per month', items.map((i) => ({ label: i.month, value: num(i.count), n: i.count })), { horizontal: false });
    await expectHeaders(data, ['Month', 'Catches']);
    await expectRows(data, items.map((i) => [i.month, num(i.count)]));
  });

  test('lists recent activity, with more on request', async ({ page }) => {
    const { items } = await api('/api/activity?limit=20');
    // The date, then the description, with any punctuation between.
    const describe = (a) => {
      if (a.type === 'trade') return parts(a.date, `Traded ${a.gave.displayName} to ${a.friend.name} for ${a.received.displayName}${a.evolved ? ' (evolved)' : ''}`);
      if (a.type === 'hunt') return parts(a.date, `Shiny ${a.species.displayName} found in ${a.game.displayName} after ${num(a.encounters)} encounters`);
      return parts(a.date, `Caught ${a.species.displayName} in ${a.game.displayName}${a.shiny ? ' (shiny)' : ''}`);
    };
    await page.goto('/');
    const s = section(page, 'Recent activity');
    const list = s.getByRole('listitem');
    await expect(list).toHaveCount(10);
    for (let i = 0; i < 10; i++) expect(await textOf(list.nth(i))).toMatch(describe(items[i]));

    // Links in the newest items.
    const first = items[0];
    const firstItem = list.first();
    if (first.type === 'trade') {
      await expectHref(firstItem.getByRole('link', { name: first.friend.name, exact: true }), `/friends/${first.friend.id}`);
      await expectHref(firstItem.getByRole('link', { name: first.received.displayName, exact: true }), `/pokemon/${first.received.name}`);
    } else {
      await expectHref(firstItem.getByRole('link', { name: first.species.displayName, exact: true }), `/pokemon/${first.species.name}`);
      await expectHref(firstItem.getByRole('link', { name: first.game.displayName, exact: true }), `/games/${first.game.id}`);
    }
    for (const type of ['catch', 'hunt']) {
      const i = items.slice(0, 10).findIndex((a) => a.type === type);
      if (i < 0) continue;
      await expectHref(list.nth(i).getByRole('link', { name: items[i].game.displayName, exact: true }), `/games/${items[i].game.id}`);
    }

    await s.getByRole('button', { name: 'Show more', exact: true }).or(s.getByRole('link', { name: 'Show more', exact: true })).click();
    await expect(section(page, 'Recent activity').getByRole('listitem')).toHaveCount(20);
    for (const i of [10, 19]) expect(await textOf(section(page, 'Recent activity').getByRole('listitem').nth(i))).toMatch(describe(items[i]));
  });

  test('shows changes made to the data after the build', async ({ page }) => {
    // tests/fixtures/live-data.sql adds a trade with a new friend today.
    await page.goto('/');
    await expectContainsText(section(page, 'Recent activity').getByRole('listitem').first(), 'Benchmon Fan');
  });
});
