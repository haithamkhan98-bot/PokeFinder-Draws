import test from 'node:test';
import assert from 'node:assert/strict';
import { postOne, tickReddit } from '../src/reddit-run.js';

const row = (over = {}) => ({
  id: 1, source: 'draw', run_id: 9, slot: 'announcement', sub: 'PokeCollectors',
  title: 'Walmart Draws Today', body: 'Enter Here: [Draw](https://howl.link/x)',
  image_url: 'https://host/grid.png', attempts: 0, ...over,
});

const ok = () => ({ fullname: 't3_abc', url: 'https://redd.it/abc', id: 'abc' });

test('a post is approved immediately after it is submitted', async () => {
  const order = [];
  const r = await postOne(row(), {
    deps: {
      upload: async () => { order.push('upload'); return 'asset1'; },
      send: async (a) => { order.push('submit'); assert.equal(a.imageAssetId, 'asset1'); return ok(); },
      ok: async (fn) => { order.push(`approve:${fn}`); },
    },
  });
  // The gap between posting and approving is how long AutoModerator's removal
  // is visible, so nothing may come between them.
  assert.deepEqual(order, ['upload', 'submit', 'approve:t3_abc']);
  assert.equal(r.approved, true);
});

test('a failed image upload still posts, without the grid', async () => {
  const r = await postOne(row(), {
    deps: {
      upload: async () => { throw new Error('reddit media 503'); },
      send: async (a) => { assert.equal(a.imageAssetId, null); return ok(); },
      ok: async () => {},
    },
  });
  // The links and the item list are the point; the grid is decoration.
  assert.equal(r.imageError, 'reddit media 503');
  assert.equal(r.approved, true);
});

test('a failed approve does not fail the post, so a retry cannot double post', async () => {
  const r = await postOne(row(), {
    deps: {
      upload: async () => 'asset1',
      send: async () => ok(),
      ok: async () => { throw new Error('403 not a moderator'); },
    },
  });
  assert.equal(r.approved, false);
  assert.match(r.approveError, /not a moderator/);
  assert.equal(r.fullname, 't3_abc', 'the submission is still recorded');
});

test('no image_url means no upload is attempted at all', async () => {
  let tried = false;
  await postOne(row({ image_url: null }), {
    deps: {
      upload: async () => { tried = true; return 'x'; },
      send: async (a) => { assert.equal(a.imageAssetId, null); return ok(); },
      ok: async () => {},
    },
  });
  assert.equal(tried, false);
});

test('nothing due is silent', async () => {
  assert.deepEqual(await tickReddit({ claim: async () => [], connected: async () => true }), []);
});

test('posts due before Reddit is connected are left queued, not failed', async () => {
  let failed = 0;
  const did = await tickReddit({
    claim: async () => [row()], mode: 'api',
    connected: async () => false,
    markFailed: async () => { failed += 1; },
    pauseMs: 0,
  });
  assert.match(did[0].skipped, /not connected/);
  assert.equal(failed, 0, 'burning an attempt on a setup step nobody has done yet is wrong');
});

test('a submit failure is recorded as an attempt and alerted', async () => {
  const alerts = [];
  const marked = [];
  const did = await tickReddit({
    claim: async () => [row()], mode: 'api',
    connected: async () => true,
    post: async () => { throw new Error('SUBREDDIT_NOEXIST'); },
    markFailed: async (id, msg) => marked.push([id, msg]),
    alert: async (t) => alerts.push(t),
    pauseMs: 0,
  });
  assert.equal(did[0].error, 'SUBREDDIT_NOEXIST');
  assert.deepEqual(marked, [[1, 'SUBREDDIT_NOEXIST']]);
  assert.match(alerts[0], /attempt 1 of 4/);
});

test('an unapproved post alerts loudly, since it is the one failure that hides the post', async () => {
  const alerts = [];
  await tickReddit({
    claim: async () => [row()], mode: 'api',
    connected: async () => true,
    post: async () => ({ ...ok(), approved: false, approveError: '403', imageError: null }),
    markPosted: async () => {},
    alert: async (t) => alerts.push(t),
    pauseMs: 0,
  });
  assert.match(alerts[0], /NOT APPROVED/);
  assert.match(alerts[0], /approve it by hand/);
});

test('a clean post says nothing, so the alert channel stays readable', async () => {
  const alerts = [];
  await tickReddit({
    claim: async () => [row()], mode: 'api',
    connected: async () => true,
    post: async () => ({ ...ok(), approved: true, imageError: null, approveError: null }),
    markPosted: async () => {},
    alert: async (t) => alerts.push(t),
    pauseMs: 0,
  });
  assert.deepEqual(alerts, []);
});

