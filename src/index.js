import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { DateTime } from 'luxon';
import { parseEmbed, DRAW_AUTHOR, isPostable } from './parse.js';
import { Batcher } from './batcher.js';
import { saveRun, pool, migrate, storeImage } from './db.js';
import { fetchAndTrim } from './image.js';
import { startServer, imageUrl, publicBaseUrl, setupKey } from './server.js';
import { buildDrawImage, MAX_ITEMS, headingFor } from './draw-image.js';
import { sampleItems } from './selftest.js';
import { publishRun, summarise } from './publish.js';
import { nameItems, setsOf } from './naming.js';
import { parseQueueEmbed, parsePotentialQueueEmbed, QUEUE_AUTHOR, groupQueue, orderedQueueItems } from './queue.js';
import { runQueue, summariseQueue, runPotentialQueue } from './queue-run.js';
import { saveQueueRun, queueRunOn } from './db.js';
import { buildQueuePosts, linkList, drawOverWithQueue } from './queue-copy.js';
import { buildGrid } from './grid.js';
import { queueHeadline } from './naming.js';
import { nextDropAt } from './queue.js';
import { buildPosts, winsPost, discordPost, buildDiscordPosts } from './copy.js';
import { startDiscordScheduler } from './discord-schedule.js';
import { scheduleDiscordPost } from './db.js';
import { isConnected as canvaConnected } from './canva.js';

const {
  DISCORD_TOKEN,
  WALMART_CHANNEL_ID,
  ALERT_CHANNEL_ID,
  QUIET_PERIOD_MS = 300_000,
  CEILING_MS = 1_200_000,
  DISCORD_MEMBER_CHANNEL_ID,
  DISCORD_MEMBER_ROLE_ID,
  QUEUE_ENABLED,
} = process.env;

// Discord only pings when given the role ID. The literal text "@PokeFinder+"
// renders as plain text and notifies nobody.
const ROLE_MENTION = DISCORD_MEMBER_ROLE_ID ? `<@&${DISCORD_MEMBER_ROLE_ID}>` : '@PokeFinder+';

for (const [k, v] of Object.entries({ DISCORD_TOKEN, WALMART_CHANNEL_ID, DATABASE_URL: process.env.DATABASE_URL })) {
  if (!v) { console.error(`missing required env var ${k}`); process.exit(1); }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel],
});

async function alert(text) {
  console.warn(text);
  if (!ALERT_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(ALERT_CHANNEL_ID);
    await ch?.send(text.slice(0, 1900));
  } catch (err) {
    console.error('could not post alert:', err.message);
  }
}

