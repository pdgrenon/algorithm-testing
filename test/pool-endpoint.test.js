/**
 * The /api/pool edge Function.
 *
 * Mostly one test: a Google Sheet that is not shared returns **200 with an
 * HTML sign-in page**, not 401. A CSV parser reads that as one nonsense row,
 * so without a check it reaches the app as "the sheet is empty" -- a sentence
 * somebody believes. Everything else here is the ordinary failure ladder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet } from '../deadpool/functions/api/pool.js';

const SHEET = `Team Name,Elimination Status,Week 1 Pick,Week 2 Pick
Gridiron Gang,Alive,KC,Bills
Ship of Theseus,Out - Week 2,Chiefs,SF
Nacho Average Team,Alive,Baltimore Ravens,DET
`;

/** Run the handler with `fetch` stubbed. Never touches the network. */
async function call(env, reply) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    call.lastUrl = url;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  try {
    const res = await onRequestGet({ env });
    return { status: res.status, body: JSON.parse(await res.text()) };
  } finally {
    globalThis.fetch = real;
  }
}

const csv = (text, status = 200) => new Response(text, { status });

test('an unset sheet URL is reported, not treated as an error', () => {
  // The app asks whether this is configured before drawing anything. A
  // control whose label promises what the deployment cannot deliver is worse
  // than no control.
  return call({}, csv(SHEET)).then(({ status, body }) => {
    assert.equal(status, 200);
    assert.equal(body.configured, false);
  });
});

test('a bare spreadsheet id expands to the link-viewable export', async () => {
  await call({ POOL_SHEET_URL: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms' }, csv(SHEET));
  assert.match(call.lastUrl, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/1Bxi[\w-]+\/export\?format=csv$/);
});

test('a full URL is taken exactly as given', async () => {
  // The sharing mode is an assumption. Whatever it turns out to be --
  // published-to-web, a different host, not a Google Sheet at all -- the URL
  // changes and this file does not.
  const url = 'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv';
  await call({ POOL_SHEET_URL: url }, csv(SHEET));
  assert.equal(call.lastUrl, url);
});

test('a sign-in page is refused rather than parsed as an empty pool', async () => {
  const login = csv('<!DOCTYPE html><html><head><title>Sign in</title></head><body>...</body></html>');
  const { status, body } = await call({ POOL_SHEET_URL: 'https://example.test/s.csv' }, login);
  assert.equal(status, 502);
  assert.equal(body.error, 'not-csv');
  assert.match(body.detail, /not readable without signing in/);
});

test('and it is the status code that lies, not the body', async () => {
  // Worth stating separately: the sign-in page arrives as 200. Anything
  // keying off res.ok alone would sail straight past it.
  const login = new Response('<html><body>Sign in</body></html>', { status: 200 });
  const { body } = await call({ POOL_SHEET_URL: 'https://example.test/s.csv' }, login);
  assert.equal(body.ok, false);
});

test('a real upstream error is reported as one', async () => {
  const { status, body } = await call(
    { POOL_SHEET_URL: 'https://example.test/s.csv' }, csv('nope', 500),
  );
  assert.equal(status, 502);
  assert.equal(body.error, 'upstream');
  assert.equal(body.status, 500);
});

test('an unreachable sheet does not throw out of the handler', async () => {
  const { status, body } = await call(
    { POOL_SHEET_URL: 'https://example.test/s.csv' }, new Error('boom'),
  );
  assert.equal(status, 502);
  assert.equal(body.error, 'unreachable');
});

test('a good sheet comes back parsed, with the field it describes', async () => {
  const { status, body } = await call({ POOL_SHEET_URL: 'https://example.test/s.csv' }, csv(SHEET));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.entries, 3);
  assert.equal(body.alive, 2, 'one is out');
  assert.deepEqual(body.weeks, [1, 2]);
  assert.equal(body.latestWeek, 2);
  // Observed popularity -- the number the prior is meant to predict.
  assert.equal(body.popularity[1].KC, 2 / 3);
  // And the exact inventories, for the surviving entries only.
  assert.deepEqual(Object.keys(body.inventories).sort(), ['Gridiron Gang', 'Nacho Average Team']);
  assert.deepEqual(body.inventories['Gridiron Gang'].sort(), ['BUF', 'KC']);
});

test('parse problems travel with the answer instead of failing it', async () => {
  const broken = SHEET.replace('Baltimore Ravens', 'Sharks');
  const { body } = await call({ POOL_SHEET_URL: 'https://example.test/s.csv' }, csv(broken));
  assert.equal(body.ok, true);
  assert.equal(body.entries, 3, 'one typo must not lose the other rows');
  assert.ok(body.problems.some((p) => p.includes('Sharks')));
});
