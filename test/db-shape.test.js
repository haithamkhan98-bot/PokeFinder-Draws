import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const db = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');

test('latestDrawRun returns draw_date as text, not a Date', () => {
  // A DATE column arrives as a JS Date, and every parsed item carries its draw
  // date as the string "2026-11-12". Comparing the two matched nothing, and
  // !drawrepair reported no items for a draw whose embeds were right there.
  const fn = db.slice(db.indexOf('export async function latestDrawRun'));
  const query = fn.slice(0, fn.indexOf('`,'));
  assert.match(query, /to_char\(draw_date, 'YYYY-MM-DD'\) AS draw_date/);
  assert.doesNotMatch(query, /SELECT id, draw_date,/, 'the raw DATE column must not be selected');
});
