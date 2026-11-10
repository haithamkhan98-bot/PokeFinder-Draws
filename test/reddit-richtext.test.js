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
