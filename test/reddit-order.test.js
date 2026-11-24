import test from 'node:test';
import assert from 'node:assert/strict';
import { nameLocally } from '../src/naming.js';
import { itemBlock, orderedSets } from '../src/copy.js';
import { drawItems } from '../src/reddit-copy.js';
import { setsOf } from '../src/naming.js';

// The Nov 25 Walmart draw as the monitor sent it, in arrival order.
const RAW = [
  ['21029102792', 'POKEMON 30TH ANNIVERSARY D7 4PK TIN', '$37.99'],
  ['21025306402', 'Pokemon Trading Card Game: Mega Evolution Delta Reign Booster 36ct Box', '$180.00'],
  ['20640569221', 'Pokemon Trading Card Game: 30th Celebration Elite Trainer Box', '$79.99'],
  ['20638470762', 'Pokemon Trading Card Game: 30th Celebration Booster Bundle', '$44.99'],
  ['21429207472', 'Pokemon Trading Card Game: Destined Rivals Blister 12 Count Bundle', '$120.00'],
  ['18710966734', 'Pokemon Trading Card Game: Mega Evolution Ascended Heroes Elite Trainer Box', '$84.99'],
].map(([pid, rawTitle, priceDisplay]) => ({ pid, rawTitle, priceDisplay, classification: 'pokemon' }));

const named = nameLocally(RAW);
const names = (text, marker) => text.split('\n').filter((l) => l.startsWith(marker))
  .map((l) => l.slice(marker.length).trim().replace(/ \$[\d.,]+$/, ''));

test('Reddit lists the draw in the same order as the tweets and Discord', () => {
  assert.deepEqual(names(drawItems(named), '* '), names(itemBlock(named), '• '));
});

test('a "30th Anniversary" title is filed under 30th Celebration, so the set is named once', () => {
  assert.equal(named[0].set, '30th Celebration');
  assert.match(named[0].postName, /^30th Celebration /);
  const sets = orderedSets(setsOf(named));
  assert.equal(sets.filter((s) => /30th/.test(s)).length, 1);
  assert.equal(sets[0], '30th Celebration');
  // And the tin sits with the other 30th Celebration items rather than apart.
  const order = names(itemBlock(named), '• ');
  const thirty = order.map((n, i) => (/^30th Celebration/.test(n) ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(thirty, [0, 1, 2]);
});
