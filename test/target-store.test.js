import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const db = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');

/**
 * migrate() runs schema.sql as a single pool.query, so one malformed statement
 * takes the whole startup down, not just the new tables. There is no database
 * in this suite, so these guard the shape of the script instead of its effect.
 */
test('schema.sql stays runnable as one script', () => {
  assert.equal((schema.match(/\(/g) ?? []).length, (schema.match(/\)/g) ?? []).length);
  assert.ok(schema.trimEnd().endsWith(';'));
  // Every CREATE is idempotent, since migrate() runs on every single boot.
  const creates = schema.match(/CREATE (TABLE|INDEX|UNIQUE INDEX)[^\n]*/g) ?? [];
  const notIdempotent = creates.filter((c) => !/IF NOT EXISTS/.test(c));
  assert.deepEqual(notIdempotent, [], `these would fail on the second boot:\n${notIdempotent.join('\n')}`);
});

test('the Target tables are present and items are soft deleted', () => {
  for (const t of ['target_runs', 'target_items', 'target_posts', 'target_close_times']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`), t);
  }
  // Removed items must survive: a reminder has to be able to say what Target
  // pulled, and a deleted row cannot tell anyone that.
  assert.match(schema, /removed_at\s+TIMESTAMPTZ/);
  assert.equal(/DELETE FROM target_items/.test(db), false);
});

test('a run is found by being open, not by a date key', () => {
  // Walmart runs key on drop_date because a drop is an event. A Target draw
  // is a window that stays open, so the lookup is completed_at IS NULL.
  assert.match(db, /FROM target_runs WHERE completed_at IS NULL/);
  // And it must not be a unique constraint: two genuinely concurrent draws
  // should degrade into one run, not into failing inserts and lost items.
  assert.equal(/UNIQUE INDEX[^\n]*target_runs/.test(schema), false);
});

test('adding an item reports whether it was new', () => {
  // Items added mid draw are worth naming in the next reminder; re-announcing
  // the whole list on every embed would be noise.
  assert.match(db, /\(xmax = 0\) AS inserted/);
  // A listing Target pulled and restored comes back rather than counting new.
  assert.match(db, /removed_at = NULL/);
});