const batcher = new Batcher({
  quietMs: Number(QUIET_PERIOD_MS),
  ceilingMs: Number(CEILING_MS),
  onLate: async ({ drawDate, item }) => {
    await alert(
      `**Late item on draw ${drawDate}**\n`
      + `${item.productName} (${item.pid}) ${item.priceDisplay} arrived after the run had already fired.\n`
      + `From stage five this triggers the amend path. For now it needs handling by hand: `
      + `the draw image and the scheduled posts do not include it.`,
    );
  },
  onFire: async ({ drawDate, items, reason }) => {
    // Pokemon leads every post, so the run is ordered by category here and
    // everything downstream, the image slots included, follows that order.
    const RANK = { pokemon: 0, onepiece: 1, sports: 2, othertcg: 3 };
    const usable = items
      .filter((i) => isPostable(i.classification))
      .sort((a, b) => RANK[a.classification] - RANK[b.classification]);
    const skipped = items.filter((i) => !isPostable(i.classification));

    try {
      if (!usable.length) {
        await alert(
          `Draw ${drawDate}: ${items.length} item(s) detected, none of them card products. Nothing to post.\n`
          + skipped.map((i) => `  ${i.rawTitle} [${i.classification}]`).join('\n'),
        );
        return;
      }

      const startsAt = usable[0].startsAt.toISO();
      const endsAt = usable[0].endsAt.toISO();
      const res = await saveRun({ drawDate, items: usable, startsAt, endsAt });

      if (res.amend) {
        await alert(
          `Draw ${drawDate} already ran (status ${res.status}) and ${items.length} further item(s) just arrived. `
          + `This needs the amend path: the scheduled posts and the image are now out of date.`,
        );
        return;
      }

      // Host each product photo so later stages never hand Buffer a URL that
      // can expire. Failures here are reported but do not sink the run: the
      // items and the window are already recorded.
      const images = [];
      for (const item of usable) {
        if (!item.imageUrl) { images.push({ item, error: 'the embed carried no thumbnail' }); continue; }
        try {
          const { buffer, box, sourceBytes } = await fetchAndTrim(item.imageUrl);
          const id = await storeImage(buffer, {
            runId: res.runId, pid: item.pid, kind: 'product',
            width: box?.cropWidth ?? null, height: box?.cropHeight ?? null,
          });
          images.push({ item, id, url: imageUrl(id), box, sourceBytes, buffer });
        } catch (err) {
          images.push({ item, error: err.message });
        }
      }

      const imageLine = (entry) => {
        if (entry.error) return `  ${entry.item.pid} image failed: ${entry.error}`;
        const dims = entry.box ? `${entry.box.cropWidth}x${entry.box.cropHeight}` : 'untrimmed';
        return `  ${entry.item.pid} ${dims} ${entry.url ?? '(no public URL configured yet)'}`;
      };

      // The draw image. Every product photo is in hand at this point, so this
      // is the last step before Buffer: fill the layout that matches the item
      // count, then host the render here. Nothing downstream ever sees a
      // canva.com URL, because those expire long before a queued post sends.
      let drawImage = null;
      let drawImageError = null;
      const failedPhotos = images.filter((e) => e.error);

      if (failedPhotos.length) {
        drawImageError = `${failedPhotos.length} of ${usable.length} product photo(s) could not be fetched`;
      } else {
        try {
          drawImage = await buildDrawImage({
            runId: res.runId,
            drawDate,
            startsAt: usable[0].startsAt,
            items: images.map((e) => ({ ...e.item, buffer: e.buffer })),
          });
        } catch (err) {
          drawImageError = err.message;
        }
      }

      // Buffer. Only ever attempted once the image exists, because every post
      // in the set carries it and a post without it is not worth creating.
      let publish = null;
      let publishError = null;

      if (!drawImage) {
        publishError = 'skipped, because there is no draw image to attach';
      } else if (!process.env.BUFFER_TOKEN) {
        publishError = 'skipped, because BUFFER_TOKEN is not set';
      } else {
        try {
          // If a queue drop for this same day has already been collected, the
          // draw's closing post announces it instead of ending flat.
          let overText = null;
          const queued = await queueRunOn(drawDate).catch(() => null);
          if (queued?.items?.length) {
            overText = drawOverWithQueue({
              items: queued.items,
              dropAt: DateTime.fromJSDate(queued.dropsAt).setZone('America/New_York'),
            });
          }

          publish = await publishRun({
            runId: res.runId,
            overText,
            items: usable,
            startsAt: usable[0].startsAt,
            endsAt: usable[0].endsAt,
            imageUrl: drawImage.url,
            asDraft: process.env.BUFFER_LIVE !== 'true',
            // The announcement publishes immediately under BOTH flags. It has no
            // dueAt, so without this it would fall through to the Buffer queue
            // and wait for the next slot instead of going out now.
            liveSlots: new Set(
              process.env.BUFFER_LIVE === 'true'
                || process.env.BUFFER_LIVE_ANNOUNCEMENT === 'true' ? ['announcement'] : [],
            ),
          });
        } catch (err) {
          publishError = err.message;
        }
      }

      const lines = usable.map((i) => `  ${i.productName} (${i.pid}) ${i.priceDisplay}`).join('\n');
      const unknown = skipped.filter((i) => i.classification === 'unknown');
      const skippedNote = skipped.length
        ? `\nSkipped ${skipped.length}: ` + skipped.map((i) => `${i.rawTitle} [${i.classification}]`).join('; ')
          + (unknown.length
            ? `\n  ${unknown.length} of these were NOT RECOGNISED rather than deliberately dropped. `
              + `If any is a card product it should be in the posts, so tell Claude and the patterns get updated.`
            : '')
        : '';
      const suspect = usable.filter((i) => i.suspect).map((i) => `  ${i.pid}: ${i.suspect}`).join('\n');

      await alert(
        `**Draw run ready** ${drawDate} (fired on ${reason}, run #${res.runId})\n`
        + `Window: ${usable[0].startsAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma')} to `
        + `${usable[0].endsAt.setZone('America/New_York').toFormat('h:mma')} ET\n`
        + `Items:\n${lines}${skippedNote}`
        + `\nImages:\n${images.map(imageLine).join('\n')}`
        + `\nDraw image: ${drawImage
            ? `${drawImage.url ?? '(stored, but no public domain configured)'} `
              + `(${Math.round(drawImage.bytes / 1024)}KB, design ${drawImage.designId})`
              + (drawImage.omitted?.length
                ? `\n  ${drawImage.omitted.length} item(s) are in the posts but NOT in the image, `
                  + `because the largest template holds ${MAX_ITEMS}: `
                  + drawImage.omitted.map((i) => i.productName || i.rawTitle).join('; ')
                : '')
            : `not built. ${drawImageError}`}`
        + (suspect ? `\nWarnings:\n${suspect}` : '')
        + `\nPosts: ${publish
            ? `${publish.expected - publish.failed}/${publish.expected} created as `
              + `${process.env.BUFFER_LIVE === 'true' ? 'scheduled posts' : 'drafts'}`
              + `${publish.naming.note ? ` (naming: ${publish.naming.note})` : ''}\n${summarise(publish)}`
            : publishError}`,
      );
      // The member facing Discord posts. The announcement is due immediately;
      // the rest are written with their due times and sent by the scheduler.
      if (DISCORD_MEMBER_CHANNEL_ID) {
        try {
          const named = publish?.naming?.items ?? usable;
          const dposts = buildDiscordPosts({
            items: named,
            sets: publish?.sets ?? [],
            startsAt: usable[0].startsAt,
            endsAt: usable[0].endsAt,
            role: ROLE_MENTION,
          });

          for (const d of dposts) {
            if (d.dueAt && d.dueAt.toMillis() <= Date.now() && d.slot !== 'announcement') continue;
            await scheduleDiscordPost({
              runId: res.runId,
              slot: d.slot,
              channelId: DISCORD_MEMBER_CHANNEL_ID,
              dueAt: (d.dueAt ?? DateTime.now()).toUTC().toISO(),
              body: d.text,
            });
          }
          await alert(
            `Discord: ${dposts.length} member post(s) scheduled for ${drawDate}. `
            + `The announcement goes out within 30 seconds; the rest at 9AM, one minute before the `
            + `draw, and 30 minutes after it opens.`
            + (DISCORD_MEMBER_ROLE_ID ? '' : '\n  DISCORD_MEMBER_ROLE_ID is not set, so the role will NOT be pinged.'),
          );
        } catch (err) {
          await alert(`Draw ${drawDate}: the member Discord posts could not be scheduled: ${err.message}`);
        }
      } else if (publish?.discord) {
        await alert(`Discord post for ${drawDate}, ready to copy:\n\n${publish.discord}`);
      }
    } catch (err) {
      await alert(`Draw ${drawDate} failed while saving the run: ${err.message}`);
    }
  },
});

