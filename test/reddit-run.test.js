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
    claim: async () => [row()],
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
    claim: async () => [row()],
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
    claim: async () => [row()],
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
    claim: async () => [row()],
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
    claim: async () => [row({ id: 1 }), row({ id: 2, sub: 'TCGHub' })],
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
