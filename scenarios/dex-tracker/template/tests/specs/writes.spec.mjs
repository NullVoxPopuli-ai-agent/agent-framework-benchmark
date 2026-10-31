// Writes through the app. These run after every other test (see playwright.config.mjs),
// one at a time, since they change totals the other tests check.
import { test, expect } from '@playwright/test';
import { api, num, main, section, table, rows, optionTexts, expectDefinitions } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

test.describe('Writes', () => {
  test('the trade form lists friends and owned games', async ({ page }) => {
    const games = (await api('/api/games')).items;
    const meta = await api('/api/meta');
    await page.goto('/trades/new');
    const friend = page.getByLabel('Friend', { exact: true });
    await expect.poll(async () => (await optionTexts(friend)).includes('Benchmon Fan')).toBe(true);
    expect((await optionTexts(friend)).length).toBeGreaterThanOrEqual(151);
    await expect.poll(async () => (await optionTexts(page.getByLabel('Game', { exact: true }))).filter((o) => o)).toEqual(games.map((g) => g.game.displayName));
    await expect(page.getByLabel('Date', { exact: true })).toHaveValue(meta.today);
  });

  test('logging a trade shows it everywhere', async ({ page }) => {
    const before = (await api('/api/me')).stats;
    const game = (await api('/api/games')).items[1].game;
    await page.goto('/trades/new');
    await page.getByLabel('Friend', { exact: true }).selectOption({ label: 'Benchmon Fan' });
    await page.getByLabel('Game', { exact: true }).selectOption({ label: game.displayName });
    await page.getByLabel('You gave', { exact: true }).fill('pikachu');
    await page.getByLabel('You received', { exact: true }).fill('Mr. Mime');
    await page.getByRole('button', { name: 'Log trade', exact: true }).click();

    await expect(page).toHaveURL(/\/trades\/\d+$/);
    const id = Number(new URL(page.url()).pathname.split('/').pop());
    const trade = await api(`/api/trades/${id}`);
    expect(trade.received.name).toBe('mr-mime');
    expect(trade.friend.name).toBe('Benchmon Fan');
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(`Trade #${id}`);
    await expectDefinitions(main(page), [
      ['Friend', 'Benchmon Fan'],
      ['Game', game.displayName],
      ['You gave', 'Pikachu'],
      ['You received', 'Mr. Mime'],
    ]);

    // Pages the app may have cached must show the new trade.
    await page.goto('/trades');
    await expect.poll(async () => (await rows(table(main(page), 'Trades')))[0]?.slice(1, 5)).toEqual(['Benchmon Fan', game.displayName, 'Pikachu', 'Mr. Mime']);
    await page.goto('/');
    await expect(section(page, 'Summary').getByRole('definition').nth(2)).toHaveText(num(before.tradeCount + 1));
    await expect(section(page, 'Recent activity').getByRole('listitem').first()).toContainText('Traded Pikachu to Benchmon Fan for Mr. Mime');
    await page.goto('/friends/151');
    await expect(table(section(page, 'Recent trades'), 'Recent trades with Benchmon Fan').getByRole('row').nth(1)).toContainText('Mr. Mime');
  });

  test('a rejected trade shows why', async ({ page }) => {
    const before = (await api('/api/me')).stats.tradeCount;
    await page.goto('/trades/new');
    await page.getByLabel('Friend', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('You gave', { exact: true }).fill('Pikachu');
    await page.getByLabel('You received', { exact: true }).fill('Missingno');
    await page.getByRole('button', { name: 'Log trade', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toBeVisible();
    await expect(page).toHaveURL(/\/trades\/new/);
    expect((await api('/api/me')).stats.tradeCount).toBe(before);
  });

  test('adding encounters to an active hunt', async ({ page }) => {
    const hunt = (await api('/api/hunts?status=active&pageSize=1')).items[0];
    await page.goto(`/hunts/${hunt.id}`);
    const encounters = () => main(page).getByRole('definition').nth(5);
    await expect(encounters()).toHaveText(num(hunt.encounters));
    const button = main(page).getByRole('button', { name: 'Add encounter', exact: true });
    for (let i = 1; i <= 3; i++) {
      await button.click();
      await expect(encounters()).toHaveText(num(hunt.encounters + i));
    }
    await expect.poll(async () => (await api(`/api/hunts/${hunt.id}`)).encounters).toBe(hunt.encounters + 3);
    await page.reload();
    await expect(encounters()).toHaveText(num(hunt.encounters + 3));
    await page.goto('/hunts?status=active');
    await expect(table(main(page), 'Hunts').getByRole('row').filter({ hasText: hunt.species.displayName }).first()).toContainText(num(hunt.encounters + 3));
  });
});