/**
 * The queue batcher.
 *
 * Separate from the draw batcher because the two are grouped on different
 * keys and produce different output, but the batching behaviour is identical:
 * queue embeds also land in one burst.
 */
const queueBatcher = new Batcher({
  quietMs: Number(QUIET_PERIOD_MS),
  ceilingMs: Number(CEILING_MS),
  keyOf: (item) => item.dropDate,
  onLate: async ({ drawDate, item }) => {
    await alert(
      `**Late queue item for the ${drawDate} drop**\n`
      + `${item.productName} (${item.pid}) ${item.priceDisplay} arrived after the run had fired, `
      + `so the posts and the grid do not include it.`,
    );
  },
  onFire: async ({ drawDate: dropDate, items, reason }) => {
    const usable = items.filter((i) => i.classification !== 'excluded');
    const dropped = items.filter((i) => i.classification === 'excluded');

    try {
      if (!usable.length) {
        await alert(`Queue drop ${dropDate}: ${items.length} item(s), all excluded. Nothing to post.`);
        return;
      }

      const dropAt = usable[0].dropAt;
      const res = await saveQueueRun({ dropDate, dropsAt: dropAt.toISO(), items: usable });
      if (res.amend) {
        await alert(`Queue drop ${dropDate} already ran (status ${res.status}) and more items arrived. Needs handling by hand.`);
        return;
      }

      if (!process.env.BUFFER_TOKEN) {
        await alert(`Queue drop ${dropDate}: ${usable.length} item(s) saved, but BUFFER_TOKEN is not set so nothing was posted.`);
        return;
      }

      const report = await runQueue({
        runId: res.runId,
        items: usable,
        dropAt,
        now: DateTime.now(),
        asDraft: process.env.BUFFER_LIVE !== 'true',
        publishAnnouncement: process.env.BUFFER_LIVE === 'true'
          || process.env.BUFFER_LIVE_ANNOUNCEMENT === 'true',
      });

      await alert(
        `**Queue run ready** ${dropDate} (fired on ${reason}, run #${res.runId})\n`
        + `Drop: ${dropAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma')} ET\n`
        + `Headline (${report.headline.source}): ${report.headline.headline}\n`
        + `Items: ${usable.length}`
        + (dropped.length ? `, ${dropped.length} excluded (${dropped.map((i) => i.rawTitle).join('; ')})` : '')
        + `\nGrid: ${report.image
            ? `${report.image.url} (${report.image.layout}, ${report.image.width}x${report.image.height})`
            : `not built. ${report.imageError}`}`
        + `\nAffiliate links: ${report.affiliate.covered}/${report.affiliate.total} came from the monitor`
        + (report.affiliate.covered < report.affiliate.total
          ? ', the rest fall back to plain PokeFinder links' : '')
        + `\nPosts:\n${summariseQueue(report)}`,
      );

      if (report.handoff?.attempted) {
        const ok = report.handoff.results.filter((r) => r.ok).length;
        await alert(
          `Draw closing post for ${dropDate} rewritten to announce the queue on `
          + `${ok}/${report.handoff.results.length} channel(s).`
          + (ok < report.handoff.results.length
            ? `\n  ${report.handoff.results.filter((r) => !r.ok).map((r) => r.error).join('; ')}`
            : ''),
        );
      }

      await alert(`Queue link list for ${dropDate}:\n\n${report.list}`);
    } catch (err) {
      await alert(`Queue drop ${dropDate} failed: ${err.message}`);
    }
  },
});

