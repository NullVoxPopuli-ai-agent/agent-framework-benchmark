import { expect } from '@playwright/test';
import http from 'node:http';

// ---------- The API, for expected values ----------

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:9100';

export async function api(path) {
  const res = await fetch(API_BASE_URL + path);
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

// ---------- Formatting, per the spec's conventions ----------

export const num = (n) => n.toLocaleString('en-US');
export const dex = (id) => `#${String(id).padStart(4, '0')}`;
export const yesNo = (b) => (b ? 'Yes' : 'No');
export const orDash = (x) => (x === null || x === undefined || x === '' ? '—' : String(x));
export const percent = (p) => `${p.toFixed(1)}%`;
// A percentage the app computes itself; either common way of rounding is accepted.
export const ratioPercents = (part, whole) => [...new Set([((part / whole) * 100).toFixed(1), (Math.round((part / whole) * 1000) / 10).toFixed(1)])].map((p) => `${p}%`);

// ---------- Page structure ----------

export const main = (page) => page.getByRole('main');

// A section: an element with the region role, named by its heading.
export const section = (page, name) => main(page).getByRole('region', { name, exact: true });

// ---------- Text, wherever the app puts it ----------
//
// Every text check goes through flatText, so it doesn't matter whether an app uses shadow
// DOM. innerText (and Playwright's innerText and allInnerTexts) leave out text inside shadow
// roots, and Playwright's toHaveText reads slotted content out of order. flatText reads the
// page as it's rendered: into shadow roots, and through slots to what's assigned to them.
// Where there's no shadow DOM it's innerText, so plain-DOM apps see no difference.
// Runs in the page: takes one element or an array of them, returns whitespace-collapsed text.
const flatText = (target) => {
  const display = (el) => getComputedStyle(el).display;
  const inline = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'contents']);
  const hasShadow = (el) => !!el.shadowRoot || el.localName === 'slot' || [...el.querySelectorAll('*')].some((e) => e.shadowRoot || e.localName === 'slot');
  const text = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE || ['script', 'style', 'template'].includes(node.localName)) return '';
    const d = display(node);
    if (d === 'none') return '';
    let inner;
    if (!hasShadow(node)) inner = node.innerText ?? node.textContent; // SVG elements have no innerText
    else {
      const assigned = node.localName === 'slot' ? node.assignedNodes({ flatten: true }) : [];
      const kids = node.shadowRoot ? node.shadowRoot.childNodes : assigned.length ? assigned : node.childNodes;
      inner = [...kids].map(text).join('');
    }
    return inline.has(d) ? inner : ` ${inner} `;
  };
  const one = (el) => text(el).replace(/\s+/g, ' ').trim();
  return Array.isArray(target) ? target.map(one) : one(target);
};

// The text of the one element the locator finds (waits for it).
export async function textOf(locator) {
  return locator.evaluate(flatText);
}

// The texts of every element the locator finds (doesn't wait).
export async function textsOf(locator) {
  return locator.evaluateAll(flatText);
}

// Like toHaveText: a string must match the whole text, a regex must match it, and an array
// gives the texts of every element the locator finds, in order.
export async function expectText(locator, expected) {
  if (Array.isArray(expected)) await expect.poll(() => textsOf(locator)).toEqual(expected);
  else if (expected instanceof RegExp) await expect.poll(() => textOf(locator)).toMatch(expected);
  else await expect.poll(() => textOf(locator)).toBe(expected);
}

// Like toContainText.
export async function expectContainsText(locator, text) {
  await expect.poll(() => textOf(locator)).toContain(text);
}

// Matches text made of these parts in order, with only spaces or punctuation between them
// ("2026-10-15 Traded …", "2026-10-15 · Traded …", "Slowking (Trade)").
export const parts = (...texts) => new RegExp(`^${texts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]*')}[^\\p{L}\\p{N}]*$`, 'u');

// Exact text somewhere in the scope, as a whole phrase.
export const phrase = (scope, text) => scope.getByText(new RegExp(`(^|\\s)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`));

// Path (and query) of a link's href, whether it's written relative or absolute.
export async function hrefOf(link) {
  const url = new URL(await link.getAttribute('href'), 'http://localhost');
  return url.pathname + url.search;
}

export async function expectHref(link, href) {
  await expect.poll(() => hrefOf(link)).toBe(href);
}

// ---------- Tables ----------

export const table = (scope, name) => scope.getByRole('table', { name, exact: true });


export async function headers(tbl) {
  return textsOf(tbl.getByRole('columnheader'));
}

// Cell texts of every data row (rows without column headers).
export async function rows(tbl) {
  const all = await tbl.getByRole('row').all();
  const out = [];
  for (const row of all) {
    if (await row.getByRole('columnheader').count()) continue;
    out.push(await textsOf(row.getByRole('cell').or(row.getByRole('rowheader'))));
  }
  return out;
}

