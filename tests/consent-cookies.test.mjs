/* Google Analytics cookie cleanup on withdrawal, and the consent transitions
 * that trigger it. Uses a small in-memory cookie jar that behaves like
 * document.cookie: a cookie is identified by name + domain + path, and an
 * expired write removes only the matching one. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../public/assets/consent.v3.js');

/* A document.cookie stand-in. `seed` is [{name, value, domain, path}]. */
function jar(seed) {
  const store = new Map();
  const key = (n, d, p) => `${n}|${d || ''}|${p || '/'}`;
  for (const c of seed) store.set(key(c.name, c.domain, c.path), c);
  return {
    get cookie() { return [...store.values()].map((c) => `${c.name}=${c.value}`).join('; '); },
    set cookie(str) {
      const [pair, ...attrs] = str.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq), value = pair.slice(eq + 1);
      const a = Object.fromEntries(attrs.map((x) => { const i = x.indexOf('='); return i < 0 ? [x.toLowerCase(), true] : [x.slice(0, i).toLowerCase(), x.slice(i + 1)]; }));
      const domain = a.domain ? a.domain.replace(/^\./, '') : '';
      const path = a.path || '/';
      const expired = a['max-age'] === '0' || (a.expires && new Date(a.expires) < new Date());
      if (expired) store.delete(key(name, domain, path));
      else store.set(key(name, domain, path), { name, value, domain, path });
    },
    names() { return [...store.values()].map((c) => c.name); },
  };
}

const GA = [
  { name: '_ga', value: 'GA1.1.1.1', domain: 'goxlally.ai', path: '/' },
  { name: '_ga_MTE6ZR0ZKT', value: 'GS1.1.1', domain: 'goxlally.ai', path: '/' },
];
const KEEP = [
  { name: 'ally_hint', value: 'in', domain: 'goxlally.ai', path: '/' },          /* platform presence hint */
  { name: 'sb-access-token', value: 'x', domain: '', path: '/' },                /* an auth cookie, host-only */
  { name: '_gcl_au', value: '1', domain: 'goxlally.ai', path: '/' },             /* not GA4's; not ours to remove here */
  { name: 'x_ga', value: '1', domain: '', path: '/' },                            /* looks similar, is not _ga */
  { name: '_gat', value: '1', domain: 'goxlally.ai', path: '/' },
];

test('only _ga and _ga_<id> are recognised as GA cookies', () => {
  assert.deepEqual(C.gaCookieNames('_ga=1; _ga_MTE6ZR0ZKT=2; ally_hint=in; _gat=1; x_ga=2; _gaz=3; _ga_=4'), ['_ga', '_ga_MTE6ZR0ZKT']);
  assert.deepEqual(C.gaCookieNames(''), []);
  assert.deepEqual(C.gaCookieNames(undefined), []);
});

test('domain candidates cover host-only, the host and every parent down to two labels', () => {
  assert.deepEqual(C.cookieDomainCandidates('www.goxlally.ai'), ['', 'www.goxlally.ai', '.www.goxlally.ai', 'goxlally.ai', '.goxlally.ai']);
  assert.deepEqual(C.cookieDomainCandidates('localhost'), ['']);
  assert.deepEqual(C.cookieDomainCandidates('127.0.0.1'), ['']);
});

test('withdrawal removes GA cookies set on the parent domain, and nothing else', () => {
  const doc = jar([...GA, ...KEEP]);
  const gone = C.deleteGaCookies(doc, 'www.goxlally.ai', '/');
  assert.deepEqual(gone.sort(), ['_ga', '_ga_MTE6ZR0ZKT']);
  assert.deepEqual(doc.names().sort(), KEEP.map((c) => c.name).sort());
});

test('GA cookies set host-only or on a sub-path are removed too', () => {
  const doc = jar([
    { name: '_ga', value: '1', domain: '', path: '/' },
    { name: '_ga_MTE6ZR0ZKT', value: '2', domain: 'www.goxlally.ai', path: '/pricing.html' },
    ...KEEP,
  ]);
  const gone = C.deleteGaCookies(doc, 'www.goxlally.ai', '/pricing.html');
  assert.deepEqual(gone.sort(), ['_ga', '_ga_MTE6ZR0ZKT']);
  assert.deepEqual(doc.names().sort(), KEEP.map((c) => c.name).sort());
});

test('cleanup with no GA cookies present writes nothing', () => {
  let writes = 0;
  const doc = { get cookie() { return 'ally_hint=in; sb-access-token=x'; }, set cookie(v) { writes++; } };
  assert.deepEqual(C.deleteGaCookies(doc, 'www.goxlally.ai', '/'), []);
  assert.equal(writes, 0);
});

/* The transitions the banner can produce, as Consent Mode sees them. */
const DENIED = { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' };
const cmds = (dl) => dl.filter((e) => typeof e.length === 'number').map((e) => Array.from(e));
function transition(from, to) {
  const dl = [];
  C.pushUpdate(dl, C.categories(from[0], from[1]));
  C.pushUpdate(dl, C.categories(to[0], to[1]));
  return cmds(dl)[1][2];
}

test('Accept all -> Necessary only: every signal denied', () => {
  assert.deepEqual(transition([true, true], [false, false]), DENIED);
});
test('Analytics only -> Necessary only: analytics denied, ads stay denied', () => {
  assert.deepEqual(transition([true, false], [false, false]), DENIED);
});
test('Accept all -> Advertising only: analytics denied, the three ad signals stay granted', () => {
  assert.deepEqual(transition([true, true], [false, true]), { analytics_storage: 'denied', ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' });
});
test('Analytics granted -> Analytics denied', () => {
  assert.equal(transition([true, false], [false, false]).analytics_storage, 'denied');
});

test('the saved record holds only version, policy, timestamp and the three category booleans', () => {
  const m = new Map();
  const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  C.write(st, C.categories(true, false), '2026-09-06T12:00:00.000Z');
  const rec = JSON.parse(m.get(C.KEY));
  assert.deepEqual(Object.keys(rec).sort(), ['categories', 'policy', 'ts', 'v']);
  assert.deepEqual(Object.keys(rec.categories).sort(), ['advertising', 'analytics', 'necessary']);
  assert.equal(typeof rec.ts, 'string');
  assert.equal(rec.policy, C.POLICY_VERSION);
  assert.equal(rec.v, 1);
});
