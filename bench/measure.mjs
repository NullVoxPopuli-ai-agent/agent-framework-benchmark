#!/usr/bin/env node
// Measures one implementation:
//   node bench/measure.mjs <appDir> <outDir> [--runs N] [--scenario NAME] [--skip-build]
// Writes <outDir>/results.json, plus the first Lighthouse report of each URL.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { startStack, APP_ORIGIN, APP_PORT } from './stack.mjs';
import { runFlow, THROTTLING, WEB_VITALS_VERSION } from './flow.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const [appDirArg, outArg] = args.filter((a, i) => !a.startsWith('--') && !['--runs', '--scenario'].includes(args[i - 1]));
if (!appDirArg || !outArg) {
  console.error('Usage: measure.mjs <appDir> <outDir> [--runs N] [--scenario NAME] [--skip-build]');
  process.exit(1);
}
const RUNS = Number(valueOf('--runs')) || 5;
const SCENARIO = valueOf('--scenario') ?? 'pokedex';
// In the measure image, the scenario's exported template is at TEMPLATE_DIR.
const TEMPLATE = process.env.TEMPLATE_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scenarios', SCENARIO, 'template');
const appDir = path.resolve(appDirArg);
const out = path.resolve(outArg);
fs.mkdirSync(path.join(out, 'lighthouse'), { recursive: true });

const CHROME = chromium.executablePath();
// Completed with the flag that makes Chrome trust Caddy's certificates once the stack is up.
const CHROME_FLAGS = ['--headless=new', '--no-sandbox', '--disable-gpu'];

// What each scenario measures.
// - lighthouse: cold loads, one Lighthouse run per URL and repetition. pokedex uses
//   Lighthouse's default simulated throttling; dex-tracker uses its "devtools" throttling,
//   the same as the flow, because a flow can't be simulated.
// - flow: a session of clicks measured with web-vitals (see flow.mjs). The first click
//   after the cold load is the headline navigation.
// - apiEnv: the API's environment. pokedex's API has no latency; dex-tracker's has its
//   default 30 ms per request.
const nav = (name) => (page) => page.getByRole('navigation').getByRole('link', { name, exact: true });
const SCENARIOS = {
  pokedex: {
    lighthouse: {
      urls: {
        home: '/',
        'home-filtered': '/?type=fire&generation=generation-i',
        pokemon: '/pokemon/pikachu',
        move: '/moves/thunderbolt',
        ability: '/abilities/static',
        type: '/types/fire',
      },
      throttlingMethod: 'simulate',
    },
    apiEnv: { LATENCY_MS: '0' },
  },
  'dex-tracker': {
    lighthouse: {
      urls: { home: '/', needs: '/needs', pokemon: '/pokemon/slowpoke', friend: '/friends/1' },
      throttlingMethod: 'devtools',
    },
    apiEnv: {},
    flow: [
      { name: 'home', goto: '/' },
      { name: 'needs', click: nav('Needs'), url: /\/needs$/ },
      { name: 'pokemon', click: (page) => page.getByRole('table', { name: 'Needed species' }).getByRole('row').nth(1).getByRole('link').first(), url: /\/pokemon\/[^/?]+$/ },
      { name: 'trades', click: nav('Trades'), url: /\/trades$/ },
      { name: 'trades-page-2', click: (page) => page.getByRole('main').getByRole('link', { name: 'Next page', exact: true }), url: /\/trades\?page=2$/ },
    ],
  },
};
const SETUP = SCENARIOS[SCENARIO];
if (!SETUP) throw new Error(`No measurement setup for scenario ${SCENARIO}`);
const AUDITS = {
  lcp: 'largest-contentful-paint',
  fcp: 'first-contentful-paint',
  tbt: 'total-blocking-time',
  cls: 'cumulative-layout-shift',
  si: 'speed-index',
  ttfb: 'server-response-time',
  bytes: 'total-byte-weight',
};

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, d = 0) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

function summarizeLhr(lhr) {
  const metrics = Object.fromEntries(Object.entries(AUDITS).map(([k, id]) => [k, lhr.audits[id]?.numericValue ?? null]));
  const items = lhr.audits['resource-summary']?.details?.items ?? [];
  const bytesOf = (type) => items.find((i) => i.resourceType === type)?.transferSize ?? 0;
  const countOf = (type) => items.find((i) => i.resourceType === type)?.requestCount ?? 0;
  return {
    ...metrics,
    scriptBytes: bytesOf('script'),
    documentBytes: bytesOf('document'),
    imageBytes: bytesOf('image'),
    requests: countOf('total'),
    performance: lhr.categories.performance?.score ?? null,
    accessibility: lhr.categories.accessibility?.score ?? null,
  };
}

// Warm the app's server-side caches right before every run, so even caches that expire
// after 30 s are warm: the measured visit is a new user on a site other people already use.
async function warm(...urlPaths) {
  for (const urlPath of urlPaths) {
    for (let j = 0; j < 2; j++) await fetch(`http://localhost:${APP_PORT}${urlPath}`).then((r) => r.arrayBuffer()).catch(() => {});
  }
}

