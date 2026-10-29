import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { parseEmbed, parseWindow, classify, parsePrice, suggestName, POSTABLE, isPostable } from '../src/parse.js';
import { drawEmbed, restockEmbed } from './fixtures.js';

const NOW = DateTime.fromISO('2026-10-23T13:35:00', { zone: 'America/New_York' });

test('the restock monitor is ignored entirely', () => {
  assert.equal(parseEmbed(restockEmbed, { now: NOW }), null);
});

test('a draw embed parses every field the workflow needs', () => {
  const item = parseEmbed(drawEmbed, { now: NOW });
  assert.equal(item.pid, '20288667355');
  assert.equal(item.priceDisplay, '$79.94');
  assert.equal(item.priceCents, 7994);
  assert.equal(item.classification, 'pokemon');
  assert.equal(item.drawDate, '2026-10-26');
  assert.ok(item.imageUrl.includes('i5.walmartimages.com'));
  assert.equal(item.suspect, null);
});

test('the Pacific window converts to the Eastern times the posts are built from', () => {
  const { startsAt, endsAt } = parseEmbed(drawEmbed, { now: NOW });
  assert.equal(startsAt.setZone('America/New_York').toFormat('yyyy-LL-dd HH:mm'), '2026-10-26 17:00');
  assert.equal(endsAt.setZone('America/New_York').toFormat('yyyy-LL-dd HH:mm'), '2026-10-26 18:00');
});

test('a January window seen in late December lands on next year, not eleven months ago', () => {
  const dec = DateTime.fromISO('2026-12-28T10:00:00', { zone: 'America/New_York' });
  const { start } = parseWindow('Jan 3, 12:00pm - 1:00pm PST', dec);
  assert.equal(start.setZone('America/New_York').toISODate(), '2027-01-03');
});

test('an unreadable window is an error rather than a wrong time', () => {
  assert.ok(parseWindow('sometime next week', NOW).error);
  assert.ok(parseWindow('Oct 26, 2:00pm - 3:00pm XYZ', NOW).error);
});

test('a window far in the future is flagged rather than scheduled quietly', () => {
  const { suspect } = parseWindow('Oct 26, 2:00pm - 3:00pm PDT',
    DateTime.fromISO('2026-01-01T10:00:00', { zone: 'America/New_York' }));
  assert.ok(suspect);
});

test('a draw embed missing its Time field reports rather than guesses', () => {
  const broken = { ...drawEmbed, fields: drawEmbed.fields.filter((f) => f.name !== 'Time') };
  assert.match(parseEmbed(broken, { now: NOW }).error, /Time/);
});

test('repacks and non card merchandise are dropped', () => {
  assert.equal(classify('Pokemon TCG: Mystery Power Box'), 'excluded');
  assert.equal(classify('Pokemon Repack Bundle'), 'excluded');
  assert.equal(classify('Nendoroid Pikachu Figure'), 'excluded');
  assert.equal(classify('Pokemon Pikachu Plush'), 'excluded');
});

// Repacks are checked before anything else, so a Pokemon repack stays excluded
// rather than being pulled back in by the Pokemon patterns.
test('a Pokemon repack is excluded, not posted', () => {
  assert.equal(classify('Pokemon TCG Mystery Pack'), 'excluded');
});

test('card products are sorted into their posting categories', () => {
  assert.equal(classify('Pokemon TCG: Prismatic Evolutions Booster Bundle'), 'pokemon');
  assert.equal(classify('One Piece TCG OP-11 Booster Box'), 'onepiece');
  assert.equal(classify('One Piece Card Game Romance Dawn'), 'onepiece');
  assert.equal(classify('2026 Topps Chrome Baseball Hobby Box'), 'sports');
  assert.equal(classify('Panini Prizm NBA Blaster'), 'sports');
  assert.equal(classify('Magic: The Gathering Final Fantasy Collector'), 'othertcg');
  assert.equal(classify('Lorcana Azurite Sea Booster Box'), 'othertcg');
});

// A game we have no pattern for must be reported, never silently grouped with
// something else or dropped as if it were merchandise.
test('an unrecognised product is flagged as unknown', () => {
  assert.equal(classify('Brand New Card Game Starter Deck'), 'unknown');
});

test('postable categories are Pokemon first, then the rest', () => {
  assert.deepEqual(POSTABLE, ['pokemon', 'onepiece', 'sports', 'othertcg']);
  assert.ok(isPostable('onepiece'));
  assert.ok(!isPostable('unknown'));
  assert.ok(!isPostable('excluded'));
});

test('prefix noise is stripped from the stored product name', () => {
  assert.equal(
    suggestName('Pokemon TCG: Scarlet & Violet - Prismatic Evolutions 2Pk Booster Bundle'),
    'Prismatic Evolutions 2Pk Booster Bundle',
  );
});

test('prices parse to cents', () => {
  assert.equal(parsePrice('$79.94'), 7994);
  assert.equal(parsePrice('150.0 USD'), 15000);
  assert.equal(parsePrice('$1,299.99'), 129999);
});

test('a "Raffle Now Live" embed is ignored rather than reported as unreadable', () => {
  const live = {
    author: { name: 'Walmart Draws' },
    title: 'Pokemon Trading Card Game Scarlet & Violet Prismatic Evolutions Elite Trainer Box',
    fields: [
      { name: 'Price', value: '$69.00' },
      { name: 'Type', value: 'Raffle Now Live' },
      { name: 'PID', value: '18170913799' },
      { name: 'Cart Limit', value: '3' },
      { name: 'Seller', value: 'Walmart.com' },
    ],
  };
  assert.equal(parseEmbed(live, { now: DateTime.fromISO('2026-10-28T17:00', { zone: 'America/New_York' }) }), null);
});

test('a draw embed with no Time and no live marker is still reported', () => {
  const broken = {
    author: { name: 'Walmart Draws' },
    title: 'Something',
    fields: [{ name: 'Price', value: '$1.00' }, { name: 'PID', value: '1' }],
  };
  const res = parseEmbed(broken, { now: DateTime.now() });
  assert.match(res.error, /missing Time/);
});
