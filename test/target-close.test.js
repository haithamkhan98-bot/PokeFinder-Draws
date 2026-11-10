import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { parseCloseInput, parseCloseText, tcinFromUrl, bookmarkletUrl, bookmarkletSource } from '../src/target-close.js';

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
  // A double quote would end the attribute early; a space would end it too.
  assert.equal(href.includes('"'), false);
  assert.equal(href.includes(' '), false);
  // Apostrophes DO survive encodeURIComponent and are expected here, since the
  // script is full of string literals. They are harmless inside a double
  // quoted attribute, which is what the page uses.
  assert.ok(href.includes("'"));
});

test("Target's own wording parses, in Target's timezone", () => {
  const et = (s) => {
    const d = parseCloseText(s, { now });
    return d ? `${d.setZone('America/New_York').toFormat('ccc LLL d yyyy, h:mma')} ET` : null;
  };
  // The real line, read off a live draw page. CT, not the reader's zone:
  // Target is a Minneapolis company. Reading it as Eastern would fire the
  // closing reminder an hour late, every single time.
  assert.equal(et('Enter by 10am CT on Nov 11'), 'Wed Nov 11 2026, 11:00AM ET');
  assert.equal(et('Nov 11 at 10am CT'), 'Wed Nov 11 2026, 11:00AM ET');
  assert.equal(et('Enter by 10:30am CT on Nov 11'), 'Wed Nov 11 2026, 11:30AM ET');
  assert.equal(et('Ends 11:59pm ET on Dec 1'), 'Tue Dec 1 2026, 11:59PM ET');
  assert.equal(et('Enter by 10am PT on Nov 11'), 'Wed Nov 11 2026, 1:00PM ET');
});

test('the year is inferred forwards, since Target omits it', () => {
  // January, read in November, means next year.
  assert.equal(parseCloseText('Ends 9pm CT on Jan 3', { now }).year, 2027);
  assert.equal(parseCloseText('Enter by 10am CT on Nov 11', { now }).year, 2026);
});

test('zone abbreviations resolve through IANA names, so DST is right', () => {
  // CT is UTC-5 in October and UTC-6 in November. A fixed offset would be
  // wrong for half the year, and these draws straddle the changeover.
  const oct = parseCloseText('Enter by 10am CT on Oct 20', {
    now: DateTime.fromISO('2026-10-01T12:00', { zone: 'America/New_York' }),
  });
  assert.equal(oct.toUTC().hour, 15);
  assert.equal(parseCloseText('Enter by 10am CT on Nov 11', { now }).toUTC().hour, 16);
});

test('unparseable wording is null, not a wrong guess', () => {
  assert.equal(parseCloseText('gibberish', { now }), null);
  assert.equal(parseCloseText('Enter by soon', { now }), null);
  assert.equal(parseCloseText('', { now }), null);
});

test("parseCloseInput accepts Target's wording as well as ISO and epoch", () => {
  const r = parseCloseInput('Enter by 10am CT on Nov 11', { now });
  assert.ok(r.ok);
  assert.equal(r.closesAt.toISO(), '2026-11-11T16:00:00.000Z');
});

test('the bookmarklet sends the found line without asking first', () => {
  const src = bookmarkletSource('https://example.app', 'k3y');
  // One click in the happy path. The prompt is only the fallback for when
  // the server says it could not read what the page offered.
  assert.match(src, /if \(found\) \{ send\(found, false\); return; \}/);
  assert.match(src, /indexOf\('Saved'\) === 0/);
});
