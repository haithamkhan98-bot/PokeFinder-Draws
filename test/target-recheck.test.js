import test from 'node:test';
import assert from 'node:assert/strict';
import { summariseRecheck } from '../src/target-recheck.js';

// recheckTargetRun needs a database, so the behaviour that matters without one
// is the rule it encodes: what counts as a removal. These assert the shape of
// the decision via the summary, plus the source itself for the guard.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/target-recheck.js', import.meta.url), 'utf8');

test('only an explicit false removes an item', () => {
  // Absent is not false. Target moving the flag would otherwise look like
  // every item being pulled, and silently empty a live draw's reminder.
  assert.match(src, /queueGated === false/);
  assert.match(src, /queueGated !== true/);
  assert.equal(/queueGated\s*\?\s*|!r\.queueGated\b/.test(src), false);
});

test('a total read failure removes nothing', () => {
  // Being walled looks identical to every item vanishing. The difference is
  // that one of them is Target refusing us, and acting on it would wipe the
  // reminder for a draw that is still running.
  assert.match(src, /unreadable\.length === result\.checked/);
  assert.match(src, /nothing was marked removed/);
});

test('listings are checked serially with a pause', () => {
  // A burst is the quickest way to get walled, and being walled is the one
  // failure this whole module exists to avoid misreading.
  assert.match(src, /pauseMs/);
  assert.equal(/Promise\.all|await Promise\.allSettled/.test(src), false);
});

test('the summary names what was pulled and why anything was unreadable', () => {
  assert.match(summariseRecheck({
    checked: 3, removed: [{ tcin: '1', name: 'Ditto Premium Collection' }],
    unreadable: [{ tcin: '2', name: 'Delta Reign ETB', why: 'bot wall' }], errors: [],
  }), /3 listing\(s\) checked.*1 pulled by Target \(Ditto Premium Collection\).*Delta Reign ETB: bot wall/s);
  assert.match(summariseRecheck({ checked: 2, removed: [], unreadable: [], errors: [] }), /none pulled/);
});
