import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, setFromTitle, nameLocally, setsOf } from '../src/naming.js';

test('publisher and master set noise is stripped', () => {
  assert.equal(
    cleanTitle('Pokemon TCG: Scarlet & Violet—Prismatic Evolutions Booster Bundle'),
    'Prismatic Evolutions Booster Bundle',
  );
  assert.equal(
    cleanTitle('Pokémon Trading Card Game: 2024 Scarlet & Violet SV 8.5 Elite Trainer Box'),
    'Elite Trainer Box',
  );
});

test('the longest matching set wins', () => {
  assert.equal(setFromTitle('Pokemon TCG Mega Evolution Ascended Heroes Booster Bundle'), 'Ascended Heroes');
  assert.equal(setFromTitle('Pokemon TCG Mega Evolution Booster Bundle'), 'Mega Evolution');
});

test('an unknown set is reported as null rather than guessed', () => {
  assert.equal(setFromTitle('Pokemon TCG Some Brand New Set Booster Bundle'), null);
});

test('local naming fills set and postName for every item', () => {
  const named = nameLocally([
    { pid: '1', rawTitle: 'Pokemon TCG Prismatic Evolutions Booster Bundle 2 Pack', productName: 'Prismatic Evolutions Booster Bundle 2 Pack' },
    { pid: '2', rawTitle: 'Pokemon TCG 30th Anniversary Elite Trainer Box', productName: '30th Anniversary Elite Trainer Box' },
  ]);
  assert.equal(named[0].set, 'Prismatic Evolutions');
  assert.equal(named[1].set, '30th Anniversary');
  assert.ok(named.every((i) => i.postName && !/Pokemon/i.test(i.postName)));
});

test('set list keeps run order and drops duplicates and blanks', () => {
  assert.deepEqual(
    setsOf([{ set: 'Prismatic Evolutions' }, { set: '30th Anniversary' }, { set: 'Prismatic Evolutions' }, { set: null }]),
    ['Prismatic Evolutions', '30th Anniversary'],
  );
});