/**
 * The late queue batcher.
 *
 * Kept apart from the standard queue: these arrive minutes before the drop
 * rather than the day before, produce one draft rather than three live posts,
 * and must never be mixed into a standard run that may already have fired.
 */
const potentialBatcher = new Batcher({
  quietMs: Number(QUIET_PERIOD_MS),
  ceilingMs: Number(CEILING_MS),
  keyOf: (item) => `potential-${item.dropDate}`,
  onFire: async ({ items, reason }) => {
    const usable = items.filter((i) => i.classification !== 'excluded');
    const dropped = items.filter((i) => i.classification === 'excluded');
    try {
      if (!usable.length) {
        await alert(`Potential queue: ${items.length} item(s), all excluded. Nothing drafted.`);
        return;
      }
      if (!process.env.BUFFER_TOKEN) {
        await alert(`Potential queue: ${usable.length} item(s) detected, but BUFFER_TOKEN is not set.`);
        return;
      }

      const dropAt = usable[0].dropAt;
      const report = await runPotentialQueue({ items: usable, dropAt });
      const ok = report.results.filter((r) => r.ok).length;

      await alert(
        `**Potential queue draft ready** (fired on ${reason})\n`
        + `Drop: ${dropAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma')} ET\n`
        + `Items: ${usable.length}`
        + (dropped.length ? `, ${dropped.length} excluded` : '')
        + `\nGrid: ${report.image ? `${report.image.url} (${report.image.layout})` : `not built. ${report.imageError}`}`
        + `\nAffiliate links: ${report.affiliate.covered}/${report.affiliate.total} came from the monitor`
        + `\nDraft: ${ok}/${report.results.length} created, NOT published`
        + (report.results.some((r) => !r.ok)
          ? `\n  ${report.results.filter((r) => !r.ok).map((r) => r.error).join('; ')}` : '')
        + (report.thirdParty.length
          ? `\nSold by someone other than Walmart: ${report.thirdParty.join('; ')}` : ''),
      );
      await alert(`Potential queue draft text:\n\n${report.text}`);
    } catch (err) {
      await alert(`Potential queue run failed: ${err.message}`);
    }
  },
});

