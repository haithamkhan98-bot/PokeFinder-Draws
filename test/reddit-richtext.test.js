import test from 'node:test';
import assert from 'node:assert/strict';
import { toRichtext, inlines, bold } from '../src/reddit-richtext.js';

test('a link becomes its own element, the way the editor emits one', () => {
  assert.deepEqual(
    inlines('Enter Here at 5PM EST: [Walmart Collectibles Draw](https://howl.link/abc)'),
    [
      { e: 'text', t: 'Enter Here at 5PM EST: ' },
      { e: 'link', t: 'Walmart Collectibles Draw', u: 'https://howl.link/abc' },
    ],
  );
});

test('bold is a formatting range over the stripped text, not the markers', () => {
  assert.deepEqual(bold('**Tips for Success**'), { text: 'Tips for Success', ranges: [[1, 0, 16]] });
  // Offsets are into what Reddit renders, so they must skip the markers.
  assert.deepEqual(bold('a **b** c'), { text: 'a b c', ranges: [[1, 2, 1]] });
});

test('an unclosed marker stays literal rather than bolding the rest of the line', () => {
  assert.deepEqual(bold('50% off ** today'), { text: '50% off ** today', ranges: [] });
});

test('consecutive bullets are one list', () => {
  const doc = toRichtext('* one\n* two\n* three');
  assert.equal(doc.document.length, 1);
  assert.equal(doc.document[0].e, 'list');
  assert.equal(doc.document[0].o, false, 'unordered');
  assert.equal(doc.document[0].c.length, 3);
});

test('a blank line ends a list, so two lists do not merge', () => {
  const doc = toRichtext('* one\n\nItem List:\n\n* two');
  assert.deepEqual(doc.document.map((b) => b.e), ['list', 'par', 'list']);
});

test('bullets carry their links through', () => {
  const doc = toRichtext('* [Elite Trainer Box](https://www.target.com/p/PokeFinder/A-1)');
  const inline = doc.document[0].c[0].c[0].c;
  assert.deepEqual(inline, [{ e: 'link', t: 'Elite Trainer Box', u: 'https://www.target.com/p/PokeFinder/A-1' }]);
});

test('the image goes first, where the editor puts one dragged to the top', () => {
  const doc = toRichtext('Some text', { imageAssetId: 'abc123' });
  assert.deepEqual(doc.document[0], { e: 'img', id: 'abc123' });
  assert.equal(doc.document[1].e, 'par');
});

test('no image asset means no image block, not an empty one', () => {
  const doc = toRichtext('Some text');
  assert.ok(!doc.document.some((b) => b.e === 'img'));
});

test('a real draw body converts to the blocks the post should show', () => {
  const md = [
    'Enter Here at 5PM EST / 2PM PST: [Walmart Collectibles Draw](https://howl.link/x)',
    '',
    'Item List:',
    '',
    '* 30th Anniversary Elite Trainer Box',
    '* 30th Anniversary Booster Bundle',
    '',
    '**One Piece TCG Draws**',
    '',
    '* One Piece OP-11 Booster Box',
  ].join('\n');

  const doc = toRichtext(md, { imageAssetId: 'grid1' });
  assert.deepEqual(doc.document.map((b) => b.e), ['img', 'par', 'par', 'list', 'par', 'list']);
  // The bolded game heading survives as bold rather than as asterisks.
  const heading = doc.document[4].c[0];
  assert.equal(heading.t, 'One Piece TCG Draws');
  assert.deepEqual(heading.f, [[1, 0, 19]]);
});

test('an empty body gives an empty document rather than throwing', () => {
  assert.deepEqual(toRichtext('').document, []);
  assert.deepEqual(toRichtext(null).document, []);
});

import { targetRedditPosts, REDDIT_DRAW_LINK, REDDIT_QUEUE_LINK } from '../src/reddit-copy.js';
import { DateTime } from 'luxon';