test('several due posts are spaced out rather than fired at once', async () => {
  const at = [];
  await tickReddit({
    claim: async () => [row({ id: 1 }), row({ id: 2, sub: 'TCGHub' })], mode: 'api',
    connected: async () => true,
    post: async () => { at.push(Date.now()); return { ...ok(), approved: true }; },
    markPosted: async () => {},
    pauseMs: 30,
  });
  assert.equal(at.length, 2);
  // Consecutive submissions inside a second is what Reddit's spam heuristics
  // look for.
  assert.ok(at[1] - at[0] >= 25, `gap was ${at[1] - at[0]}ms`);
});

import { manualMessages, chunk } from '../src/reddit-manual.js';

test('manual mode delivers to the alert channel and does not touch Reddit', async () => {
  const sent = [];
  let posted = false;
  const did = await tickReddit({
    claim: async () => [row()],
    post: async () => { posted = true; return ok(); },
    connected: async () => { throw new Error('should not be asked'); },
    markPosted: async () => {},
    alert: async (t) => sent.push(t),
    pauseMs: 0,
  });
  assert.equal(posted, false, 'the API path must not run without credentials');
  assert.equal(did[0].manual, true);
  assert.match(sent[0], /Reddit post ready to paste.*r\/PokeCollectors/s);
});

test('manual mode with no alert channel leaves posts queued rather than losing them', async () => {
  let failed = 0;
  const did = await tickReddit({
    claim: async () => [row()], alert: null,
    markFailed: async () => { failed += 1; }, pauseMs: 0,
  });
  assert.match(did[0].skipped, /no alert channel/);
  assert.equal(failed, 0);
});

test('mode api still submits', async () => {
  let posted = false;
  await tickReddit({
    claim: async () => [row()], mode: 'api',
    connected: async () => true,
    post: async () => { posted = true; return { ...ok(), approved: true }; },
    markPosted: async () => {}, pauseMs: 0,
  });
  assert.equal(posted, true);
});

test('the title and body are separately copyable, and not rendered by Discord', () => {
  const m = manualMessages(row());
  // Code blocks stop Discord turning the links into previews, which would
  // make the raw markdown impossible to copy back out.
  assert.match(m[0], /\*\*Title\*\*\n```\nWalmart Draws Today\n```/);
  assert.match(m[1], /^```\n/);
  assert.match(m[0], /Image: https:\/\/host\/grid\.png/);
});

test('a long body is split on line boundaries, never mid link', () => {
  const line = '[Some Product Name](https://www.walmart.com/ip/PokeFinder/123456789)';
  const body = Array.from({ length: 60 }, () => line).join('\n');
  const parts = chunk(body, 500);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= 500);
    // A split inside a link would leave a fragment with no closing paren.
    assert.equal((p.match(/\[/g) || []).length, (p.match(/\]\(/g) || []).length);
  }
});

test('a single over-long line goes out alone rather than failing the batch', () => {
  const parts = chunk(`short\n${'x'.repeat(300)}\nshort`, 100);
  assert.deepEqual(parts[0], 'short');
  assert.equal(parts[1].length, 300);
});

test('no image says so rather than leaving a bare label', () => {
  assert.match(manualMessages(row({ image_url: null }))[0], /No image for this one\./);
});

import { groupIdentical } from '../src/reddit-run.js';

test('identical posts to both subs become one paste block', () => {
  const rows = [
    row({ id: 1, sub: 'PokeCollectors' }),
    row({ id: 2, sub: 'TCGHub' }),
  ];
  const jobs = groupIdentical(rows);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].subs, ['PokeCollectors', 'TCGHub']);
  assert.deepEqual(jobs[0].ids, [1, 2]);
});

test('posts that genuinely differ stay separate', () => {
  // Keyed on the text, so a future per-sub variant splits without this code
  // needing to know why.
  const jobs = groupIdentical([
    row({ id: 1, sub: 'PokeCollectors', body: 'Pokemon only' }),
    row({ id: 2, sub: 'TCGHub', body: 'Pokemon and One Piece' }),
  ]);
  assert.equal(jobs.length, 2);
});

test('different slots are never merged', () => {
  const jobs = groupIdentical([
    row({ id: 1, sub: 'PokeCollectors', slot: 'live' }),
    row({ id: 2, sub: 'PokeCollectors', slot: 'closing' }),
  ]);
  assert.equal(jobs.length, 2);
});

test('a grouped job marks every row it covers, so none is redelivered', async () => {
  const marked = [];
  const sent = [];
  await tickReddit({
    claim: async () => [row({ id: 1, sub: 'PokeCollectors' }), row({ id: 2, sub: 'TCGHub' })],
    markPosted: async (id) => marked.push(id),
    alert: async (t) => sent.push(t),
    pauseMs: 0,
  });
  assert.deepEqual(marked.sort(), [1, 2]);
  // One delivery, naming both subs.
  assert.match(sent[0], /r\/PokeCollectors and r\/TCGHub/);
  assert.equal(sent.filter((m) => m.includes('ready to paste')).length, 1);
});