// Without these, a bad token or a dropped gateway connection is silent and the
// service just sits there looking healthy.
client.on(Events.Error, (err) => console.error('discord client error:', err.message));
client.on(Events.Warn, (msg) => console.warn('discord warning:', msg));

/**
 * `!drawtest [1-5]` in the alert channel.
 *
 * Builds a real draw image from stand in products, through the same code a
 * live draw uses: trim, pad, upload, autofill, export, store, serve. It exists
 * so the Canva path can be proved on demand rather than first discovered to be
 * broken during an actual draw. Nothing is written to draw_runs.
 */
async function drawTest(message, raw) {
  const n = Math.min(Math.max(parseInt(raw, 10) || 3, 1), MAX_ITEMS);

  // Deliberately NOT today at 5PM. That is word for word what sits in the
  // template as placeholder text, so a test using it could not tell a live
  // heading apart from a frozen one. Three days out at 12:30 also exercises
  // the ordinal and the non zero minutes.
  const startsAt = DateTime.now().setZone('America/New_York')
    .plus({ days: 3 })
    .set({ hour: 12, minute: 30, second: 0, millisecond: 0 });

  await message.reply(
    `Building a ${n} item test image. This usually takes under a minute.\n`
    + `The heading should read: ${headingFor(startsAt).replace('\n', ' / ')}`,
  );
  const began = Date.now();

  try {
    const items = await sampleItems(n);
    const built = await buildDrawImage({
      runId: null,
      drawDate: startsAt.toISODate(),
      startsAt,
      items,
    });
    await message.reply(
      `Test image built in ${((Date.now() - began) / 1000).toFixed(1)}s.\n`
      + `${built.url ?? '(stored, but no public domain configured)'}\n`
      + `${n} slot(s), source shapes ${items.map((i) => i.shape).join(', ')}, `
      + `${Math.round(built.bytes / 1024)}KB, design ${built.designId}\n`
      + `Every block should sit square in its slot with no part cut off, the prices should read `
      + `${items.map((i) => i.priceDisplay).join(', ')}, and the heading should read `
      + `"${headingFor(startsAt).replace('\n', ' / ')}" rather than the template's placeholder date.`,
    );
  } catch (err) {
    await message.reply(`Test image failed after ${((Date.now() - began) / 1000).toFixed(1)}s: ${err.message}`);
  }
}

