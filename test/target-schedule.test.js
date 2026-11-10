import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { tickTargetReminders, LEAD_MS } from '../src/target-schedule.js';
import { morningReminderAt } from '../src/target-copy.js';

const ET = 'America/New_York';
const at = (s) => DateTime.fromISO(s, { zone: ET });

/** A run as the database hands it back, with JS dates rather than Luxon. */
function run(over = {}) {
  return {
    id: 7, status: 'posted',
    opened_at: at('2026-11-09T14:00').toJSDate(),
    closes_at: at('2026-11-11T11:00').toJSDate(),
    announced_at: at('2026-11-09T14:01').toJSDate(),
    headline: 'Mega Evolution', image_url: 'https://img/old.png',
    ...over,
  };
}

/** Wire a tick up to fakes and record what it asked for. */
function harness({ runs = [run()], posted = [], items = [{ tcin: '1' }], removed = [] } = {}) {
  const calls = { raffle: [], completed: [], alerts: [] };
  const deps = {
    listRuns: async () => runs,
    listSlots: async () => new Set(posted),
    listItems: async () => items,
    complete: async (id, why) => calls.completed.push({ id, why }),
    // The same shape recheckTargetRun returns, since the tick hands it
    // straight to summariseRecheck.
    recheck: async () => ({
      runId: 7, checked: items.length + removed.length,
      removed, unreadable: [], kept: items, errors: [],
    }),
    run: async (args) => { calls.raffle.push(args); return { items: items.length, posts: [], errors: [] }; },
    alert: async (t) => calls.alerts.push(t),
  };
  return { calls, deps };
}

test('nothing is due in the middle of a draw', async () => {
  const { calls, deps } = harness();
  const did = await tickTargetReminders({ now: at('2026-11-09T18:00'), ...deps });
  assert.deepEqual(did, []);
  assert.equal(calls.raffle.length, 0);
});

test('the morning reminder is built once its lead window opens', async () => {
  const morning = morningReminderAt(at('2026-11-09T14:00'), at('2026-11-11T11:00'));
  assert.equal(morning.toFormat('ccc h:mma'), 'Tue 9:00AM');

  const early = harness();
  await tickTargetReminders({ now: morning.minus(LEAD_MS + 60_000), ...early.deps });
  assert.equal(early.calls.raffle.length, 0, 'not before the lead window');

  const due = harness();
  const did = await tickTargetReminders({ now: morning.minus(LEAD_MS - 1000), ...due.deps });
  assert.deepEqual(did[0].slots, ['morning']);
  assert.deepEqual([...due.calls.raffle[0].slots], ['morning']);
});

test('a reminder already posted is never built again', async () => {
  const { calls, deps } = harness({ posted: ['morning'] });
  await tickTargetReminders({ now: at('2026-11-10T09:00'), ...deps });
  assert.equal(calls.raffle.length, 0);
});

test('the closing reminder is built an hour and a lead before the close', async () => {
  const { calls, deps } = harness({ posted: ['morning'] });
  const did = await tickTargetReminders({ now: at('2026-11-11T09:50'), ...deps });
  assert.deepEqual(did[0].slots, ['closing']);
  assert.equal(calls.raffle[0].closesAt.toFormat('h:mma'), '11:00AM');
});

test('a run past its close is completed instead of reminded', async () => {
  const { calls, deps } = harness();
  const did = await tickTargetReminders({ now: at('2026-11-11T11:30'), ...deps });
  assert.equal(did[0].action, 'completed');
  assert.deepEqual(calls.completed, [{ id: 7, why: undefined }]);
  assert.equal(calls.raffle.length, 0);
});

test('a run with no known close time is left alone', async () => {
  const { calls, deps } = harness({ runs: [run({ closes_at: null })] });
  const did = await tickTargetReminders({ now: at('2026-11-20T09:00'), ...deps });
  assert.deepEqual(did, []);
  assert.equal(calls.completed.length, 0, 'an unknown close is not a closed draw');
});

test('a run that was never announced gets no reminders', async () => {
  const { calls, deps } = harness({ runs: [run({ announced_at: null })] });
  await tickTargetReminders({ now: at('2026-11-11T09:50'), ...deps });
  assert.equal(calls.raffle.length, 0);
});

test('an emptied draw is closed and alerted rather than reminded', async () => {
  const { calls, deps } = harness({ items: [], posted: ['morning'] });
  const did = await tickTargetReminders({ now: at('2026-11-11T09:50'), ...deps });
  assert.equal(did[0].action, 'completed');
  assert.match(calls.alerts[0], /every listing has been pulled/);
  assert.equal(calls.raffle.length, 0, 'a reminder for nothing is not sent');
});

test('the stored grid is reused while membership holds and dropped once it does not', async () => {
  const same = harness({ posted: ['morning'] });
  await tickTargetReminders({ now: at('2026-11-11T09:50'), ...same.deps });
  assert.equal(same.calls.raffle[0].imageUrl, 'https://img/old.png');

  const changed = harness({ posted: ['morning'], removed: [{ tcin: '2' }] });
  await tickTargetReminders({ now: at('2026-11-11T09:50'), ...changed.deps });
  assert.equal(changed.calls.raffle[0].imageUrl, null, 'a pulled item means a fresh grid');
});

test('both reminders can come due in one pass on a short draw', async () => {
  // Opened late evening, closing the next morning: the 9AM morning post lands
  // inside the final hour, so only the closing beat should be built.
  const short = harness({
    runs: [run({
      opened_at: at('2026-11-09T22:00').toJSDate(),
      closes_at: at('2026-11-10T09:30').toJSDate(),
    })],
  });
  const did = await tickTargetReminders({ now: at('2026-11-10T08:20'), ...short.deps });
  assert.deepEqual(did[0].slots, ['closing'], 'the morning post is skipped, not doubled up');
});

test('the alert names the slot and the membership change', async () => {
  const { calls, deps } = harness({ posted: ['morning'], removed: [{ tcin: '2' }] });
  await tickTargetReminders({ now: at('2026-11-11T09:50'), ...deps });
  assert.match(calls.alerts[0], /run #7/);
  assert.match(calls.alerts[0], /closing/);
});
