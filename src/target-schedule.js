import { DateTime } from 'luxon';
import { openTargetRuns, targetRunSlots, completeTargetRun, targetRunItems } from './db.js';
import { recheckTargetRun, summariseRecheck } from './target-recheck.js';
import { runTargetRaffle } from './target-run.js';
import { morningReminderAt } from './target-copy.js';

/**
 * How far ahead of a reminder its post is created.
 *
 * The reminders are deliberately NOT created at announcement time. Target adds
 * and removes listings while a draw runs, and a post written on Monday would
 * still be listing Monday's items on Wednesday, including ones nobody can
 * enter any more. Building each reminder shortly before it is due means it
 * says what is actually enterable.
 *
 * Fifteen minutes is enough for the re-check to walk every listing serially
 * and for Buffer to accept a scheduled post, without being so early that the
 * list goes stale again before it sends.
 */
export const LEAD_MS = 15 * 60_000;

/**
 * One pass of the reminder ticker.
 *
 * Returns what it did rather than posting about it, so the caller decides what
 * is worth saying. A tick that finds nothing due is the normal case and should
 * be silent.
 */
export async function tickTargetReminders({
  now = DateTime.now(), asDraft = true, alert = null,
  // Injected so the ticker can be tested without a database or a Buffer
  // account. Every one of these either reads the run store or posts, and both
  // are things a test needs to stand in for.
  recheck = recheckTargetRun, run: runRaffle = runTargetRaffle,
  listRuns = openTargetRuns, listSlots = targetRunSlots,
  listItems = targetRunItems, complete = completeTargetRun,
} = {}) {
  const done = [];
  for (const run of await listRuns()) {
    if (!run.announced_at) continue;          // not announced yet, nothing to remind about
    const closesAt = run.closes_at ? DateTime.fromJSDate(new Date(run.closes_at)) : null;

    if (closesAt && now > closesAt) {
      await complete(run.id);
      done.push({ runId: run.id, action: 'completed' });
      continue;
    }
    if (!closesAt) continue;                  // no window known, so nothing can be scheduled

    const posted = await listSlots(run.id);
    const due = [];
    const morning = morningReminderAt(DateTime.fromJSDate(new Date(run.opened_at)), closesAt);
    if (morning && !posted.has('morning') && now >= morning.minus(LEAD_MS)) due.push('morning');
    const closing = closesAt.minus({ hours: 1 });
    if (!posted.has('closing') && now >= closing.minus(LEAD_MS)) due.push('closing');
    if (!due.length) continue;

    // Re-check first. A reminder listing items Target has pulled sends people
    // to a page they cannot enter, which is worse than a late reminder.
    const checked = await recheck(run.id);
    const left = await listItems(run.id);
    if (!left.length) {
      await complete(run.id, 'every listing was pulled');
      done.push({ runId: run.id, action: 'completed', why: 'every listing was pulled' });
      if (alert) await alert(`Target draw #${run.id}: every listing has been pulled, so the run is closed and no reminder was sent.`);
      continue;
    }

    // Reuse the announcement's grid only while membership is unchanged. Once
    // Target has pulled something, the stored picture is advertising a listing
    // nobody can enter, so passing null makes the run build a fresh one.
    const picture = checked.removed.length ? null : run.image_url;

    const report = await runRaffle({
      runId: run.id, now, closesAt, imageUrl: picture,
      asDraft, publishLive: false, slots: new Set(due),
    });
    done.push({ runId: run.id, action: 'reminded', slots: due, checked, report });

    if (alert) {
      await alert(
        `**Target reminder ready** run #${run.id}, slot(s) ${due.join(', ')}\n`
        + `${summariseRecheck(checked)}\n`
        + `Listing ${report.items} item(s)`
        + (checked.removed.length ? `, down from ${report.items + checked.removed.length}` : '')
        + (report.errors.length ? `\nErrors: ${report.errors.join('; ')}` : ''),
      );
    }
  }
  return done;
}