/**
 * `!drawpreview [1-5]` in the alert channel.
 *
 * Composes the full post set from stand in products and prints it, without
 * touching Buffer or Canva. It is for reading the copy before trusting it to a
 * live draw, and for checking a wording change before it ships.
 */
async function drawPreview(message, raw) {
  const n = Math.min(Math.max(parseInt(raw, 10) || 2, 1), MAX_ITEMS);
  const startsAt = DateTime.now().setZone('America/New_York')
    .plus({ days: 3 }).set({ hour: 17, minute: 0, second: 0, millisecond: 0 });

  const stand = [
    { pid: 'p1', rawTitle: 'Pokemon TCG: Scarlet & Violet-Prismatic Evolutions Booster Bundle 2 Pack', productName: 'Prismatic Evolutions Booster Bundle 2 Pack', priceDisplay: '$79.94' },
    { pid: 'p2', rawTitle: 'Pokemon Trading Card Game: 30th Anniversary Elite Trainer Box', productName: '30th Anniversary Elite Trainer Box', priceDisplay: '$59.99' },
    { pid: 'p3', rawTitle: 'Pokemon TCG Mega Evolution Ascended Heroes Booster Bundle', productName: 'Ascended Heroes Booster Bundle', priceDisplay: '$26.94' },
    { pid: 'p4', rawTitle: 'Pokemon TCG: Destined Rivals Elite Trainer Box', productName: 'Destined Rivals Elite Trainer Box', priceDisplay: '$49.99' },
    { pid: 'p5', rawTitle: 'Pokemon TCG: Perfect Order Booster Bundle', productName: 'Perfect Order Booster Bundle', priceDisplay: '$31.88' },
  ].slice(0, n);

  try {
    const naming = await nameItems(stand);
    const sets = setsOf(naming.items);
    const posts = buildPosts({
      items: naming.items, sets, startsAt, endsAt: startsAt.plus({ hours: 1 }),
    });

    await message.reply(
      `Dry run, ${n} item(s). Nothing was sent to Buffer or Canva.\n`
      + `Naming came from the ${naming.source}${naming.note ? ` (${naming.note})` : ''}. `
      + `Sets: ${sets.join(', ') || 'none recognised'}.`,
    );

    for (const post of posts) {
      const when = post.dueAt
        ? post.dueAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma')
        : 'draft, no schedule';
      await message.channel.send(`**${post.slot}** (${when})\n\n${post.text}`.slice(0, 1990));
    }
    await message.channel.send(`**wins_draft** (draft, no schedule)\n\n${winsPost()}`.slice(0, 1990));
    await message.channel.send(
      `**Discord post**, ready to copy:\n\n${discordPost({ items: naming.items, sets, startsAt })}`.slice(0, 1990),
    );
  } catch (err) {
    await message.reply(`Preview failed: ${err.message}`);
  }
}

/**
 * `!queuepreview [1-8]` in the alert channel.
 *
 * Composes a whole queue run from stand in products across several games and
 * prints it, with the grid attached. Nothing reaches Buffer and nothing is
 * stored. It exists so the grouping, the ordering and the headline can be read
 * before a real drop is trusted to them.
 */
