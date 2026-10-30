import { test, expect } from '@playwright/test';
import { api, main, expectHref, expectNavigation, getWithHost, section, table } from './helpers.mjs';

const NAV = [
  ['Overview', '/'],
  ['Needs', '/needs'],
  ['Catches', '/catches'],
  ['Games', '/games'],
  ['Friends', '/friends'],
  ['Trades', '/trades'],
  ['Hunts', '/hunts'],
];

const PAGES = [
  ['/', 'Overview', 'Dex Tracker'],
  ['/needs', 'Needs', 'Needs – Dex Tracker'],
  ['/catches', 'Catches', 'Catches – Dex Tracker'],
  ['/games', 'Games', 'Games – Dex Tracker'],
  ['/games/red', 'Red', 'Red – Dex Tracker'],
  ['/friends', 'Friends', 'Friends – Dex Tracker'],
  ['/trades', 'Trades', 'Trades – Dex Tracker'],
  ['/trades/1', 'Trade #1', 'Trade #1 – Dex Tracker'],
  ['/trades/new', 'Log a trade', 'Log a trade – Dex Tracker'],
  ['/hunts', 'Shiny hunts', 'Shiny hunts – Dex Tracker'],
  ['/pokemon/pikachu', 'Pikachu', 'Pikachu – Dex Tracker'],
  ['/pokemon/missingno', 'Not found', 'Not found – Dex Tracker'],
];

test.describe('Every page', () => {
  for (const [url, h1, title] of PAGES) {
    test(`${url} has the shared layout`, async ({ page }) => {
      await page.goto(url);
      await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(h1);
      await expect(main(page).getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page).toHaveTitle(title);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');

      const home = page.getByRole('banner').getByRole('link', { name: 'Dex Tracker', exact: true });
      await expect(home).toBeVisible();
      await expectHref(home, '/');

      const nav = page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Hunts', exact: true }) });
      await expect(nav.getByRole('link')).toHaveText(NAV.map(([name]) => name));
      for (const [name, href] of NAV) await expectHref(nav.getByRole('link', { name, exact: true }), href);

      await expect(page.getByRole('contentinfo')).toContainText(
        'Dex Tracker is a fan project. Pokémon and Pokémon character names are trademarks of Nintendo.',
      );
    });
  }

  test('the server answers for any host name', async ({ baseURL }) => {
    for (const path of ['/', '/needs', '/pokemon/pikachu']) {
      expect(await getWithHost(baseURL + path, 'dex-tracker.example:8443'), path).toBeLessThan(400);
    }
  });
});

test.describe('Not found', () => {
  for (const url of ['/nope', '/pokemon/missingno', '/games/pokemon-gray', '/friends/9999', '/trades/9999999', '/hunts/9999999']) {
    test(`${url} shows Not found`, async ({ page }) => {
      await page.goto(url);
      await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Not found');
      await expectHref(main(page).getByRole('link').first(), '/');
    });
  }
});

// Each link must be a navigation Chrome can measure: a new document or a soft navigation.
test.describe('Navigation', () => {
  test('Overview to Needs, then to a Pokémon', async ({ page }) => {
    const needs = await api('/api/needs');
    await page.goto('/');
    await expect(section(page, 'Summary')).toBeVisible();
    await expectNavigation(page, () => page.getByRole('navigation').getByRole('link', { name: 'Needs', exact: true }).click(), /\/needs$/);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Needs');
    const first = needs.items[0].species;
    const link = table(main(page), 'Needed species').getByRole('link', { name: first.displayName, exact: true });
    await expectNavigation(page, () => link.click(), new RegExp(`/pokemon/${first.name}$`));
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(first.displayName);
  });

  test('Overview to a game from the completion chart', async ({ page }) => {
    const { items } = await api('/api/stats/completion-by-game');
    const game = items[0].game;
    await page.goto('/');
    await expectNavigation(page, () => section(page, 'Completion by game').getByRole('link', { name: game.displayName, exact: true }).click(), new RegExp(`/games/${game.id}$`));
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(game.displayName);
  });

  test('Trades to the next page, then to a friend', async ({ page }) => {
    const second = await api('/api/trades?page=2');
    await page.goto('/trades');
    await expectNavigation(page, () => main(page).getByRole('link', { name: 'Next page', exact: true }).click(), /\/trades\?page=2$/);
    const friend = second.items[0].friend;
    await expect(table(main(page), 'Trades').getByRole('link', { name: friend.name, exact: true }).first()).toBeVisible();
    await expectNavigation(page, () => table(main(page), 'Trades').getByRole('link', { name: friend.name, exact: true }).first().click(), new RegExp(`/friends/${friend.id}$`));
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(friend.name);
  });

  test('Back returns to the previous page', async ({ page }) => {
    await page.goto('/needs');
    await page.getByRole('navigation').getByRole('link', { name: 'Hunts', exact: true }).click();
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Shiny hunts');
    await page.goBack();
    await expect(page).toHaveURL(/\/needs$/);
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Needs');
  });
});
