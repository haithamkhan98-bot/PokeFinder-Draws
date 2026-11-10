import { probeListing } from './target.js';
import { targetRunItems, markTargetItemsRemoved } from './db.js';

/**
 * Find the listings Target has pulled since a run opened.
 *
 * `queue_gated` false means the item has left the drawing. Absent means Target
 * moved the flag, which is NOT the same thing, and the difference matters: an
 * absent flag treated as a removal would quietly drop live items out of a
 * reminder and nobody would notice until entries were lower than usual.
 *
 * So only an explicit false removes. Anything else, a missing flag, a refusal,
 * a timeout, leaves the item alone and is reported so the cause is visible
 * rather than inferred from a shrinking list.
 */
export async function recheckTargetRun(runId, { probe = probeListing, pauseMs = 400 } = {}) {
  const rows = await targetRunItems(runId);
  const result = { checked: 0, removed: [], unreadable: [], errors: [] };

  for (const row of rows) {
    // Serially, with a pause. A burst of requests is the fastest way to get
    // walled, and being walled would look exactly like every item vanishing.
    if (result.checked && pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    result.checked += 1;

    const r = await probe(row.tcin);
    if (r.queueGated === false) {
      result.removed.push({ tcin: row.tcin, name: row.product_name ?? row.raw_title });
    } else if (r.queueGated !== true) {
      result.unreadable.push({
        tcin: row.tcin,
        name: row.product_name ?? row.raw_title,
        why: r.error ? r.error : r.walled ? 'bot wall' : !r.ok ? `HTTP ${r.status}` : 'flag absent',
      });
    }
  }

  // If nothing at all could be read, Target is refusing us rather than having
  // pulled the entire draw. Removing everything on that basis would empty a
  // reminder of a draw that is still running.
  if (result.checked && result.unreadable.length === result.checked) {
    result.errors.push('every listing was unreadable, so nothing was marked removed');
    return result;
  }

  if (result.removed.length) {
    await markTargetItemsRemoved(runId, result.removed.map((i) => i.tcin));
  }
  return result;
}

/** The re-check as a line for the alert channel. */
export function summariseRecheck(r) {
  const bits = [`${r.checked} listing(s) checked`];
  if (r.removed.length) bits.push(`${r.removed.length} pulled by Target (${r.removed.map((i) => i.name).join(', ')})`);
  else bits.push('none pulled');
  if (r.unreadable.length) bits.push(`${r.unreadable.length} unreadable (${r.unreadable.map((i) => `${i.name}: ${i.why}`).join('; ')})`);
  if (r.errors.length) bits.push(r.errors.join('; '));
  return bits.join(', ');
}