async function queuePreview(message, raw) {
  const n = Math.min(Math.max(parseInt(raw, 10) || 5, 1), 8);
  const dropAt = nextDropAt(DateTime.now());

  const STAND_IN = [
    ['Pokemon TCG: 30th Celebration Elite Trainer Box', 5999, 'pokemon'],
    ['Magic: The Gathering Star Trek Collector Booster Box', 24999, 'mtg'],
    ['2026 Topps Bowman Chrome Football Trading Cards Value Box', 2997, 'sports'],
    ['One Piece Card Game OP-11 Booster Box', 9588, 'onepiece'],
    ['Magic: The Gathering Star Trek Play Booster Box', 14999, 'mtg'],
    ['Pokemon TCG: Prismatic Evolutions Booster Bundle', 7994, 'pokemon'],
    ['2026 Panini Prizm Basketball Mega Box', 5999, 'sports'],
    ['2026 Upper Deck Series 1 Hockey Blaster', 2999, 'excluded'],
  ].slice(0, n);

  try {
    const photos = await sampleItems(Math.min(n, 5));
    const items = STAND_IN.map(([rawTitle, cents, game], i) => ({
      pid: `preview-${i + 1}`,
      rawTitle,
      productName: rawTitle,
      postName: rawTitle,
      priceCents: cents,
      priceDisplay: `$${(cents / 100).toFixed(2)}`,
      classification: game,
      buffer: photos[i % photos.length].buffer,
    }));

    const usable = items.filter((i) => i.classification !== 'excluded');
    const groups = groupQueue(usable);
    const ordered = orderedQueueItems(usable);
    const head = await queueHeadline(groups);
    const grid = await buildGrid(ordered);
    const posts = buildQueuePosts({ items: ordered, dropAt, headline: head.headline, now: DateTime.now() });

    await message.reply({
      content: `Dry run, ${usable.length} item(s), ${items.length - usable.length} excluded. `
        + `Nothing sent to Buffer.\n`
        + `Drop worked out as ${dropAt.toFormat('ccc LLL d')} at 9PM EST.\n`
        + `Headline came from the ${head.source}${head.note ? ` (${head.note})` : ''}.\n`
        + `Grid ${grid.counts.join('+')}, ${grid.width}x${grid.height}.`,
      files: [{ attachment: grid.buffer, name: `queue-grid-${ordered.length}.png` }],
    });

    for (const post of posts) {
      const when = post.dueAt
        ? post.dueAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma')
        : 'published immediately';
      await message.channel.send(`**${post.slot}** (${when})\n\n${post.text}`.slice(0, 1990));
    }
    await message.channel.send(`**Link list**\n\n${linkList(ordered)}`.slice(0, 1990));
  } catch (err) {
    await message.reply(`Queue preview failed: ${err.message}`);
  }
}

client.on(Events.MessageCreate, async (message) => {
  // The command branch only. The bot check must NOT cover the monitor channel:
  // the Walmart monitor posts as a bot, so filtering bots there would make the
  // service deaf to every draw.
  if (ALERT_CHANNEL_ID && message.channelId === ALERT_CHANNEL_ID) {
    if (message.author?.bot) return;
    const content = message.content?.trim() ?? '';

    const test = content.match(/^!drawtest(?:\s+(\d+))?$/i);
    if (test) { await drawTest(message, test[1]); return; }

    const preview = content.match(/^!drawpreview(?:\s+(\d+))?$/i);
    if (preview) { await drawPreview(message, preview[1]); return; }

    const qpreview = content.match(/^!queuepreview(?:\s+(\d+))?$/i);
    if (qpreview) { await queuePreview(message, qpreview[1]); return; }

    return;
  }

  if (message.channelId !== WALMART_CHANNEL_ID) return;
  if (!message.embeds?.length) return;

  for (const embed of message.embeds) {
    let item;
    try {
      item = parseEmbed(embed, { now: DateTime.now() });
    } catch (err) {
      await alert(`Could not parse an embed from ${message.url}: ${err.message}`);
      continue;
    }

    if (item === null) {
      // Not a draw. It may still be a queue item from the Droplist monitor,
      // which posts to this same channel.
      if (QUEUE_ENABLED !== 'true') continue;
      let q;
      try {
        q = parseQueueEmbed(embed, { now: DateTime.now() });
      } catch (err) {
        await alert(`Could not parse a queue embed from ${message.url}: ${err.message}`);
        continue;
      }
      if (q === null) {
        // The late queue comes through the restock monitor, flagged in its
        // title. Everything else from that monitor stays ignored.
        const pq = parsePotentialQueueEmbed(embed, { now: DateTime.now() });
        if (pq === null) continue;
        if (pq.error) {
          await alert(`A potential queue embed could not be read and was ignored: ${pq.error}\n${message.url}`);
          continue;
        }
        const pr = potentialBatcher.add(pq);
        console.log(`${pr.joined ? 'added' : 'repeat'} potential ${pq.pid} ${pq.productName} (${pr.size} held)`);
        continue;
      }
      if (q.error) {
        await alert(`A "${QUEUE_AUTHOR}" embed could not be read and was ignored: ${q.error}\n${message.url}`);
        continue;
      }
      const r = queueBatcher.add(q);
      console.log(
        `${r.joined ? 'added' : 'repeat'} queue ${q.pid} ${q.productName} -> drop ${q.dropDate} (${r.size} held)`,
      );
      continue;
    }

    if (item.error) {
      await alert(`A "${DRAW_AUTHOR}" embed could not be read and was ignored: ${item.error}\n${message.url}`);
      continue;
    }

    const { joined, size } = batcher.add(item);
    console.log(
      `${joined ? 'added' : 'repeat'} ${item.pid} ${item.productName} -> draw ${item.drawDate} (${size} item(s) held)`,
    );
  }
});

