/* Personal / business use and the invoice details — run with `pnpm test`
 * (node --test). Exercises app/lib/billing.ts, which is what stands between
 * whatever the pricing page put in localStorage and the stored record.
 *
 * The module is TypeScript; Node strips the types on import. */
import test from 'node:test';
import assert from 'node:assert/strict';

const { parseBilling, describeBilling, normalizeGstin } = await import('../app/lib/billing.ts');

const GSTIN = '27ABCDE1234F1Z5';

test('nothing sent is not an answer', () => {
  assert.equal(parseBilling(undefined), null);
  assert.equal(parseBilling(null), null);
  assert.equal(parseBilling('business'), null);
});

test('personal use keeps no invoice details, whatever was sent alongside', () => {
  assert.deepEqual(
    parseBilling({ use: 'personal', company: 'Acme', gstin: GSTIN, address: '12 Main St' }),
    { v: 1, use: 'personal' },
  );
});

test('an unrecognised use is read as personal rather than trusted', () => {
  assert.deepEqual(parseBilling({ use: 'enterprise', gstin: GSTIN }), { v: 1, use: 'personal' });
});

test('business use keeps company, GSTIN and address', () => {
  assert.deepEqual(
    parseBilling({ use: 'business', company: '  Acme   Pvt Ltd ', gstin: '27abcde1234f1z5', address: '12 Main St\r\nMumbai 400001' }),
    { v: 1, use: 'business', company: 'Acme Pvt Ltd', gstin: GSTIN, address: '12 Main St\nMumbai 400001' },
  );
});

test('an address keeps its line breaks and loses its control characters', () => {
  const parsed = parseBilling({ use: 'business', address: '12 Main St\nSuite 4\n\n\n\nMumbai' });
  assert.equal(parsed.address, '12 Main St\nSuite 4\n\nMumbai');
});

test('a malformed GSTIN is dropped, and the rest of the details survive it', () => {
  const parsed = parseBilling({ use: 'business', company: 'Acme', gstin: '27ABCDE1234F1X5' });
  assert.deepEqual(parsed, { v: 1, use: 'business', company: 'Acme' });
});

test('business use with nothing filled in is still a recorded answer', () => {
  assert.deepEqual(parseBilling({ use: 'business' }), { v: 1, use: 'business' });
  assert.deepEqual(parseBilling({ use: 'business', company: '   ', address: '\n\n' }), { v: 1, use: 'business' });
});

test('fields are capped, so a long paste cannot become the record', () => {
  const parsed = parseBilling({ use: 'business', company: 'A'.repeat(300), address: 'B'.repeat(900) });
  assert.equal(parsed.company.length, 120);
  assert.equal(parsed.address.length, 400);
});

test('a GSTIN survives the spaces and dashes people type into it', () => {
  assert.equal(normalizeGstin(' 27-ABCDE 1234F1Z5 '), GSTIN);
  assert.equal(normalizeGstin('27ABCDE1234F1Z'), undefined);
  assert.equal(normalizeGstin(42), undefined);
});

test('the notification line says what the team has to invoice', () => {
  assert.equal(describeBilling(null), 'not stated');
  assert.equal(describeBilling(parseBilling({ use: 'personal' })), 'personal use');
  assert.equal(
    describeBilling(parseBilling({ use: 'business' })),
    'business use (no invoice details given)',
  );
  assert.equal(
    describeBilling(parseBilling({ use: 'business', company: 'Acme', gstin: GSTIN, address: '12 Main St\nMumbai' })),
    `business use · Acme · GSTIN ${GSTIN} · 12 Main St, Mumbai`,
  );
});
