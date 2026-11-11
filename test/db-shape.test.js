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

test('previousQueuePids looks only at earlier runs, inside a window', () => {
  // The whole point is telling last week's items being cleared out from this
  // week's arriving. Including the current run would flag every item as a
  // repeat of itself; leaving the window open would flag a product Walmart
  // genuinely queues again months later.
  const fn = db.slice(db.indexOf('export async function previousQueuePids'));
  const query = fn.slice(0, fn.indexOf('`,'));
  assert.match(query, /qr\.drop_date < \$1/, 'must exclude the run being built');
  assert.match(query, /qr\.drop_date >= \(\$1::date - \(\$2::int\)\)/, 'must be bounded');
});
