/* Google Analytics cookie cleanup on withdrawal, and the consent transitions
 * that trigger it. Uses a small in-memory cookie jar that behaves like
 * document.cookie: a cookie is identified by name + domain + path, and an
 * expired write removes only the matching one. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../public/assets/consent.v5.js');

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

test('the saved record holds nothing about the visitor', () => {
  const m = new Map();
  const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  C.write(st, C.categories(true, false), '2026-09-06T12:00:00.000Z',
          { id: C.newId({}), action: 'saved_preferences' });
  const rec = JSON.parse(m.get(C.KEY));
  /* An EXACT key list, not a subset check. This test exists to fail loudly the
     day somebody adds a field here, because the next field somebody reaches for
     is an IP, a referrer or a user agent -- and this record is the one thing on
     the public site that is written for every visitor regardless of consent. */
  assert.deepEqual(Object.keys(rec).sort(), ['action', 'categories', 'id', 'policy', 'sent', 'ts', 'v']);
  assert.deepEqual(Object.keys(rec.categories).sort(), ['advertising', 'analytics', 'necessary']);
  assert.equal(typeof rec.ts, 'string');
  assert.equal(rec.policy, C.POLICY_VERSION);
  assert.equal(rec.v, 1);
  /* The id is a random v4 UUID and nothing derived from the visitor. */
  assert.match(rec.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('every choice gets its OWN id, so the ledger cannot become a visitor profile', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) ids.add(C.newId({}));
  assert.equal(ids.size, 500);
});

test('the body sent to the server carries the choice and nothing else', () => {
  const id = C.newId({});
  const body = C.recordBody({
    id, action: 'accept_all', policy: C.POLICY_VERSION,
    ts: '2026-09-06T12:00:00.000Z', categories: C.categories(true, true),
  });
  assert.deepEqual(Object.keys(body).sort(),
    ['advertising', 'analytics', 'bannerAction', 'chosenAt', 'id', 'policyVersion']);
  assert.equal(body.analytics, true);
  assert.equal(body.advertising, true);
  assert.equal(body.bannerAction, 'accept_all');
});

test('a choice saved by the previous script is honoured but never sent', () => {
  /* consent.v4.js wrote no id and no action. Posting one would mean inventing
     a consent record for a click nobody can date, which is worse than having
     no record at all. */
  const m = new Map();
  const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  m.set(C.KEY, JSON.stringify({
    v: 1, policy: C.POLICY_VERSION, ts: '2026-09-06T12:00:00.000Z',
    categories: { necessary: true, analytics: true, advertising: false },
  }));
  const restored = C.read(st);
  assert.deepEqual(restored.categories, { necessary: true, analytics: true, advertising: false });
  assert.equal(restored.id, null);
  assert.equal(C.recordBody(restored), null);
});

test('sendRecord does nothing when there is no id to send', () => {
  let called = false;
  const win = { fetch: () => { called = true; return Promise.resolve(); } };
  assert.equal(C.sendRecord(win, { id: null, action: null }, null), false);
  assert.equal(called, false);
});

test('sendRecord posts to the endpoint without credentials', () => {
  let url = null; let init = null;
  const win = { fetch: (u, i) => { url = u; init = i; return Promise.resolve(); } };
  const sent = C.sendRecord(win, {
    id: C.newId({}), action: 'necessary_only', policy: C.POLICY_VERSION,
    ts: '2026-09-06T12:00:00.000Z', categories: C.categories(false, false),
  }, null);
  assert.equal(sent, true);
  assert.equal(url, C.RECORD_URL);
  assert.equal(init.method, 'POST');
  /* No cookies on the request: this endpoint has nothing to authenticate and
     must not become a way of correlating the choice with anything else. */
  assert.equal(init.credentials, 'omit');
  assert.equal(init.keepalive, true);
});
