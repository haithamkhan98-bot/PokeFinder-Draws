import test from 'node:test';
import assert from 'node:assert/strict';
import { queuePageIds, clusterByArrival, selectDropItems, explainSelection } from '../src/queue-page.js';

// Tonight's real shape: four at 17:46:58, eleven from 17:48:20.
const T = Date.parse('2026-11-10T22:46:58Z');
const real = [
  { pid: '21077511138', productName: 'Topps Flagship Basketball Mega Box', seenAt: T },
  { pid: '21056620742', productName: 'MTG Star Trek Beam Me Up Bundle', seenAt: T },
  { pid: '21183806474', productName: 'MTG Star Trek Collector Booster Box', seenAt: T },
  { pid: '21013316135', productName: 'MTG Star Trek Bundle', seenAt: T },
];
const stale = [
  { pid: '20790459600', productName: 'Topps Bowman Chrome Baseball Mega Box', seenAt: T + 82_000 },
  { pid: '20943802675', productName: 'Topps Bowman Football Value Box', seenAt: T + 82_000 },
  { pid: '20790967127', productName: 'Upper Deck Series 1 Hockey Tin', seenAt: T + 82_000 },
];

test('the real burst and the clear-out burst are separate clusters', () => {
  const clusters = clusterByArrival([...real, ...stale]);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].length, 4);
  assert.equal(clusters[1].length, 3);
});

test('a drop that trickles stays one cluster', () => {
  // Gap based, not a fixed window from the first item, so a slow drop is not
  // split in half.
  const trickle = [0, 30_000, 60_000, 90_000].map((o, n) => ({ pid: `${n}`, seenAt: T + o }));
  assert.equal(clusterByArrival(trickle).length, 1);
});

test('missing timestamps mean one cluster, so nothing is convicted by position', () => {
  const clusters = clusterByArrival([{ pid: '1' }, { pid: '2', seenAt: T }]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].every((i) => i.cluster === 0), true);
});

test("tonight's run: the four are kept and the stale three dropped", () => {
  const result = selectDropItems([...real, ...stale], {
    previousPids: new Map([
      ['20790459600', '2026-11-04'],
      ['20790967127', '2026-11-04'],
    ]),
    livePageIds: new Set(['20943802675', '20860510264']),
  });
  assert.deepEqual(result.kept.map((i) => i.pid).sort(), real.map((i) => i.pid).sort());
  assert.equal(result.dropped.length, 3);
});

test('a first burst item is kept even when it was queued recently', () => {
  // Walmart does re-queue products, and that item arrived with the real drop.
  const result = selectDropItems(real, {
    previousPids: new Map([['21077511138', '2026-11-04']]),
    livePageIds: new Set(['21077511138']),
  });
  assert.equal(result.dropped.length, 0);
  assert.match(result.all.find((i) => i.pid === '21077511138').why, /first arrival burst/);
});

test('a later item with nothing against it is kept, not guessed away', () => {
  const result = selectDropItems([...real, { pid: '999', productName: 'New Thing', seenAt: T + 82_000 }], {
    previousPids: new Map(),
    livePageIds: new Set(),
  });
  assert.equal(result.dropped.length, 0);
  assert.match(result.all.find((i) => i.pid === '999').why, /nothing against it/);
});

test('no page signal is not the same as an empty page', () => {
  const args = { previousPids: new Map(), livePageIds: null };
  const result = selectDropItems([...real, { pid: '999', seenAt: T + 82_000 }], args);
  // null means the page could not be read, so it convicts nothing.
  assert.equal(result.all.find((i) => i.pid === '999').onPage, null);
  assert.equal(result.dropped.length, 0);
});

test('the explanation names the evidence for every item', () => {
  const result = selectDropItems([...real, ...stale], {
    previousPids: new Map([['20790459600', '2026-11-04']]),
    livePageIds: new Set(['20943802675']),
  });
  const text = explainSelection(result);
  assert.match(text, /DROP c1 Topps Bowman Chrome Baseball Mega Box \(20790459600\) later burst, in the 2026-11-04 queue/);
  assert.match(text, /DROP c1 Topps Bowman Football Value Box \(20943802675\) later burst, on the live queue page now/);
  assert.match(text, /KEEP c0 MTG Star Trek Bundle/);
});

test('a bot wall reads as no signal rather than an empty queue', async () => {
  const blocked = async () => ({ ok: true, text: async () => '<html>Are you a robot or human?</html>' });
  assert.equal(await queuePageIds({ fetchImpl: blocked }), null);
});

test('item ids are read from product links', async () => {
  const page = async () => ({
    ok: true,
    text: async () => '<a href="/ip/Some-Product-Name/20943802675">x</a><a href="/ip/21131404873">y</a>',
  });
  const ids = await queuePageIds({ fetchImpl: page });
  assert.deepEqual([...ids].sort(), ['20943802675', '21131404873']);
});

test('an unreachable page is null, not a crash', async () => {
  assert.equal(await queuePageIds({ fetchImpl: async () => { throw new Error('ECONNRESET'); } }), null);
  assert.equal(await queuePageIds({ fetchImpl: async () => ({ ok: false }) }), null);
});