const NOW = DateTime.fromISO('2026-11-09T14:12', { zone: 'America/New_York' });
const CLOSES = DateTime.fromISO('2026-11-11T10:00', { zone: 'America/Chicago' });
const ITEMS = [
  { postName: 'Delta Reign Booster Display Box', set: 'Delta Reign', link: 'https://www.target.com/p/PokeFinder/A-1013166576' },
  { postName: 'Delta Reign Elite Trainer Box', set: 'Delta Reign', link: 'https://www.target.com/p/PokeFinder/A-1012793604' },
];

test('Reddit gets its own affiliate links, not the Discord or tweet ones', () => {
  assert.match(REDDIT_DRAW_LINK, /mavely\.app\.link/);
  assert.match(REDDIT_QUEUE_LINK, /mavely\.app\.link/);
  assert.notEqual(REDDIT_DRAW_LINK, REDDIT_QUEUE_LINK, 'draws and queues must be separable');
});

test('a Target raffle gets two Reddit posts, not the three the tweets get', () => {
  const posts = targetRedditPosts({ items: ITEMS, now: NOW, closesAt: CLOSES });
  // A third submission on the same draw to the same sub reads as spam, and a
  // Reddit post stays findable in the sub so the announcement still works on
  // day two.
  assert.deepEqual(posts.map((p) => p.slot), ['live', 'closing']);
});

test('the live title states the deadline rather than that it is live', () => {
  const [live] = targetRedditPosts({ items: ITEMS, now: NOW, closesAt: CLOSES });
  // Titles cannot be edited, and "live now" stops being news tomorrow while
  // the deadline stays true for the whole window.
  assert.match(live.title, /Entries Accepted by November 11 at 11AM EST \/ 8AM PST/);
  assert.doesNotMatch(live.title, /Now!/);
  assert.equal(live.dueAt, null, 'the announcement is due immediately');
});

test('the closing post is due an hour before close and goes to both subs', () => {
  const [, closing] = targetRedditPosts({ items: ITEMS, now: NOW, closesAt: CLOSES });
  assert.equal(closing.dueAt.toMillis(), CLOSES.minus({ hours: 1 }).toMillis());
  assert.deepEqual(closing.subs, ['PokeCollectors', 'TCGHub']);
});

test('every item is a markdown link, since Target has no catchall page', () => {
  const [live] = targetRedditPosts({ items: ITEMS, now: NOW, closesAt: CLOSES });
  // Reddit renders these, so the list reads as product names rather than a
  // wall of target.com.
  assert.match(live.body, /\* \[Delta Reign Booster Display Box\]\(https:\/\/www\.target\.com\/p\/PokeFinder\/A-1013166576\)/);
  assert.match(live.body, /\* \[Delta Reign Elite Trainer Box\]\(https:\/\/www\.target\.com\/p\/PokeFinder\/A-1012793604\)/);
  assert.doesNotMatch(live.body, /Enter Here at/, 'there is no single draw page to point at');
});

test('the links survive the richtext conversion as link elements', () => {
  const [live] = targetRedditPosts({ items: ITEMS, now: NOW, closesAt: CLOSES });
  const doc = toRichtext(live.body);
  const list = doc.document.find((b) => b.e === 'list');
  const first = list.c[0].c[0].c;
  assert.deepEqual(first, [{
    e: 'link', t: 'Delta Reign Booster Display Box',
    u: 'https://www.target.com/p/PokeFinder/A-1013166576',
  }]);
});

test('no Walmart tips block, since none of it applies to Target', () => {
  const [live] = targetRedditPosts({ items: ITEMS, now: NOW, closesAt: CLOSES });
  assert.doesNotMatch(live.body, /Tips for Success/);
  assert.doesNotMatch(live.body, /walmart/i);
});

test('with no close time there are no Target Reddit posts', () => {
  // The whole post is built around the deadline.
  assert.deepEqual(targetRedditPosts({ items: ITEMS, now: NOW, closesAt: null }), []);
});

test('a Target title over 300 characters is trimmed on a word boundary', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    postName: `Some Very Long Product Name Number ${i}`, set: `Set ${i}`, link: 'https://x/y',
  }));
  const [live] = targetRedditPosts({ items: many, now: NOW, closesAt: CLOSES });
  assert.ok(live.title.length <= 300, `title was ${live.title.length}`);
  assert.doesNotMatch(live.title, /\s$/);
});
