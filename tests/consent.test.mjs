/* Consent + Google Tag Manager foundation — run with `pnpm test` (node --test).
 * Exercises the pure part of public/assets/consent.v3.js with a fake storage,
 * a fake dataLayer and a fake document; no browser needed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../public/assets/consent.v3.js');

const DENIED = { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' };
const GRANTED = { analytics_storage: 'granted', ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' };

function memStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), dump: () => Object.fromEntries(m) };
}
/* dataLayer entries pushed by gtag() are `arguments` objects; read them as arrays. */
const cmds = (dl) => dl.filter((e) => typeof e.length === 'number').map((e) => Array.from(e));

function fakeDoc() {
  const scripts = [];
  const head = { appendChild: (n) => scripts.push(n) };
  const first = { parentNode: { insertBefore: (n) => scripts.push(n) } };
  return {
    scripts,
    head,
    createElement: () => ({}),
    getElementsByTagName: () => [first],
    querySelector: (sel) => (sel.startsWith('script[src^=') ? scripts.find((s) => String(s.src).startsWith('https://www.googletagmanager.com/gtm.js')) || null : null),
  };
}

test('default consent: every Google signal denied, pushed before anything else', () => {
  const dl = [];
  const plan = C.decide({ storage: memStorage(), dataLayer: dl, hostname: 'www.goxlally.ai' });
  const c = cmds(dl);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0], ['consent', 'default', DENIED]);
  assert.equal(plan.showBanner, true);
  assert.equal(plan.loadGtm, true);
});

test('GTM loads only on the production host', () => {
  for (const h of ['localhost', '127.0.0.1', 'goxlally.ai', 'landing-page-abc.vercel.app', 'app.goxlally.ai', '']) {
    assert.equal(C.isProductionHost(h), false, h);
  }
  assert.equal(C.isProductionHost('www.goxlally.ai'), true);
  assert.equal(C.isProductionHost('WWW.GOXLALLY.AI'), true);
});

test('GTM container is inserted exactly once, with the right id, after gtm.start', () => {
  const doc = fakeDoc();
  const win = { dataLayer: [] };
  assert.equal(C.loadGtm(doc, win), true);
  assert.equal(C.loadGtm(doc, win), false);
  assert.equal(C.loadGtm(doc, win, 'GTM-OTHER'), false);
  assert.equal(doc.scripts.length, 1);
  assert.equal(doc.scripts[0].src, 'https://www.googletagmanager.com/gtm.js?id=GTM-W79JTTG5');
  assert.equal(doc.scripts[0].async, true);
  assert.equal(win.dataLayer.filter((e) => e.event === 'gtm.js').length, 1);
  /* a container already in the page (say, from a second include) is respected */
  const doc2 = fakeDoc(); doc2.scripts.push({ src: 'https://www.googletagmanager.com/gtm.js?id=GTM-W79JTTG5' });
  assert.equal(C.loadGtm(doc2, { dataLayer: [] }), false);
  assert.equal(doc2.scripts.length, 1);
});

test('no gtag.js is ever requested — only the container', () => {
  const doc = fakeDoc();
  C.loadGtm(doc, { dataLayer: [] });
  assert.ok(doc.scripts.every((s) => !/gtag\/js/.test(s.src)));
});

test('Accept all: analytics + all three advertising signals granted; stored with ts and policy', () => {
  const st = memStorage(), dl = [];
  const cats = C.categories(true, true);
  const rec = C.write(st, cats, '2026-09-06T10:00:00.000Z');
  C.pushUpdate(dl, cats);
  assert.deepEqual(cmds(dl)[0], ['consent', 'update', GRANTED]);
  const stored = JSON.parse(st.dump()[C.KEY]);
  assert.deepEqual(stored, { v: 1, policy: C.POLICY_VERSION, ts: '2026-09-06T10:00:00.000Z', categories: { necessary: true, analytics: true, advertising: true } });
  assert.deepEqual(rec, stored);
  /* nothing but booleans, a timestamp and a version — no identifier */
  assert.deepEqual(Object.keys(stored).sort(), ['categories', 'policy', 'ts', 'v']);
});

test('Necessary only: everything stays denied, and the choice is remembered', () => {
  const st = memStorage(), dl = [];
  const cats = C.categories(false, false);
  C.write(st, cats); C.pushUpdate(dl, cats);
  assert.deepEqual(cmds(dl)[0], ['consent', 'update', DENIED]);
  assert.deepEqual(C.read(st).categories, { necessary: true, analytics: false, advertising: false });
});

test('Analytics only: analytics granted, advertising signals all denied', () => {
  const dl = [];
  C.pushUpdate(dl, C.categories(true, false));
  assert.deepEqual(cmds(dl)[0], ['consent', 'update', { ...DENIED, analytics_storage: 'granted' }]);
});

test('Advertising declined never grants a partial ad signal', () => {
  for (const a of [true, false]) {
    const g = C.toGoogle(C.categories(a, false));
    assert.equal(g.ad_storage, 'denied'); assert.equal(g.ad_user_data, 'denied'); assert.equal(g.ad_personalization, 'denied');
  }
});

test('Withdrawal: after Accept all, saving Necessary only pushes denied and overwrites the record', () => {
  const st = memStorage(), dl = [];
  C.write(st, C.categories(true, true)); C.pushUpdate(dl, C.categories(true, true));
  C.write(st, C.categories(false, false)); C.pushUpdate(dl, C.categories(false, false));
  const c = cmds(dl);
  assert.deepEqual(c[1], ['consent', 'update', DENIED]);
  assert.deepEqual(C.read(st).categories, { necessary: true, analytics: false, advertising: false });
  C.clear(st);
  assert.equal(C.read(st), null);
});

test('Restoration: a saved choice is applied on the next load and the banner stays away', () => {
  const st = memStorage();
  C.write(st, C.categories(true, false));
  const dl = [];
  const plan = C.decide({ storage: st, dataLayer: dl, hostname: 'www.goxlally.ai' });
  const c = cmds(dl);
  assert.deepEqual(c[0], ['consent', 'default', DENIED]);
  assert.deepEqual(c[1], ['consent', 'update', { ...DENIED, analytics_storage: 'granted' }]);
  assert.equal(plan.showBanner, false);
  assert.deepEqual(plan.saved.categories, { necessary: true, analytics: true, advertising: false });
});

test('A choice made under an older policy version, or a damaged record, asks again', () => {
  const stale = memStorage({ [C.KEY]: JSON.stringify({ v: 1, policy: '2000-01-01', ts: '2026-01-01T00:00:00.000Z', categories: { necessary: true, analytics: true, advertising: true } }) });
  assert.equal(C.read(stale), null);
  for (const raw of ['', 'null', '{}', '[]', 'not json', JSON.stringify({ v: 1, policy: C.POLICY_VERSION, ts: 'x', categories: { analytics: 'yes', advertising: false } })]) {
    assert.equal(C.read(memStorage({ [C.KEY]: raw })), null, raw);
  }
  const dl = [];
  const plan = C.decide({ storage: stale, dataLayer: dl, hostname: 'www.goxlally.ai' });
  assert.equal(cmds(dl).length, 1);           /* default only, no update from the stale record */
  assert.equal(plan.showBanner, true);
});

test('Blocked storage: defaults still apply, the banner shows, nothing throws', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const dl = [];
  const plan = C.decide({ storage: broken, dataLayer: dl, hostname: 'www.goxlally.ai' });
  assert.deepEqual(cmds(dl)[0], ['consent', 'default', DENIED]);
  assert.equal(plan.showBanner, true);
  assert.doesNotThrow(() => C.write(broken, C.categories(true, true)));
});
