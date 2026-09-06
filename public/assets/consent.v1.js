/* GoXL Ally — cookie consent + Google Tag Manager loader (public site only).
 *
 * One file does the whole job, in this order, so nothing can run out of turn:
 *   1. Google Consent Mode defaults: every signal DENIED.
 *   2. A choice the visitor already made (localStorage `ally_consent_v1`) is
 *      read and pushed as a consent UPDATE, before any tag can act.
 *   3. Google Tag Manager is loaded, exactly once, and only on the production
 *      host (www.goxlally.ai). Previews and local dev never load it.
 *   4. The banner is shown only when there is no valid saved choice; the
 *      footer's "Cookie preferences" link reopens it at any time.
 *
 * Google Analytics is configured INSIDE the container. There is no gtag.js on
 * the site and there must not be: GTM is the only client-side tag loader.
 *
 * Nothing personal is ever pushed to the dataLayer from here: only the four
 * consent signals and GTM's own start event. The saved choice holds three
 * booleans, a timestamp and a policy version — no identifier of any kind.
 *
 * This file lives under /assets, which is cached for a year by URL. Any edit
 * means a new filename (consent.v2.js) and updating the six pages that load it.
 *
 * Loaded with `async`: it does not block rendering, and ordering is still
 * guaranteed because GTM is only ever loaded from inside this script. In Node
 * it exports its pure parts for the tests in /tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.AllyConsent = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEY = 'ally_consent_v1';
  /* Bump when the cookie wording in the Privacy Policy changes in substance.
     A saved choice made under an older version no longer counts and the
     banner asks again. */
  var POLICY_VERSION = '2026-09-06';
  var GTM_ID = 'GTM-W79JTTG5';
  var PRODUCTION_HOSTS = ['www.goxlally.ai'];
  var SIGNALS = ['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization'];

  /* ── Pure part ─────────────────────────────────────────────────────────── */

  function categories(analytics, advertising) {
    return { necessary: true, analytics: analytics === true, advertising: advertising === true };
  }

  /* Category → Google Consent Mode signals. Advertising declined keeps all
     three ad signals denied; there is no partial grant. */
  function toGoogle(cats) {
    var a = !!(cats && cats.analytics), ad = !!(cats && cats.advertising);
    return {
      analytics_storage: a ? 'granted' : 'denied',
      ad_storage: ad ? 'granted' : 'denied',
      ad_user_data: ad ? 'granted' : 'denied',
      ad_personalization: ad ? 'granted' : 'denied'
    };
  }

  function allDenied() { return toGoogle(categories(false, false)); }

  function isProductionHost(hostname) {
    return PRODUCTION_HOSTS.indexOf(String(hostname || '').toLowerCase()) !== -1;
  }

  /* Storage access is wrapped: private windows and blocked storage throw. */
  function read(storage) {
    var raw = null;
    try { raw = storage && storage.getItem(KEY); } catch (e) { return null; }
    if (!raw) return null;
    var o;
    try { o = JSON.parse(raw); } catch (e) { return null; }
    if (!o || typeof o !== 'object' || o.v !== 1) return null;
    if (o.policy !== POLICY_VERSION) return null;                /* re-ask */
    if (typeof o.ts !== 'string' || !o.ts) return null;
    var c = o.categories;
    if (!c || typeof c !== 'object') return null;
    if (typeof c.analytics !== 'boolean' || typeof c.advertising !== 'boolean') return null;
    return { v: 1, policy: o.policy, ts: o.ts, categories: categories(c.analytics, c.advertising) };
  }

  function write(storage, cats, now) {
    var record = {
      v: 1,
      policy: POLICY_VERSION,
      ts: (now ? new Date(now) : new Date()).toISOString(),
      categories: categories(cats && cats.analytics, cats && cats.advertising)
    };
    try { storage.setItem(KEY, JSON.stringify(record)); } catch (e) { /* choice still applies this visit */ }
    return record;
  }

  function clear(storage) {
    try { storage.removeItem(KEY); } catch (e) { /* nothing to do */ }
  }

  /* Consent Mode commands are pushed the way gtag does it: an `arguments`
     object, not an array. GTM reads them either way; Google's docs show this. */
  function gtagInto(dataLayer) {
    return function () { dataLayer.push(arguments); };
  }

  function pushDefault(dataLayer) {
    gtagInto(dataLayer)('consent', 'default', allDenied());
  }

  function pushUpdate(dataLayer, cats) {
    gtagInto(dataLayer)('consent', 'update', toGoogle(cats));
  }

  /* The standard container snippet, guarded so a second call is a no-op. */
  function loadGtm(doc, win, id) {
    win.__allyGtmLoaded = win.__allyGtmLoaded || false;
    if (win.__allyGtmLoaded) return false;
    if (doc.querySelector('script[src^="https://www.googletagmanager.com/gtm.js"]')) { win.__allyGtmLoaded = true; return false; }
    win.__allyGtmLoaded = true;
    win.dataLayer = win.dataLayer || [];
    win.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    var j = doc.createElement('script');
    j.async = true;
    j.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(id || GTM_ID);
    var f = doc.getElementsByTagName('script')[0];
    if (f && f.parentNode) f.parentNode.insertBefore(j, f); else (doc.head || doc.documentElement).appendChild(j);
    return true;
  }

  /* What a page load should do, given what is known. Pure, so it is testable
     without a browser: `pushes` is the exact dataLayer sequence. */
  function decide(opts) {
    var saved = read(opts.storage);
    var dataLayer = opts.dataLayer;
    pushDefault(dataLayer);
    if (saved) pushUpdate(dataLayer, saved.categories);
    return {
      saved: saved,
      loadGtm: isProductionHost(opts.hostname),
      showBanner: !saved
    };
  }

  /* ── Browser part ──────────────────────────────────────────────────────── */

  var CSS = [
    /* Above the floating help button (z 900), which sits in the same corner
     on phones; the button is back the moment the banner closes. Below the
     registration dialog is not needed: that one covers the page. */
    '.ally-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:950;max-width:480px;margin:0 auto 0 0;',
    'background:#fbf7f2;color:#16241c;border:1px solid #e7e0d6;border-radius:18px;',
    'box-shadow:0 2px 6px -2px rgba(6,20,13,.18),0 30px 60px -24px rgba(6,20,13,.35);',
    'padding:20px 22px 18px;font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;',
    'padding-bottom:max(18px,env(safe-area-inset-bottom))}',
    '.ally-consent[hidden]{display:none}',
    '.ally-consent *{box-sizing:border-box}',
    '.ally-consent__eyebrow{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#1B4332;margin:0 0 6px}',
    '.ally-consent__title{font:600 18px/1.25 Fraunces,Georgia,serif;margin:0 0 8px;color:#16241c}',
    '.ally-consent__text{margin:0 0 14px;color:#556458}',
    '.ally-consent__text a{color:#1B4332;text-decoration:underline;text-underline-offset:2px}',
    '.ally-consent__actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.ally-consent__btn{appearance:none;border:1px solid #1B4332;border-radius:999px;padding:10px 16px;font:700 13.5px/1 Inter,system-ui,sans-serif;',
    'cursor:pointer;background:#1B4332;color:#eaf3ee;transition:background .2s,border-color .2s}',
    '.ally-consent__btn:hover{background:#143726}',
    '.ally-consent__btn--quiet{background:transparent;color:#1B4332}',
    '.ally-consent__btn--quiet:hover{background:#efe6d9}',
    '.ally-consent__btn--link{border:0;background:transparent;color:#556458;padding:10px 4px;font-weight:600;text-decoration:underline;text-underline-offset:2px}',
    '.ally-consent__btn--link:hover{color:#1B4332;background:transparent}',
    '.ally-consent__btn:focus-visible{outline:2px solid #10B981;outline-offset:2px}',
    '.ally-consent__prefs[hidden]{display:none}',
    '.ally-consent__row{display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-top:1px solid #e7e0d6}',
    '.ally-consent__row:last-of-type{border-bottom:1px solid #e7e0d6;margin-bottom:14px}',
    '.ally-consent__row label{display:block;font-weight:600;color:#16241c;cursor:pointer}',
    '.ally-consent__row p{margin:2px 0 0;font-size:13px;color:#556458}',
    '.ally-consent__row small{display:inline-block;margin-left:6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#10B981}',
    '.ally-consent__row input{margin:4px 0 0;width:18px;height:18px;flex:none;accent-color:#10B981}',
    '@media (max-width:600px){.ally-consent{left:0;right:0;bottom:0;max-width:none;border-radius:18px 18px 0 0}}',
    '@media (prefers-reduced-motion:no-preference){.ally-consent{animation:allyConsentIn .35s ease-out}',
    '@keyframes allyConsentIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}}'
  ].join('');

  var HTML =
    '<p class="ally-consent__eyebrow">GoXL Ally</p>' +
    '<h2 class="ally-consent__title" id="allyConsentTitle">Cookies on this site</h2>' +
    '<p class="ally-consent__text" id="allyConsentText">Necessary cookies keep the site working. With your permission we also use analytics to see which pages founders find useful, and advertising cookies to measure our campaigns. Nothing is switched on until you choose. <a href="/privacy.html">Privacy Policy</a></p>' +
    '<div class="ally-consent__prefs" id="allyConsentPrefs" hidden>' +
      '<div class="ally-consent__row"><input type="checkbox" id="allyConsentNecessary" checked disabled><div><label for="allyConsentNecessary">Necessary<small>Always active</small></label><p>Registration status, your cookie choice and the basics that keep the site running.</p></div></div>' +
      '<div class="ally-consent__row"><input type="checkbox" id="allyConsentAnalytics"><div><label for="allyConsentAnalytics">Analytics</label><p>Helps us understand which pages are read and where founders get stuck.</p></div></div>' +
      '<div class="ally-consent__row"><input type="checkbox" id="allyConsentAdvertising"><div><label for="allyConsentAdvertising">Advertising</label><p>Lets us measure whether our campaigns reach founders like you.</p></div></div>' +
    '</div>' +
    '<div class="ally-consent__actions" id="allyConsentActions">' +
      '<button type="button" class="ally-consent__btn" data-consent="accept">Accept all</button>' +
      '<button type="button" class="ally-consent__btn ally-consent__btn--quiet" data-consent="necessary">Necessary only</button>' +
      '<button type="button" class="ally-consent__btn ally-consent__btn--link" data-consent="manage">Manage preferences</button>' +
    '</div>' +
    '<div class="ally-consent__actions" id="allyConsentPrefActions" hidden>' +
      '<button type="button" class="ally-consent__btn" data-consent="save">Save preferences</button>' +
      '<button type="button" class="ally-consent__btn ally-consent__btn--quiet" data-consent="accept">Accept all</button>' +
    '</div>';

  function boot(env) {
    var win = env.win, doc = env.doc;
    if (win.__allyConsentBooted) return null;              /* included twice? once is enough */
    win.__allyConsentBooted = true;

    var storage = null;
    try { storage = win.localStorage; } catch (e) { storage = null; }
    win.dataLayer = win.dataLayer || [];

    var plan = decide({ storage: storage, dataLayer: win.dataLayer, hostname: env.hostname || win.location.hostname });
    if (plan.loadGtm) loadGtm(doc, win, GTM_ID);

    /* ── banner ── */
    var el = null, prefs, actions, prefActions, analyticsBox, advertisingBox, lastFocus = null;

    function ensure() {
      if (el) return el;
      var style = doc.createElement('style');
      style.textContent = CSS;
      doc.head.appendChild(style);
      el = doc.createElement('section');
      el.className = 'ally-consent';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-labelledby', 'allyConsentTitle');
      el.setAttribute('aria-describedby', 'allyConsentText');
      el.hidden = true;
      el.innerHTML = HTML;
      doc.body.appendChild(el);
      prefs = el.querySelector('#allyConsentPrefs');
      actions = el.querySelector('#allyConsentActions');
      prefActions = el.querySelector('#allyConsentPrefActions');
      analyticsBox = el.querySelector('#allyConsentAnalytics');
      advertisingBox = el.querySelector('#allyConsentAdvertising');
      el.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-consent]') : null;
        if (!b) return;
        ev.preventDefault();
        var what = b.getAttribute('data-consent');
        if (what === 'accept') choose(categories(true, true));
        else if (what === 'necessary') choose(categories(false, false));
        else if (what === 'save') choose(categories(analyticsBox.checked, advertisingBox.checked));
        else if (what === 'manage') showPrefs();
      });
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && read(storage)) hide();     /* only once a choice exists */
      });
      return el;
    }

    function showPrefs() {
      ensure();
      var saved = read(storage);
      analyticsBox.checked = !!(saved && saved.categories.analytics);
      advertisingBox.checked = !!(saved && saved.categories.advertising);
      prefs.hidden = false; actions.hidden = true; prefActions.hidden = false;
      show();
      analyticsBox.focus();
    }

    function showChoice() {
      ensure();
      prefs.hidden = true; actions.hidden = false; prefActions.hidden = true;
      show();
    }

    function show() {
      if (!el.hidden) return;
      lastFocus = doc.activeElement;
      el.hidden = false;
    }

    function hide() {
      if (!el || el.hidden) return;
      el.hidden = true;
      if (lastFocus && lastFocus.focus && doc.contains(lastFocus)) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
      lastFocus = null;
    }

    function choose(cats) {
      write(storage, cats);
      pushUpdate(win.dataLayer, cats);
      hide();
    }

    function onReady(fn) {
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', fn, { once: true });
      else fn();
    }

    /* The first ask waits for the page to have loaded: the banner is not the
       first thing painted, and never the largest. Bounded at 2.5s. */
    function afterLoad(fn) {
      var done = false;
      function go() { if (done) return; done = true; fn(); }
      if (doc.readyState === 'complete') { go(); return; }
      win.addEventListener('load', go, { once: true });
      win.setTimeout(go, 2500);
    }

    onReady(function () {
      /* Footer "Cookie preferences" links, on every page. */
      doc.addEventListener('click', function (ev) {
        var a = ev.target && ev.target.closest ? ev.target.closest('[data-consent-open]') : null;
        if (!a) return;
        ev.preventDefault();
        showPrefs();
      });
      var hashed = win.location.hash === '#cookie-preferences';
      if (hashed) { showPrefs(); return; }
      if (plan.showBanner) afterLoad(showChoice);
    });
    win.addEventListener('hashchange', function () {
      if (win.location.hash === '#cookie-preferences') showPrefs();
    });

    return { open: showPrefs, get: function () { return read(storage); } };
  }

  var api = {
    KEY: KEY, POLICY_VERSION: POLICY_VERSION, GTM_ID: GTM_ID, SIGNALS: SIGNALS,
    categories: categories, toGoogle: toGoogle, allDenied: allDenied, isProductionHost: isProductionHost,
    read: read, write: write, clear: clear, pushDefault: pushDefault, pushUpdate: pushUpdate,
    loadGtm: loadGtm, decide: decide, boot: boot
  };

  if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__allyConsentNoBoot) {
    api.instance = boot({ win: window, doc: document });
  }
  return api;
}));
