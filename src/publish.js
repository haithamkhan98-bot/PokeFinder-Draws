import { nameItems, setsOf } from './naming.js';
import { buildPosts, winsPost, discordPost, altTextFor, orderedItems } from './copy.js';
import { createPost, createOnDrawChannels, CHANNELS, DRAW_CHANNELS } from './buffer.js';
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
  // Already named and ordered upstream, so the graphic and the posts share
  // one ordering. Naming here again would be a second API call for the same
  // answer.
  prenamed = null,
}) {
  const naming = prenamed ?? await nameItems(items);
  const named = orderedItems(naming.items);
  const sets = setsOf(named);

  // One post set per channel. The two X accounts both carry every draw, so
  // identical posts at identical times means anyone following both sees the
  // same tweet twice at the same minute.
  const plans = [
    { channelId: CHANNELS.pokemonfindr, posts: buildPosts({ items: named, sets, startsAt, endsAt, variant: 'default' }) },
    { channelId: CHANNELS.collectfinder, posts: buildPosts({ items: named, sets, startsAt, endsAt, variant: 'collectfinder' }) },
  ];
  if (overText) {
    for (const plan of plans) {
      const over = plan.posts.find((p) => p.slot === 'over');
      if (over) over.text = overText;
    }
  }
  const altText = altTextFor({ items: named, startsAt });

  const report = { naming, sets, posts: [], wins: null, discord: discordPost({ items: named, sets, startsAt }) };

  // Walked slot by slot rather than channel by channel, so the announcement
  // goes out on both accounts before anything else is created.
  const slots = plans[0].posts.map((p) => p.slot);
  for (const slot of slots) {
    const perChannel = plans.map((plan) => ({
      channelId: plan.channelId,
      post: plan.posts.find((p) => p.slot === slot),
    })).filter((x) => x.post);

    const publishNow = liveSlots.has(slot);
    const results = [];
    let anyDue = null;

    for (const { channelId, post } of perChannel) {
      anyDue = anyDue ?? post.dueAt;
      if (!publishNow && post.dueAt && post.dueAt.toMillis() <= Date.now()) {
        results.push({ channelId, ok: false, skipped: 'its send time had already passed' });
        continue;
      }
      try {
        const created = await createPost({
          channelId,
          text: post.text,
          dueAt: post.dueAt ? post.dueAt.toUTC().toISO({ suppressMilliseconds: false }) : null,
          saveToDraft: asDraft && !publishNow,
          publishNow,
          imageUrl,
          altText,
        });
        results.push({ channelId, ok: true, postId: created.id, status: created.status, dueAt: post.dueAt });
        if (runId) {
          await recordBufferPost({ runId, slot, channelId, bufferPostId: created.id }).catch(() => {});
        }
      } catch (err) {
        results.push({ channelId, ok: false, error: err.message });
      }
    }

    const allSkipped = results.length && results.every((r) => r.skipped);
    report.posts.push({
      slot,
      dueAt: anyDue,
      dueByChannel: Object.fromEntries(perChannel.map(({ channelId, post }) => [channelId, post.dueAt])),
      publishNow,
      skipped: allSkipped ? 'its send time had already passed' : undefined,
      results,
    });
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
  const clock = (d) => (d ? d.setZone('America/New_York').toFormat('h:mma') : 'no schedule');
  const lines = report.posts.map((p) => {
    if (p.skipped) return `  ${p.slot.padEnd(13)} skipped, ${p.skipped}`;
    const ok = p.results.filter((r) => r.ok).length;
    // The two channels no longer share a send time, so both are shown.
    const times = p.dueByChannel ? Object.values(p.dueByChannel) : [p.dueAt];
    const distinct = [...new Set(times.map((d) => (d ? d.toMillis() : 0)))];
    const when = p.publishNow
      ? 'PUBLISHED NOW'
      : distinct.length > 1
        ? `PF ${clock(times[0])} / CF ${clock(times[1])}`
        : p.dueAt ? p.dueAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma') : 'draft, no schedule';
    const errs = p.results.filter((r) => !r.ok).map((r) => r.error || r.skipped).filter(Boolean).join('; ');
    return `  ${p.slot.padEnd(13)} ${ok}/${p.results.length} ${when}${errs ? ` — ${errs}` : ''}`;
  });
  lines.push(`  ${'wins_draft'.padEnd(13)} ${report.wins?.ok ? '1/1 draft' : `0/1 — ${report.wins?.error ?? 'not attempted'}`}`);
  return lines.join('\n');
}
