// Captures screenshots of an app's key pages at mobile and desktop widths.
// CLI: node bench/screenshots.mjs <baseURL> <outDir> [scenario, default pokedex]

import { chromium } from 'playwright';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The pages each scenario's SPEC.md lists under "Look and feel".
export const PAGES = {
  pokedex: {
    home: '/',
    'home-filtered': '/?type=fire&generation=generation-i',
    pokemon: '/pokemon/pikachu',
    'pokemon-moves': '/pokemon/pikachu?game=scarlet-violet#moves',
    move: '/moves/thunderbolt',
    ability: '/abilities/static',
    types: '/types',
    type: '/types/fire',
    'not-found': '/pokemon/missingno',
  },
  'dex-tracker': {
    overview: '/',
    needs: '/needs',
    catches: '/catches?shiny=true',
    games: '/games',
    game: '/games/red',
    friends: '/friends?sort=trades',
    friend: '/friends/1',
    trades: '/trades',
    trade: '/trades/1',
    'trade-new': '/trades/new',
    hunts: '/hunts',
    hunt: '/hunts/1',
    pokemon: '/pokemon/slowpoke',
    'not-found': '/pokemon/missingno',
  },
};
export const VIEWPORTS = { mobile: { width: 412, height: 915 }, desktop: { width: 1280, height: 800 } };
const MAX_HEIGHT = 4000;

export async function capture(base, out, scenario = 'pokedex') {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
      for (const [name, path] of Object.entries(PAGES[scenario])) {
        await page.goto(base + path, { waitUntil: 'networkidle' });
        // Let client-rendered pages and lazy images settle.
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);
        const anchored = path.includes('#');
        if (!anchored) {
          await page.evaluate(async () => {
            for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
              scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 50));
            }
            scrollTo(0, 0);
          });
          await page.waitForLoadState('networkidle');
        }
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.screenshot({
          path: `${out}/${name}-${vpName}.png`,
          fullPage: !anchored,
          clip: anchored ? undefined : { x: 0, y: 0, width: viewport.width, height: Math.min(height, MAX_HEIGHT) },
          animations: 'disabled',
        });
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base = 'http://localhost:3000', out = 'screenshots', scenario] = process.argv.slice(2);
  await capture(base, out, scenario);
  console.log(`Saved screenshots to ${out}`);
}
