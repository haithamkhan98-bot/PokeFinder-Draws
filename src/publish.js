import { nameItems, setsOf } from './naming.js';
import { buildPosts, winsPost, discordPost, altTextFor } from './copy.js';
import { createOnDrawChannels, CHANNELS, DRAW_CHANNELS } from './buffer.js';
import { recordBufferPost, markComplete } from './db.js';

/**
 * Everything that happens after the draw image exists.
 *
 * Posts are created as drafts carrying their intended send times, so the whole
 * set can be reviewed in Buffer and approved rather than going out unseen.
 * Switching to live scheduling later is a matter of dropping saveToDraft.
 */
export async function publishRun({
  runId, items, startsAt, endsAt, imageUrl, asDraft = true, liveSlots = new Set(),
  // Set when a queue drop follows the draw on the same day, so the closing
  // post hands the audience straight on to it.
  overText = null,
}) {
  const naming = await nameItems(items);
  const named = naming.items;
  const sets = setsOf(named);

  const posts = buildPosts({ items: named, sets, startsAt, endsAt });
  if (overText) {
    const over = posts.find((p) => p.slot === 'over');
    if (over) over.text = overText;
  }
  const altText = altTextFor({ items: named, startsAt });

  const report = { naming, sets, posts: [], wins: null, discord: discordPost({ items: named, sets, startsAt }) };

  for (const post of posts) {
    // The announcement is the only post that races anyone, so it can be set to
    // publish on its own while the rest of the set stays in drafts.
    const publishNow = liveSlots.has(post.slot);

    // A send time already in the past is rejected by Buffer, which would show
    // up as a failed post rather than an explained one. It happens whenever a
    // draw is detected after one of its anchors has passed, for example a draw
    // announced at noon on its own day, whose 9AM reminder can no longer run.
    if (!publishNow && post.dueAt && post.dueAt.toMillis() <= Date.now()) {
      report.posts.push({
        slot: post.slot,
        dueAt: post.dueAt,
        publishNow: false,
        skipped: 'its send time had already passed',
        results: [],
      });
      continue;
    }

    const results = await createOnDrawChannels({
      text: post.text,
      dueAt: post.dueAt ? post.dueAt.toUTC().toISO({ suppressMilliseconds: false }) : null,
      saveToDraft: asDraft && !publishNow,
      publishNow,
      imageUrl,
      altText,
    });

    for (const r of results) {
      if (r.ok && runId) {
        await recordBufferPost({ runId, slot: post.slot, channelId: r.channelId, bufferPostId: r.postId })
          .catch(() => {});
      }
    }
    report.posts.push({ slot: post.slot, dueAt: post.dueAt, publishNow, results });
  }

  // The wins post is PokemonFindr only and carries no image: HK sends it by
  // hand once wins actually start landing, which is never at a known time.
  const wins = await createOnDrawChannels(
    { text: winsPost(), dueAt: null, saveToDraft: true },
    [CHANNELS.pokemonfindr],
  );
  if (wins[0]?.ok && runId) {
    await recordBufferPost({ runId, slot: 'wins_draft', channelId: CHANNELS.pokemonfindr, bufferPostId: wins[0].postId })
      .catch(() => {});
  }
  report.wins = wins[0];

  const failed = report.posts.flatMap((p) => p.results).filter((r) => !r.ok).length;
  report.skipped = report.posts.filter((p) => p.skipped).length;
  if (runId && !failed) await markComplete(runId).catch(() => {});
  report.failed = failed;
  report.expected = report.posts.filter((p) => !p.skipped).length * DRAW_CHANNELS.length;

  return report;
}

/** A short human summary of what went to Buffer. */
export function summarise(report) {
  const lines = report.posts.map((p) => {
    if (p.skipped) return `  ${p.slot.padEnd(13)} skipped, ${p.skipped}`;
    const ok = p.results.filter((r) => r.ok).length;
    const when = p.publishNow
      ? 'PUBLISHED NOW'
      : p.dueAt ? p.dueAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma') : 'draft, no schedule';
    const errs = p.results.filter((r) => !r.ok).map((r) => r.error).join('; ');
    return `  ${p.slot.padEnd(13)} ${ok}/${p.results.length} ${when}${errs ? ` — ${errs}` : ''}`;
  });
  lines.push(`  ${'wins_draft'.padEnd(13)} ${report.wins?.ok ? '1/1 draft' : `0/1 — ${report.wins?.error ?? 'not attempted'}`}`);
  return lines.join('\n');
}