export async function expectHeaders(tbl, expected) {
  await expect(tbl).toBeVisible();
  await expect.poll(() => headers(tbl)).toEqual(expected);
}

export async function expectRows(tbl, expected) {
  await expect.poll(() => rows(tbl), { timeout: 10_000 }).toEqual(expected);
}

// The row of a data table whose cells include all of `texts`.
export const rowWith = (tbl, ...texts) => texts.reduce((loc, t) => loc.filter({ has: tbl.page().getByRole('cell', { name: t, exact: true }) }), tbl.getByRole('row'));

// ---------- Description lists ----------

// [term, definition] pairs in document order.
export async function definitions(scope) {
  const terms = await textsOf(scope.getByRole('term'));
  const defs = await textsOf(scope.getByRole('definition'));
  return terms.map((t, i) => [t, defs[i]]);
}

export async function expectDefinitions(scope, expected) {
  await expect
    .poll(async () => {
      const found = await definitions(scope);
      const wanted = new Set(expected.map(([t]) => t));
      return found.filter(([t]) => wanted.has(t));
    })
    .toEqual(expected);
}

// ---------- Controls ----------

export async function optionTexts(select) {
  return textsOf(select.locator('option'));
}

// Retries, so options filled in after the page loads (fetched in the browser) are found.
export async function expectOptions(select, expected) {
  await expect.poll(() => optionTexts(select)).toEqual(expected);
}

// Waits until the URL's query has exactly these parameters (order doesn't matter).
export async function expectQuery(page, params) {
  await expect
    .poll(() => Object.fromEntries([...new URL(page.url()).searchParams].sort()))
    .toEqual(Object.fromEntries(Object.entries(params).sort()));
}

// ---------- Charts ----------

// Checks a chart against its data: an svg with role img named `title`, one rect with a
// <title> per item, in order, with lengths proportional to the values; and the data table.
// items: [{ label, value (formatted), n (number) }]
export async function expectChart(scope, title, items, { horizontal }) {
  const svg = scope.getByRole('img', { name: title, exact: true });
  await expect(svg).toBeVisible();
  const bars = await svg.evaluate((el) =>
    [...el.querySelectorAll('rect')]
      .map((r) => ({ r, t: [...r.children].find((c) => c.tagName.toLowerCase() === 'title') }))
      .filter(({ t }) => t)
      .map(({ r, t }) => {
        const b = r.getBoundingClientRect();
        return { title: t.textContent.replace(/\s+/g, ' ').trim(), x: b.x, y: b.y, w: b.width, h: b.height };
      }),
  );
  expect(bars.map((b) => b.title), `${title}: one rect per item, each with a <title>`).toEqual(items.map((i) => `${i.label}: ${i.value}`));
  const byPosition = [...bars].sort((a, b) => (horizontal ? a.y - b.y : a.x - b.x));
  expect(byPosition.map((b) => b.title), `${title}: ${horizontal ? 'top to bottom' : 'left to right'} in order`).toEqual(bars.map((b) => b.title));
  const lengths = bars.map((b) => (horizontal ? b.w : b.h));
  const max = Math.max(...items.map((i) => i.n));
  const full = Math.max(...lengths);
  if (max > 0) expect(full, `${title}: the largest bar has a length`).toBeGreaterThan(10);
  items.forEach((item, i) => {
    const expected = max ? (item.n / max) * full : 0;
    expect(Math.abs(lengths[i] - expected), `${title}: ${item.label} is ${lengths[i].toFixed(1)}px long, expected ${expected.toFixed(1)}px`).toBeLessThanOrEqual(Math.max(1.5, full * 0.01));
  });
  const data = scope.getByRole('table', { name: `${title} data`, exact: true });
  await expect(data).toHaveCount(1);
  return data;
}

// ---------- Navigation ----------

// Runs `action` (a click) and checks it counts as a navigation in Chrome: either a new
// document loads, or Chrome reports a soft navigation.
export async function expectNavigation(page, action, url) {
  await page.evaluate(() => {
    window.__sameDocument = true;
    window.__softNavigations = [];
    new PerformanceObserver((list) => window.__softNavigations.push(...list.getEntries().map((e) => e.name))).observe({ type: 'soft-navigation' });
  });
  await action();
  await expect(page).toHaveURL(url);
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(() => (window.__sameDocument ? (window.__softNavigations.length ? 'soft navigation' : 'none yet') : 'new document'));
        } catch {
          return 'none yet'; // the document was being replaced
        }
      },
      { message: 'The click should load a new document or be detected by Chrome as a soft navigation (see SPEC.md, "Navigation")', timeout: 5000 },
    )
    .not.toBe('none yet');
}

// ---------- Raw HTTP ----------

// GET with a chosen Host header (fetch doesn't allow setting it).
export function getWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}
