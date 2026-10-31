// Measures a short user session in an app with Chrome's own metrics, through web-vitals
// with soft navigations on:
//
//   1. A cold load of the first URL (fresh profile, empty cache).
//   2. A few clicks on links, in the same tab. Each click is either a full page load or a
//      soft navigation, and either way Chrome reports its LCP:
//      - soft navigation: LCP from the interaction (web-vitals' soft-navigation LCP)
//      - new document: LCP from the new document's time origin, plus the time from the
//        click to that origin (which is small: the click handler and unloading the page)
//
// Throttling and emulation are Lighthouse's mobile defaults, applied the way Lighthouse's
// "devtools" throttling applies them (Chrome DevTools Protocol), so these numbers are
// comparable with Lighthouse runs using throttlingMethod: 'devtools'.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import * as lh from 'lighthouse/core/config/constants.js';

// web-vitals' browser build, with attribution so each LCP names its element (its package
// exports don't include it, so it's found by path).
const require = createRequire(import.meta.url);
const WEB_VITALS_DIR = path.join(path.dirname(require.resolve('web-vitals')), '..');
const WEB_VITALS = fs.readFileSync(path.join(WEB_VITALS_DIR, 'dist/web-vitals.attribution.iife.js'), 'utf8');
export const WEB_VITALS_VERSION = JSON.parse(fs.readFileSync(path.join(WEB_VITALS_DIR, 'package.json'), 'utf8')).version;

export const THROTTLING = lh.throttling.mobileSlow4G;
const SCREEN = lh.screenEmulationMetrics.mobile;

// Runs in every document before the app's own scripts.
const INIT = `${WEB_VITALS}
;(() => {
  const send = (m) => window.__vital?.(JSON.stringify({
    name: m.name, value: m.value, navigationType: m.navigationType, url: m.navigationURL ?? location.href,
    timeOrigin: performance.timeOrigin, target: m.attribution?.target ?? null,
  }));
  const options = { reportAllChanges: true, reportSoftNavs: true };
  for (const on of [webVitals.onLCP, webVitals.onFCP, webVitals.onCLS, webVitals.onINP]) on(send, options);
  addEventListener('pointerdown', (e) => window.__pointerdown?.(performance.timeOrigin + e.timeStamp), { capture: true });
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One session. steps: [{ name, goto } | { name, click: (page) => Locator, url: RegExp }].
// Returns one result per step: { name, type: 'load' | 'soft' | 'hard' | 'none', lcp, lcpTarget, fcp, cls, ... }.
// A step that fails (say, a link the app doesn't show at this viewport) is recorded as
// { name, type: 'error', error } and ends the session, since later steps start from it.
export async function runFlow({ origin, steps, chromeArgs = [], settleMs = 1500, timeoutMs = 30_000 }) {
  const browser = await chromium.launch({ channel: 'chromium', args: chromeArgs });
  try {
    const context = await browser.newContext({
      viewport: { width: SCREEN.width, height: SCREEN.height },
      deviceScaleFactor: SCREEN.deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
      userAgent: lh.userAgents.mobile,
    });
    const vitals = [];
    let lastPointerdown = null;
    await context.exposeBinding('__vital', (_, json) => vitals.push({ ...JSON.parse(json), at: Date.now() }));
    await context.exposeBinding('__pointerdown', (_, epochMs) => (lastPointerdown = epochMs));
    await context.addInitScript(INIT);
    const page = await context.newPage();

    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: THROTTLING.requestLatencyMs,
      downloadThroughput: (THROTTLING.downloadThroughputKbps * 1024) / 8,
      uploadThroughput: (THROTTLING.uploadThroughputKbps * 1024) / 8,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLING.cpuSlowdownMultiplier });

    // Network activity, for waiting until a step settles.
    const inflight = new Set();
    let lastActivity = Date.now();
    cdp.on('Network.requestWillBeSent', (e) => {
      inflight.add(e.requestId);
      lastActivity = Date.now();
    });
    const done = (e) => {
      inflight.delete(e.requestId);
      lastActivity = Date.now();
    };
    cdp.on('Network.loadingFinished', done);
    cdp.on('Network.loadingFailed', done);

    // A step has settled when the network has been idle for settleMs.
    const settle = async (started) => {
      while (Date.now() - started < timeoutMs) {
        await sleep(100);
        if (inflight.size === 0 && Date.now() - lastActivity >= settleMs) return;
      }
    };
    const documentOrigin = () => page.evaluate(() => performance.timeOrigin).catch(() => null);

    const results = [];
    for (const step of steps) {
      const startedAt = Date.now();
      const fromVital = vitals.length;
      const originBefore = step.goto ? null : await documentOrigin();
      lastPointerdown = null;
      try {
        if (step.goto) await page.goto(origin + step.goto, { waitUntil: 'load', timeout: timeoutMs });
        else {
          await step.click(page).click({ timeout: timeoutMs });
          await page.waitForURL(step.url, { timeout: timeoutMs });
        }
      } catch (err) {
        results.push({ name: step.name, type: 'error', error: err.message.split('\n')[0] });
        break;
      }
      await settle(startedAt);
      const originAfter = await documentOrigin();
      const mine = vitals.slice(fromVital);
      const lastOf = (name, filter) => mine.filter((v) => v.name === name && filter(v)).at(-1);
      const last = (name, filter) => lastOf(name, filter)?.value ?? null;

      const result = { name: step.name, url: page.url() };
      if (step.goto || originAfter !== originBefore) {
        // A new document: its own LCP, from its time origin.
        const own = (v) => v.timeOrigin === originAfter && v.navigationType !== 'soft-navigation';
        const gap = step.goto || lastPointerdown === null ? 0 : originAfter - lastPointerdown;
        Object.assign(result, {
          type: step.goto ? 'load' : 'hard',
          clickToOrigin: step.goto ? null : gap,
          lcp: last('LCP', own) === null ? null : last('LCP', own) + gap,
          lcpTarget: lastOf('LCP', own)?.target ?? null,
          fcp: last('FCP', own) === null ? null : last('FCP', own) + gap,
          cls: last('CLS', own),
        });
      } else {
        const soft = (v) => v.navigationType === 'soft-navigation' && step.url.test(v.url);
        const detected = mine.some(soft);
        Object.assign(result, {
          type: detected ? 'soft' : 'none',
          lcp: last('LCP', soft),
          lcpTarget: lastOf('LCP', soft)?.target ?? null,
          fcp: last('FCP', soft),
          cls: last('CLS', soft),
        });
      }
      result.durationMs = Date.now() - startedAt;
      results.push(result);
    }
    return results;
  } finally {
    await browser.close();
  }
}
