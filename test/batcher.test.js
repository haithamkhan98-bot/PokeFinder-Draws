import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { Batcher } from '../src/batcher.js';
import { parseEmbed } from '../src/parse.js';
import { oct21Draw, drawEmbed } from './fixtures.js';

const NOW = DateTime.fromISO('2026-10-19T13:35:00', { zone: 'America/New_York' });
const items = oct21Draw.map((e) => parseEmbed(e, { now: NOW }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the 21 October five item draw fires once, with all five', async () => {
  const fired = [];
  const b = new Batcher({ quietMs: 60, ceilingMs: 5000, onFire: (r) => fired.push(r) });

  // Arrive staggered, the way the monitor posts them.
  for (const item of items) { b.add(item); await sleep(15); }

  assert.equal(fired.length, 0, 'must not fire while items are still arriving');
  await sleep(120);
  assert.equal(fired.length, 1, 'one draw is one run');
  assert.equal(fired[0].items.length, 5);
  assert.equal(fired[0].reason, 'quiet');
  assert.equal(fired[0].drawDate, '2026-10-21');
});

test('a repeated item does not push the run back, or reopen it afterwards', async () => {
  const fired = [];
  const late = [];
  const b = new Batcher({ quietMs: 80, ceilingMs: 5000, onFire: (r) => fired.push(r), onLate: (r) => late.push(r) });

  b.add(items[0]);
  for (let i = 0; i < 6; i++) { await sleep(20); b.add(items[0]); } // same PID over and over
  await sleep(90);

  assert.equal(fired.length, 1, 'a chatty monitor must not defer the run or duplicate it');
  assert.equal(fired[0].items.length, 1);
  assert.equal(late.length, 0, 'a repost of a known item is noise, not an amendment');
});

test('an item arriving after the run fired is reported as an amendment', async () => {
  const fired = [];
  const late = [];
  const b = new Batcher({ quietMs: 40, ceilingMs: 5000, onFire: (r) => fired.push(r), onLate: (r) => late.push(r) });

  b.add(items[0]);
  await sleep(80);
  assert.equal(fired.length, 1);

  b.add(items[1]);   // a sixth item turns up after the posts would have gone out
  await sleep(80);

  assert.equal(fired.length, 1, 'a late item must not create a second post set');
  assert.equal(late.length, 1);
  assert.equal(late[0].item.pid, items[1].pid);
});

test('the ceiling fires a run that never goes quiet', async () => {
  const fired = [];
  const b = new Batcher({ quietMs: 10_000, ceilingMs: 120, onFire: (r) => fired.push(r) });

  b.add(items[0]);
  await sleep(40); b.add(items[1]);
  await sleep(40); b.add(items[2]);
  await sleep(100);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].reason, 'ceiling');
  assert.equal(fired[0].items.length, 3);
});

test('two draw dates in flight stay separate', async () => {
  const fired = [];
  const b = new Batcher({ quietMs: 60, ceilingMs: 5000, onFire: (r) => fired.push(r) });

  b.add(items[0]);                                     // 21 October
  b.add(parseEmbed(drawEmbed, { now: NOW }));          // 26 October
  await sleep(120);

  assert.equal(fired.length, 2);
  assert.deepEqual(fired.map((f) => f.drawDate).sort(), ['2026-10-21', '2026-10-26']);
});

test('flush on shutdown loses nothing in flight', async () => {
  const fired = [];
  const b = new Batcher({ quietMs: 10_000, ceilingMs: 10_000, onFire: (r) => fired.push(r) });
  b.add(items[0]);
  b.flush();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].reason, 'flush');
});