client.once(Events.ClientReady, (c) => {
  console.log(`listening as ${c.user.tag} on channel ${WALMART_CHANNEL_ID}`);
  if (DISCORD_MEMBER_CHANNEL_ID) {
    startDiscordScheduler(client, { onError: alert });
    console.log(`member draw posts will go to channel ${DISCORD_MEMBER_CHANNEL_ID}`
      + (DISCORD_MEMBER_ROLE_ID ? ` pinging role ${DISCORD_MEMBER_ROLE_ID}` : ' with NO role ping configured'));
  } else {
    console.log('DISCORD_MEMBER_CHANNEL_ID is not set, so no member draw posts will be sent');
  }
  console.log(QUEUE_ENABLED === 'true'
    ? 'queue monitoring is ON, Walmart Droplist embeds will be collected'
    : 'queue monitoring is OFF, set QUEUE_ENABLED=true to turn it on');
  console.log(`quiet period ${Number(QUIET_PERIOD_MS) / 1000}s, ceiling ${Number(CEILING_MS) / 1000}s`);
});

async function shutdown(signal) {
  console.log(`${signal} received, flushing ${batcher.pending().length} draw and `
    + `${queueBatcher.pending().length} queue run(s)`);
  batcher.flush();
  queueBatcher.flush();
  potentialBatcher.flush();
  setTimeout(async () => { await pool.end(); client.destroy(); process.exit(0); }, 2000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// The schema uses CREATE TABLE IF NOT EXISTS throughout, so running it on every
// boot is safe and means there is no separate migration step to remember.
try {
  await migrate();
  console.log('database schema is up to date');
  startServer();
  const base = publicBaseUrl();
  console.log(base
    ? `images will be served from ${base}/images/`
    : 'no public domain yet, so image URLs cannot be built. Generate one in Railway under Settings, Networking.');

  // Canva has to be authorised once, by hand, in a browser. Print the link
  // here rather than anywhere public, since this log is the only place the
  // setup key appears.
  if (process.env.CANVA_CLIENT_ID && base) {
    if (await canvaConnected().catch(() => false)) {
      console.log('canva is connected');
    } else {
      console.log('CANVA IS NOT CONNECTED YET. Open this once, in a browser, and approve:');
      console.log(`  ${base}/canva/connect?key=${setupKey}`);
    }
  }
} catch (err) {
  console.error('could not apply the database schema:', err.message);
  process.exit(1);
}

try {
  await client.login(DISCORD_TOKEN);
} catch (err) {
  console.error('could not log in to Discord:', err.message);
  console.error('this is almost always a bad or reset DISCORD_TOKEN');
  process.exit(1);
}