async function runLighthouse() {
  const results = {};
  // Lighthouse's mobile settings only. The desktop preset mostly measured the layout shift
  // caused by Linux scrollbars appearing, which macOS users never see.
  for (const [page, urlPath] of Object.entries(SETUP.lighthouse.urls)) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      await warm(urlPath);
      const chrome = await chromeLauncher.launch({ chromePath: CHROME, chromeFlags: CHROME_FLAGS });
      try {
        const { lhr } = await lighthouse(APP_ORIGIN + urlPath, {
          port: chrome.port,
          output: 'json',
          logLevel: 'error',
          onlyCategories: ['performance', 'accessibility'],
          throttlingMethod: SETUP.lighthouse.throttlingMethod,
        });
        if (lhr.runtimeError) throw new Error(`${urlPath}: ${lhr.runtimeError.message}`);
        runs.push(summarizeLhr(lhr));
        if (i === 0) fs.writeFileSync(path.join(out, 'lighthouse', `${page}-mobile.json`), JSON.stringify(lhr));
      } finally {
        await chrome.kill();
      }
    }
    const summary = Object.fromEntries(Object.keys(runs[0]).map((k) => [k, round(median(runs.map((r) => r[k])), 3)]));
    results[`${page}/mobile`] = { median: summary, runs };
    console.log(`  ${page.padEnd(14)} perf ${summary.performance}  LCP ${round(summary.lcp)}ms  TBT ${round(summary.tbt)}ms  CLS ${summary.cls}  JS ${round(summary.scriptBytes / 1024)}KiB`);
  }
  return results;
}

// The flow, RUNS times, each in a fresh browser. Per step, the median of each metric, or
// null unless every session produced one (a step that failed or wasn't detected in one
// session isn't summarized from the others).
async function measureFlow() {
  const runs = [];
  const visited = SETUP.flow.filter((s) => s.goto).map((s) => s.goto).concat(['/needs', '/trades', '/trades?page=2']);
  for (let i = 0; i < RUNS; i++) {
    await warm(...visited);
    runs.push(await runFlow({ origin: APP_ORIGIN, steps: SETUP.flow, chromeArgs: CHROME_FLAGS.filter((f) => f.startsWith('--ignore-certificate')) }));
  }
  const steps = SETUP.flow.map(({ name }, i) => {
    const each = runs.map((r) => r[i] ?? { type: 'skipped' });
    const types = [...new Set(each.map((s) => s.type))];
    const med = (key, d = 0) => (each.every((s) => typeof s[key] === 'number') ? round(median(each.map((s) => s[key])), d) : null);
    const targets = [...new Set(each.map((s) => s.lcpTarget).filter(Boolean))];
    return { name, type: types.join('/'), lcp: med('lcp'), lcpTargets: targets, fcp: med('fcp'), cls: med('cls', 3), clickToOrigin: med('clickToOrigin', 1) };
  });
  for (const s of steps) console.log(`  ${s.name.padEnd(14)} ${s.type.padEnd(5)} LCP ${s.lcp}ms  CLS ${s.cls}  ${s.lcpTargets.join(' | ')}`);
  return { webVitals: WEB_VITALS_VERSION, throttling: THROTTLING, steps, runs };
}

// ----- Code stats -----

// Lines of code the agent wrote: non-blank lines in the source files the app tracks (comments
// included). Not counted: JSON, lockfiles, tests, generated files, and verbatim copies of the
// provided design files (every app copies design/tokens.css).
function codeStats() {
  const files = spawnSync('git', ['-c', 'safe.directory=*', 'ls-files', '--cached', '--others', '--exclude-standard', '.'], { cwd: appDir, encoding: 'utf8' })
    .stdout.split('\n')
    .filter((f) => f && fs.existsSync(path.join(appDir, f)));
  const designDir = path.join(TEMPLATE, 'design');
  const provided = new Set(fs.readdirSync(designDir).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(designDir, f), 'utf8')));
  let lines = 0;
  for (const f of files) {
    if (!/\.([cm]?[jt]sx?|vue|svelte|astro|html|css|scss)$/.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)) continue;
    const text = fs.readFileSync(path.join(appDir, f), 'utf8');
    if (provided.has(text) || /automatically generated|auto-generated|@generated|do not edit/i.test(text.slice(0, 500))) continue;
    lines += text.split('\n').filter((l) => l.trim()).length;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  // Versions actually installed for the measured build (not just the ranges in package.json).
  const installed = {};
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    try {
      installed[dep] = JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', dep, 'package.json'), 'utf8')).version;
    } catch {
      installed[dep] = null;
    }
  }
  return { sourceLines: lines, installed };
}

// ----- Main -----

const results = { appDir, scenario: SCENARIO, measuredAt: new Date().toISOString(), runs: RUNS };
console.log(`Measuring ${appDir}`);
const stack = await startStack(appDir, { template: TEMPLATE, apiEnv: SETUP.apiEnv, build: !args.includes('--skip-build') });
CHROME_FLAGS.push(stack.chromeCertFlag);
// results.json is written even if something fails, with whatever was measured.
try {
  results.code = codeStats();
  console.log('Lighthouse:');
  results.lighthouse = await runLighthouse();
  if (SETUP.flow) {
    console.log('Flow:');
    results.flow = await measureFlow();
  }
} catch (err) {
  results.error = String(err?.stack ?? err);
  throw err;
} finally {
  await stack.stop();
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`Wrote ${path.join(out, 'results.json')}`);
}
