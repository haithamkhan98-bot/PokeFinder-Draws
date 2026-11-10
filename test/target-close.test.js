import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { parseCloseInput, tcinFromUrl, bookmarkletUrl, bookmarkletSource } from '../src/target-close.js';

const now = DateTime.fromISO('2026-11-09T14:00', { zone: 'America/New_York' });

test('parseCloseInput takes ISO and epoch milliseconds', () => {
  const iso = parseCloseInput('2026-11-12T23:59:00.000Z', { now });
  assert.ok(iso.ok);
  assert.equal(iso.closesAt.toISO(), '2026-11-12T23:59:00.000Z');
  const ms = parseCloseInput(String(now.plus({ days: 2 }).toMillis()), { now });
  assert.ok(ms.ok);
});

test('parseCloseInput refuses times that cannot be right', () => {
  // A past time would schedule a closing reminder that never fires.
  assert.equal(parseCloseInput(now.minus({ hours: 1 }).toISO(), { now }).ok, false);
  // Months out is a parsing accident, not a draw.
  assert.equal(parseCloseInput(now.plus({ days: 90 }).toISO(), { now }).ok, false);
  assert.equal(parseCloseInput('next tuesday-ish', { now }).ok, false);
  assert.equal(parseCloseInput('', { now }).ok, false);
  assert.equal(parseCloseInput(null, { now }).ok, false);
});

test('tcinFromUrl handles both Target URL shapes', () => {
  assert.equal(tcinFromUrl('https://www.target.com/p/PokeFinder/A-1011407490'), '1011407490');
  assert.equal(tcinFromUrl('https://www.target.com/p/some-slug/-/A-1011407490?x=1'), '1011407490');
  assert.equal(tcinFromUrl('https://www.target.com/'), null);
});

test('the bookmarklet carries the endpoint and key, and asks before sending', () => {
  const src = bookmarkletSource('https://example.up.railway.app/', 'k3y');
  assert.match(src, /https:\/\/example\.up\.railway\.app\/target\/close/);
  assert.match(src, /key=k3y/);
  // It must confirm rather than fire silently: nobody has seen the signed in
  // markup, so a wrong guess sent quietly would schedule a reminder on fiction.
  assert.match(src, /prompt\(/);
  assert.match(bookmarkletUrl('https://example.up.railway.app', 'k3y'), /^javascript:/);
});

test('the bookmarklet url survives being put in an href attribute', () => {
  // The page escapes it with a helper that handles < > &, and the url is
  // percent encoded, so there must be no raw quote to break out of the
  // attribute. A broken attribute here produces a bookmark that looks fine
  // and silently does nothing.
  const href = bookmarkletUrl('https://example.up.railway.app', 'k3y');
  assert.equal(href.includes('"'), false);
  assert.equal(href.includes("'"), false);
  assert.equal(href.includes(' '), false);
});
