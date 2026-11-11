import { Client, GatewayIntentBits, Partials, Events, PermissionsBitField } from 'discord.js';
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
import {
  buildPosts, winsPost, buildDiscordPosts, itemBlock, orderedPokemon, orderedItems, altTextFor,
} from './copy.js';
import { startDiscordScheduler } from './discord-schedule.js';
import { editPost, CHANNELS } from './buffer.js';
import {
  scheduleDiscordPost, latestDrawRun, updatePendingDiscordPost,
  addDrawItems, drawBufferPosts, setRunImage,
} from './db.js';
import { isConnected as canvaConnected } from './canva.js';
import { parseSummaryEmbed, SUMMARY_AUTHOR, nextPostAt, byRegion, parseStates, POST_HOUR } from './bestbuy.js';
import { bestbuyDigest } from './bestbuy-copy.js';
import { recordBestbuyItem, pendingBestbuyRun, retryBestbuyRun, reopenBestbuyRun, recentBestbuyRuns } from './db.js';
import { startBestbuyScheduler } from './bestbuy-schedule.js';
import { probeListing, formatProbe } from './target.js';
import { isRaffleEmbed, parseTargetRaffle, usableRaffleItems } from './target-raffle.js';
import { runTargetRaffle, summariseTarget } from './target-run.js';
import { tickTargetReminders, LEAD_MS } from './target-schedule.js';
import { tickReddit, queueRedditSet, summariseReddit } from './reddit-run.js';
import { latestRedditPost, getSecret, setSecret } from './db.js';
import {
  loadAffiliateLinks, summariseSheet, forgetSheet, missingLinksAlert, missingFingerprint, splitAlert, conflictAlert,
} from './sheet.js';

// Alerted once per process, not once per drop. A broken sheet URL would
// otherwise fire on every embed of every run.
let sheetWarned = false;
import { drawRedditPosts, queueRedditPosts, DRAW_SUBS, QUEUE_SUBS } from './reddit-copy.js';
import { openTargetRun, startTargetRun, addTargetItems, targetCloseTimeFor, setTargetRunCloseTime } from './db.js';

const {
  DISCORD_TOKEN,
  WALMART_CHANNEL_ID,
  ALERT_CHANNEL_ID,
  QUIET_PERIOD_MS = 300_000,
  CEILING_MS = 1_200_000,
  // The queue gets its own, longer quiet period. A draw is a race, so that one
  // runs short to get the announcement out first. A queue drop is announced the
  // night before, so there is nothing to race: waiting longer to be sure every
  // Droplist embed has landed costs nothing, and firing early now means a
  // PUBLISHED post missing items, with the stragglers hitting the amend path.
  QUEUE_QUIET_PERIOD_MS = 300_000,
  TARGET_CHANNEL_ID,
  TARGET_ENABLED,
  TARGET_LIVE,
  // Longer again than the queue's. Target raffle listings appear one at a
  // time over several minutes rather than in a burst, and unlike a queue drop
  // there is no deadline to race: the draw is already open and runs for days,
  // so waiting costs nothing and firing early splits one draw into two runs.
  TARGET_QUIET_PERIOD_MS = 600_000,
  TARGET_TICK_MS = 300_000,
  REDDIT_ENABLED,
  // 'manual' drops each post in the alert channel formatted to paste.
  // 'api' submits it, and needs credentials Reddit no longer issues to new
  // developers, so manual is the default.
  REDDIT_MODE = 'manual',
  // Slower than the Discord poll on purpose. Reddit rates submissions per
  // account and nothing here is to the minute: the announcement is queued due
  // immediately and a minute's lateness on a reminder costs nothing.
  REDDIT_TICK_MS = 60_000,
  // Who to @ when SKUs are missing affiliate links. A Discord user ID; without
  // it the alert still goes out, just without the ping.
  ALERT_USER_ID,
  // The sheet itself, linked in the missing links alert so everything needed
  // is in one message.
  WALMART_SHEET_URL,
  DISCORD_MEMBER_CHANNEL_ID,
  DISCORD_MEMBER_ROLE_ID,
  QUEUE_ENABLED,
  QUEUE_LIVE,
  // How far back a repeated queue item still counts as last week's.
  QUEUE_REPEAT_DAYS = 35,
  BESTBUY_CHANNEL_ID,
  BESTBUY_ALERT_CHANNEL_ID,
  BESTBUY_CHECKER_CHANNEL_ID,
  BESTBUY_ENABLED,
  BESTBUY_LIVE,
} = process.env;

/**
 * Is an env flag on?
 *
 * These used to be compared against the exact string 'true', which cost a
 * morning of BestBuy digests: BESTBUY_LIVE was set, but not to a value that
 * matched, and the bot reported itself as off while saying nothing about why.
 * Anything a person means by yes is accepted now, and `flagRaw` reports what
 * was actually read so a mistyped NAME is visible too.
 */
export const flag = (v) => ['true', '1', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const flagRaw = (v) => (v === undefined ? 'not set' : `"${v}"`);

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

/**
 * Post text to the alert channel inside a code fence, so it can be lifted out
 * of Discord by copying rather than retyped.
 *
 * A fence leaves `<@&id>` and `<#id>` as the literal text a paste needs, which
 * is also why a copy block can never ping anybody: nothing in it renders.
 *
 * Discord caps a message at 2000 characters and the fence itself costs eight,
 * so a long body is split on line boundaries rather than cut off. Half an
 * announcement is no use to paste.
 */
async function alertBlock(label, text) {
  const body = String(text ?? '');
  if (!ALERT_CHANNEL_ID) { console.warn(`${label}:\n${body}`); return; }

  const LIMIT = 1900;
  const chunks = [];
  let current = '';
  for (const line of body.split('\n')) {
    let rest = line;
    do {
      // A single line longer than the limit has no boundary to split on, so
      // it is cut. Nothing in these posts is that long; this is a guard.
      const piece = rest.slice(0, LIMIT);
      rest = rest.slice(LIMIT);
      if (current && current.length + piece.length + 1 > LIMIT) {
        chunks.push(current);
        current = '';
      }
      current = current ? `${current}\n${piece}` : piece;
    } while (rest.length);
  }
  if (current) chunks.push(current);

  try {
    const ch = await client.channels.fetch(ALERT_CHANNEL_ID);
    for (const [idx, chunk] of chunks.entries()) {
      const heading = chunks.length > 1 ? `${label} (${idx + 1}/${chunks.length})` : label;
      await ch?.send({
        content: `${heading}:\n\`\`\`\n${chunk}\n\`\`\``,
        // Belt and braces. The fence already stops any of it rendering.
        allowedMentions: { parse: [] },
      });
    }
  } catch (err) {
    console.error('could not post copy block:', err.message);
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

      // Naming runs here rather than inside publishRun, because the graphic is
      // built first and the set names are what the ordering depends on.
      // Without this the grid came out in monitor arrival order while the
      // written list was sorted, so the two disagreed.
      const drawNaming = await nameItems(usable);
      const drawOrdered = orderedItems(drawNaming.items);
      const photoByPid = new Map(images.map((e) => [e.item.pid, e]));

      if (failedPhotos.length) {
        drawImageError = `${failedPhotos.length} of ${usable.length} product photo(s) could not be fetched`;
      } else {
        try {
          drawImage = await buildDrawImage({
            runId: res.runId,
            drawDate,
            startsAt: usable[0].startsAt,
            items: drawOrdered.map((i) => ({ ...i, buffer: photoByPid.get(i.pid)?.buffer })),
          });
        } catch (err) {
          drawImageError = err.message;
        }
      }

      // Buffer. Only ever attempted once the image exists, because every post
      // in the set carries it and a post without it is not worth creating.
      let publish = null;
      let publishError = null;
      let redditQueued = null;
      let redditError = null;

      if (!drawImage) {
        publishError = 'skipped, because there is no draw image to attach';
      } else if (!process.env.BUFFER_TOKEN) {
        publishError = 'skipped, because BUFFER_TOKEN is not set';
      } else {
        try {
          // If a queue drop for this same day has already been collected, the
          // draw's closing post announces it instead of ending flat.
          let overText = null;
          // Only when queue posting is live. While the queue is in drafts its
          // wording must not reach a real draw post.
          const queued = flag(QUEUE_LIVE) ? await queueRunOn(drawDate).catch(() => null) : null;
          if (queued?.items?.length) {
            overText = drawOverWithQueue({
              items: queued.items,
              dropAt: DateTime.fromJSDate(queued.dropsAt).setZone('America/New_York'),
            });
          }

          publish = await publishRun({
            runId: res.runId,
            overText,
            prenamed: drawNaming,
            items: usable,
            startsAt: usable[0].startsAt,
            endsAt: usable[0].endsAt,
            imageUrl: drawImage.url,
            asDraft: !flag(process.env.BUFFER_LIVE),
            // The announcement publishes immediately under BOTH flags. It has no
            // dueAt, so without this it would fall through to the Buffer queue
            // and wait for the next slot instead of going out now.
            liveSlots: new Set(
              flag(process.env.BUFFER_LIVE)
                || flag(process.env.BUFFER_LIVE_ANNOUNCEMENT) ? ['announcement'] : [],
            ),
          });
        } catch (err) {
          publishError = err.message;
        }

        // Reddit is queued separately from Buffer and after it, so a Reddit
        // problem can never stop the tweets. It is also gated on its own flag:
        // the X and Discord paths going live does not mean the subs should
        // start getting posts.
        if (flag(REDDIT_ENABLED)) {
          try {
            redditQueued = await queueRedditSet({
              source: 'draw',
              runId: res.runId,
              posts: drawRedditPosts({
                items: publish?.naming?.items ?? usable,
                sets: publish?.sets ?? [],
                startsAt: usable[0].startsAt,
                endsAt: usable[0].endsAt,
                now: DateTime.now(),
                imageUrl: drawImage.url,
              }),
            });
          } catch (err) {
            redditError = err.message;
          }
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
              + `${flag(process.env.BUFFER_LIVE) ? 'scheduled posts' : 'drafts'}`
              + `${publish.naming.note ? ` (naming: ${publish.naming.note})` : ''}\n${summarise(publish)}`
            : publishError}`
        + (flag(REDDIT_ENABLED)
            ? `\nReddit:\n${redditError ? `  not queued. ${redditError}` : summariseReddit(redditQueued ?? [])}`
            : ''),
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
              imageUrl: drawImage?.url ?? null,
            });
          }
          await alert(
            `Discord: ${dposts.length} member post(s) scheduled for ${drawDate}. `
            + `The announcement goes out within 30 seconds; the rest at 9AM, one minute before the `
            + `draw, and 30 minutes after it opens.`
            + (DISCORD_MEMBER_ROLE_ID ? '' : '\n  DISCORD_MEMBER_ROLE_ID is not set, so the role will NOT be pinged.'),
          );
          // The announcement again, as plain text. The scheduler has already
          // sent the real one to members; this copy is here to be lifted and
          // pasted somewhere else without being retyped.
          const announcement = dposts.find((d) => d.slot === 'announcement');
          if (announcement) {
            await alertBlock(`**Discord announcement** for ${drawDate}, ready to copy`, announcement.text);
          }
        } catch (err) {
          await alert(`Draw ${drawDate}: the member Discord posts could not be scheduled: ${err.message}`);
        }
      } else if (publish?.discord) {
        await alertBlock(`**Discord post** for ${drawDate}, ready to copy`, publish.discord);
      }
    } catch (err) {
      await alert(`Draw ${drawDate} failed while saving the run: ${err.message}`);
    }
  },
});

/**
 * The queue batcher.
 *
 * Separate from the draw batcher because the two are grouped on different keys,
 * produce different output, and wait for different lengths of time. Droplist
 * embeds are less consistent than draw embeds and can trickle in rather than
 * arrive in one burst, so this one waits QUEUE_QUIET_PERIOD_MS.
 */
/**
 * Target raffle listings into one run.
 *
 * Keyed on a constant rather than a date. A Walmart draw belongs to the day it
 * opens; a Target draw is a window with no such key, and every raffle listing
 * seen while one is open belongs to it.
 */
const targetBatcher = new Batcher({
  quietMs: Number(TARGET_QUIET_PERIOD_MS),
  ceilingMs: Number(CEILING_MS),
  keyOf: () => 'target',
  onLate: async ({ item }) => {
    // Not a problem here, unlike the queue. A Target draw stays open, so a
    // late listing joins the run and shows up in the next reminder.
    await alert(`Target raffle listing arrived after the run fired: ${item.productName} (${item.tcin}). `
      + 'It has joined the open run and will appear in the next reminder.');
  },
  onFire: async ({ items, reason }) => {
    try {
      const usable = usableRaffleItems(items);
      const dropped = items.filter((i) => i.classification === 'excluded');
      if (!usable.length) {
        await alert(`Target raffle fired on ${reason} with nothing postable.`
          + (dropped.length ? ` ${dropped.length} excluded: ${dropped.map((i) => i.rawTitle).join('; ')}` : ''));
        return;
      }

      let run = await openTargetRun();
      const joining = Boolean(run);
      if (!run) run = await startTargetRun({});
      const added = await addTargetItems(run.id, usable);

      // The close time may already be known from an earlier bookmarklet click
      // on any listing in this draw.
      if (!run.closes_at) {
        const found = await targetCloseTimeFor(usable.map((i) => i.tcin));
        if (found) {
          await setTargetRunCloseTime(run.id, found.closes_at);
          run.closes_at = found.closes_at;
        }
      }
      const closesAt = run.closes_at ? DateTime.fromJSDate(new Date(run.closes_at)) : null;

      if (joining) {
        // The announcement already went out. Do not post again; the next
        // reminder rebuilds from the run and will carry these.
        await alert(`**Target draw updated** (run #${run.id}, fired on ${reason})\n`
          + `${added.length} new listing(s) joined: ${added.join(', ') || 'none'}\n`
          + 'The announcement already went out, so nothing was posted. The next reminder will carry them.');
        return;
      }

      if (!process.env.BUFFER_TOKEN) {
        await alert(`Target draw #${run.id}: ${usable.length} listing(s) saved, but BUFFER_TOKEN is not set so nothing was posted.`);
        return;
      }

      const report = await runTargetRaffle({
        runId: run.id,
        now: DateTime.now(),
        closesAt,
        asDraft: !flag(TARGET_LIVE),
        publishLive: flag(TARGET_LIVE),
        // Member posts only once the whole path is live. Drafts are for
        // reading in Buffer; a Discord ping cannot be taken back.
        discordChannelId: flag(TARGET_LIVE) ? (DISCORD_MEMBER_CHANNEL_ID ?? null) : null,
        discordRole: DISCORD_MEMBER_ROLE_ID ? `<@&${DISCORD_MEMBER_ROLE_ID}>` : '@PokeFinder+',
        reddit: flag(REDDIT_ENABLED),
      });

      await alert(
        `**Target draw ready** (run #${run.id}, fired on ${reason})\n`
        + (flag(TARGET_LIVE) ? '' : 'DRAFTS ONLY. Nothing is published or scheduled. Set TARGET_LIVE=true to go live.\n')
        + `Headline: ${report.headline}\n`
        + `Listings: ${report.items}`
        + (dropped.length ? `, ${dropped.length} excluded (${dropped.map((i) => i.rawTitle).join('; ')})` : '')
        + `\nCloses: ${closesAt ? closesAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma') + ' ET' : 'UNKNOWN. Click the bookmarklet on any listing to set it, or the two reminders cannot be scheduled.'}`
        + `\nAffiliate links: ${report.affiliate.covered}/${report.affiliate.total} from the monitor`
        + (report.affiliate.covered < report.affiliate.total ? ', the rest fall back to plain PokeFinder links' : '')
        + `\nPosts:\n${summariseTarget(report)}`,
      );
    } catch (err) {
      await alert(`Target raffle run failed: ${err.message}`);
    }
  },
});

const queueBatcher = new Batcher({
  quietMs: Number(QUEUE_QUIET_PERIOD_MS),
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
      const holiday = holidayOn(dropDate);

      // Walmart's monitor pings an item when it LEAVES the queue as well as
      // when it joins, and the two embeds are identical in every field. So a
      // drop arrives mixed with the previous week's items being cleared out:
      // one real run of four came through as fifteen.
      //
      // Three independent signals separate them, and none is trusted alone.
      // The first arrival burst is always kept, because Walmart does re-queue
      // products and such an item arrived WITH the real drop. A later burst is
      // dropped only on evidence: seen in a recent queue, or sitting on the
      // live queue page right now, which means it is in the queue that is
      // running rather than the one coming.
      let selection = null;
      let fresh = usable;
      try {
        const [previousPids, livePageIds] = await Promise.all([
          previousQueuePids({ beforeDropDate: dropDate, days: Number(QUEUE_REPEAT_DAYS) }),
          queuePageIds(),
        ]);
        selection = selectDropItems(usable, { previousPids, livePageIds });
        fresh = selection.kept;
        if (!livePageIds) {
          console.log('queue page could not be read, so only history and arrival order were used');
        }
      } catch (err) {
        // Every item is kept. Posting a drop with extra items beats posting
        // nothing, and the alert says the filter did not run.
        await alert(`Could not work out which queue items are real, so all ${usable.length} are included: ${err.message}`);
      }

      if (!fresh.length) {
        await alert(
          `**Queue drop ${dropDate}: nothing new.** All ${usable.length} item(s) look like a `
          + "clear-out of an earlier queue rather than a new drop, so nothing was posted.\n"
          + (selection ? explainSelection(selection) : ''),
        );
        return;
      }

      const res = await saveQueueRun({ dropDate, dropsAt: dropAt.toISO(), items: fresh });
      if (res.amend) {
        await alert(`Queue drop ${dropDate} already ran (status ${res.status}) and more items arrived. Needs handling by hand.`);
        return;
      }

      if (!process.env.BUFFER_TOKEN) {
        await alert(`Queue drop ${dropDate}: ${fresh.length} item(s) saved, but BUFFER_TOKEN is not set so nothing was posted.`);
        return;
      }

      const report = await runQueue({
        runId: res.runId,
        items: fresh,
        dropAt,
        now: DateTime.now(),
        // Queue posts have their own flag. BUFFER_LIVE is the draws' and is
        // already on; the queue stays in drafts until QUEUE_LIVE says
        // otherwise, so the first real run can be checked before it posts.
        // A drop dated onto a federal holiday is almost certainly not
        // happening that day. Walmart moved the November 2026 queue from
        // Wednesday the 11th to Thursday the 12th for Veterans Day, and said
        // so nowhere the bot can see: the embeds carry no date at all, so the
        // run was dated by the bot's own "next Wednesday" rule.
        //
        // The bot cannot know the real date, so it does the one safe thing and
        // refuses to publish, leaving drafts and saying why.
        asDraft: !flag(QUEUE_LIVE) || Boolean(holiday),
        publishAnnouncement: flag(QUEUE_LIVE) && !holiday,
      });

      // Same ordering as the draws: after Buffer, on its own flag, and a
      // failure here is reported rather than thrown.
      let queueReddit = null;
      let queueRedditError = null;
      if (flag(REDDIT_ENABLED)) {
        try {
          queueReddit = await queueRedditSet({
            source: 'queue',
            runId: res.runId,
            posts: queueRedditPosts({
              items: report.naming?.items ?? fresh,
              dropAt,
              headline: report.headline.headline,
              now: DateTime.now(),
              imageUrl: report.image?.url ?? null,
            }),
          });
        } catch (err) {
          queueRedditError = err.message;
        }
      }

      await alert(
        `**Queue run ready** ${dropDate} (fired on ${reason}, run #${res.runId})\n`
        + (flag(QUEUE_LIVE) ? '' : 'DRAFTS ONLY. Nothing is scheduled or published and the '
          + 'draw closing post was not touched. Set QUEUE_LIVE=true to go live.\n')
        + (holiday
          ? `**HELD AS DRAFTS: ${dropDate} is ${holiday}.** Walmart usually moves a drop off a `
            + 'federal holiday, and the embeds carry no date, so this run was dated by the next '
            + 'Wednesday rule rather than by anything Walmart said. Check the real date and the '
            + 'real item list on the queue page, then correct the drafts before sending.\n'
          : '')
        + `Drop: ${dropAt.setZone('America/New_York').toFormat('ccc LLL d, h:mma')} ET\n`
        + `Headline (${report.headline.source}): ${report.headline.headline}\n`
        + (selection && selection.dropped.length
          ? `\n**${selection.dropped.length} of ${usable.length} item(s) dropped** as last week's `
            + `being cleared out, across ${selection.clusters} arrival burst(s). `
            + 'If any belong in this drop, say so and they go back in.\n'
            + explainSelection(selection)
          : '')
        + `\nItems: ${fresh.length}`
        + (dropped.length ? `, ${dropped.length} excluded (${dropped.map((i) => i.rawTitle).join('; ')})` : '')
        + `\nGrid: ${report.image
            ? `${report.image.url} (${report.image.layout}, ${report.image.width}x${report.image.height})`
            : `not built. ${report.imageError}`}`
        + (flag(REDDIT_ENABLED)
            ? `\nReddit:\n${queueRedditError ? `  not queued. ${queueRedditError}` : summariseReddit(queueReddit ?? [])}`
            : '')
        + `\nAffiliate links: ${report.affiliate.covered}/${report.affiliate.total} came from the monitor`
        + (report.affiliate.covered < report.affiliate.total
          ? ', the rest fall back to plain PokeFinder links' : '')
        + `\nPosts:\n${summariseQueue(report)}`,
      );

      if (report.handoff?.dryRun) {
        await alert(
          `Draw closing post for ${dropDate} was NOT rewritten, because queue posts are drafts.\n`
          + `This is the text it would have written:\n\n${report.handoff.text}`,
        );
      } else if (report.handoff?.attempted) {
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
  // Deliberately the SHORT draw period, not the queue's. These are announced
  // 10 to 20 minutes before the drop, so a long wait would miss the window.
  quietMs: Number(QUIET_PERIOD_MS),
  ceilingMs: Number(CEILING_MS),
  keyOf: (item) => `potential-${item.dropDate}`,
  onFire: async ({ items, reason }) => {
    const usable = items.filter((i) => i.classification !== 'excluded');
    const dropped = items.filter((i) => i.classification === 'excluded');
    try {
      if (!fresh.length) {
        await alert(`Potential queue: ${items.length} item(s), all excluded. Nothing drafted.`);
        return;
      }
      if (!process.env.BUFFER_TOKEN) {
        await alert(`Potential queue: ${fresh.length} item(s) detected, but BUFFER_TOKEN is not set.`);
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
    const endsAt = startsAt.plus({ hours: 1 });
    // Both accounts, because they no longer run on the same clock. Previewing
    // one of them would hide every CollectFinder time and both of its reworded
    // reminders.
    const pf = buildPosts({ items: naming.items, sets, startsAt, endsAt, variant: 'default' });
    const cf = buildPosts({ items: naming.items, sets, startsAt, endsAt, variant: 'collectfinder' });
    const when = (dt) => (dt
      ? dt.setZone('America/New_York').toFormat('ccc LLL d, h:mma')
      : 'draft, no schedule');

    await message.reply(
      `Dry run, ${n} item(s). Nothing was sent to Buffer or Canva.\n`
      + `Naming came from the ${naming.source}${naming.note ? ` (${naming.note})` : ''}. `
      + `Sets: ${sets.join(', ') || 'none recognised'}.`,
    );

    for (const [idx, post] of pf.entries()) {
      const twin = cf[idx];
      // Most slots are word for word the same on both accounts and differ only
      // in when they send, so one copy carrying both times keeps this readable.
      // The two reminders whose wording differs are printed twice.
      if (twin && twin.text === post.text) {
        await message.channel.send(
          `**${post.slot}** (PF ${when(post.dueAt)} / CF ${when(twin.dueAt)})\n\n${post.text}`.slice(0, 1990),
        );
      } else {
        await message.channel.send(
          `**${post.slot}** PokemonFindr (${when(post.dueAt)})\n\n${post.text}`.slice(0, 1990),
        );
        if (twin) {
          await message.channel.send(
            `**${twin.slot}** CollectFinder (${when(twin.dueAt)})\n\n${twin.text}`.slice(0, 1990),
          );
        }
      }
    }
    await message.channel.send(`**wins_draft** (draft, no schedule)\n\n${winsPost()}`.slice(0, 1990));

    // The member posts as plain text. These are the bodies the scheduler
    // stores, not a separate rendering of them, so what prints here is what
    // members get.
    for (const d of buildDiscordPosts({ items: naming.items, sets, startsAt, endsAt, role: ROLE_MENTION })) {
      await alertBlock(`**Discord ${d.slot}** (${when(d.dueAt)}), ready to copy`, d.text);
    }
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

/**
 * `!bbpreview` shows the digest without sending anything to members.
 *
 * With no argument it uses whatever the monitor has actually banked for the
 * next 7AM slot, which is the real thing. With a number it falls back to
 * stand in products so the formatting can be checked on a night when no
 * summary has arrived.
 *
 * Mentions are suppressed on the reply, so the role pill is visible in the
 * preview but nobody is pinged by it.
 */
async function bestbuyPreview(message, raw) {
  const role = DISCORD_MEMBER_ROLE_ID ? `<@&${DISCORD_MEMBER_ROLE_ID}>` : '@PokeFinder+';
  const checkerChannel = BESTBUY_CHECKER_CHANNEL_ID
    ? `<#${BESTBUY_CHECKER_CHANNEL_ID}>` : '#bestbuy-instore-check';

  const STAND_IN = [
    ['Pokémon - Trading Card Game: 30th Celebration Elite Trainer Box', '$49.99',
      'California [536]\nIllinois [326]\nOhio [175]', 'Texas [460]\nNew Jersey [227]\nFlorida [67]'],
    ['Pokémon - Trading Card Game: Scarlet & Violet Destined Rivals Elite Trainer Box', '$49.99',
      'California [242]\nFlorida [79]\nMaine [8]', 'Texas [102]\nNew Jersey [65]\nOhio [60]'],
    ['Pokémon - Trading Card Game: 30th Celebration Poster Collection', '$14.99',
      'California [482]\nIllinois [291]', 'Texas [342]\nOhio [227]'],
    ['2026 Topps Bowman Chrome Football Trading Cards Value Box', '$29.97',
      'Texas [120]\nArizona [40]', 'California [95]\nNew York [30]'],
    ['Pokemon Pikachu Plush 8in', '$14.97', 'California [50]', 'Texas [40]'],
  ];

  try {
    let items;
    let source;
    const n = parseInt(raw, 10);

    if (!n) {
      const run = await pendingBestbuyRun();
      if (run?.items?.length) {
        items = run.items;
        source = `the ${run.items.length} item(s) banked for ${run.post_date}`
          + (run.attempts
            ? `, which has FAILED ${run.attempts} time(s): ${run.error ?? 'no error recorded'}`
            : '');
      }
    }

    if (!items) {
      const take = Math.min(Math.max(n || 4, 1), STAND_IN.length);
      items = STAND_IN.slice(0, take).map(([rawTitle, priceDisplay, a, b], i) => {
        const { stock } = parseStates(a, b);
        return {
          sku: `preview-${i + 1}`,
          rawTitle,
          priceDisplay,
          units: Object.values(stock).reduce((x, y) => x + y, 0),
          states: Object.keys(stock).length,
          stock,
          regions: byRegion(stock),
          merch: /plush/i.test(rawTitle),
        };
      });
      source = `${items.length} stand in product(s), because nothing is banked`;
    }

    const naming = await nameItems(items.map((i, idx) => ({ ...i, pid: i.sku ?? String(idx) })));
    const digest = bestbuyDigest({ items: naming.items, role, checkerChannel });
    const postAt = nextPostAt(DateTime.now());

    if (!digest) {
      await message.reply(`Dry run from ${source}. Nothing postable, so no digest would be sent.`);
      return;
    }

    const dropped = items.length - digest.items.length;
    await message.reply(
      `Dry run from ${source}. Nothing sent to members.\n`
      + `Would post ${postAt.toFormat('ccc LLL d, h:mma ZZZZ')} to `
      + `${BESTBUY_ALERT_CHANNEL_ID ? `<#${BESTBUY_ALERT_CHANNEL_ID}>` : 'the instore alerts channel'}.\n`
      + `${digest.items.length} product(s)`
      + (dropped ? `, ${dropped} filtered as merchandise` : '')
      + `, ${digest.text.length} chars, ${digest.form} form.`,
    );
    await message.channel.send({
      content: digest.text.slice(0, 1990),
      // The preview must never ping the role.
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    await message.reply(`BestBuy preview failed: ${err.message}`);
  }
}

/**
 * `!bbscan` reads the monitor channel and reports what the parser makes of it.
 *
 * Built because a silent morning has three possible causes that look
 * identical from the outside: the bot cannot see the channel, no summary was
 * posted, or the parser does not recognise the embeds. This separates them
 * without waiting for another night. It writes nothing.
 */
async function bestbuyScan(message, raw) {
  if (!BESTBUY_CHANNEL_ID) {
    await message.reply('BESTBUY_CHANNEL_ID is not set, so there is no channel to scan.');
    return;
  }
  const limit = Math.min(Math.max(parseInt(raw, 10) || 50, 1), 100);

  try {
    const channel = await client.channels.fetch(BESTBUY_CHANNEL_ID);
    if (!channel?.isTextBased?.()) {
      await message.reply(`Channel ${BESTBUY_CHANNEL_ID} is not a text channel the bot can read.`);
      return;
    }

    const fetched = await channel.messages.fetch({ limit });
    const lines = [];
    let embeds = 0;
    let matched = 0;
    const skipped = new Map();
    const errors = [];
    let newest = null;

    for (const m of fetched.values()) {
      if (!newest || m.createdTimestamp > newest) newest = m.createdTimestamp;
      for (const embed of m.embeds ?? []) {
        embeds += 1;
        const author = embed?.author?.name?.trim() ?? '(no author)';
        const type = (embed?.fields ?? []).find(
          (f) => String(f?.name ?? '').trim().toLowerCase() === 'type',
        )?.value ?? '(no Type field)';

        const item = parseSummaryEmbed(embed, { now: DateTime.now() });
        if (item === null) {
          const why = author !== SUMMARY_AUTHOR
            ? `author is "${author}"` : `Type is "${type}"`;
          skipped.set(why, (skipped.get(why) ?? 0) + 1);
          continue;
        }
        if (item.error) { errors.push(`${item.title ?? '(no title)'}: ${item.error}`); continue; }
        matched += 1;
        if (lines.length < 25) {
          lines.push(`${item.sku}  ${item.units} units / ${item.states} states  ${item.rawTitle.slice(0, 70)}`
            + (item.unknownStates.length ? `  [unmapped: ${item.unknownStates.join(', ')}]` : ''));
        }
      }
    }

    const ago = newest
      ? DateTime.fromMillis(newest).setZone('America/New_York').toFormat('ccc LLL d, h:mma')
      : 'never';

    await message.reply(
      `Scanned the last ${fetched.size} message(s) in <#${BESTBUY_CHANNEL_ID}>. `
      + `Newest message ${ago}.\n`
      + `${embeds} embed(s): **${matched} parsed as Daily Summaries**, `
      + `${[...skipped.values()].reduce((a, b) => a + b, 0)} skipped, ${errors.length} unreadable.`
      + (skipped.size ? `\n\nSkipped because:\n${[...skipped].map(([w, n]) => `  ${n} x ${w}`).join('\n')}` : '')
      + (errors.length ? `\n\nUnreadable:\n${errors.slice(0, 5).join('\n')}` : '')
      + (lines.length ? `\n\nParsed:\n\`\`\`\n${lines.join('\n')}\n\`\`\`` : ''),
    );
  } catch (err) {
    await message.reply(
      `Could not scan <#${BESTBUY_CHANNEL_ID}>: ${err.message}\n`
      + 'If this is a permissions error the bot cannot see the monitor channel, '
      + 'which would also explain why nothing is ever banked.',
    );
  }
}

/** `!bbretry` puts a run the ticker gave up on back in the queue. */
async function bestbuyRetry(message) {
  try {
    const run = await pendingBestbuyRun();
    if (!run) { await message.reply('No unposted BestBuy run to retry.'); return; }
    const back = await retryBestbuyRun(run.id);
    await message.reply(back
      ? `Reset the ${back.post_date} digest. The ticker will pick it up within a minute.`
      : 'That run has already been posted.');
  } catch (err) {
    await message.reply(`Retry failed: ${err.message}`);
  }
}

/**
 * `!bbruns` prints the last few digests exactly as the ticker sees them.
 *
 * The ticker claims the oldest run where posted_at is null, post_at has
 * passed and attempts is under five. A silent morning with no alert means one
 * of those three did not hold, and nothing else in the bot can show which.
 */
async function bestbuyRuns(message) {
  try {
    const runs = await recentBestbuyRuns(6);
    if (!runs.length) { await message.reply('No BestBuy runs recorded at all.'); return; }

    const now = DateTime.now();
    const fmt = (d) => (d ? DateTime.fromJSDate(d).setZone('America/New_York').toFormat('LLL d h:mma') : '-');
    const lines = runs.map((r) => {
      const at = DateTime.fromJSDate(r.post_at);
      const claimable = !r.posted_at && at <= now && r.attempts < 5;
      return `${String(r.post_date).slice(0, 10)}  items ${String(r.items).padStart(2)}  `
        + `due ${fmt(r.post_at).padEnd(13)} sent ${fmt(r.posted_at).padEnd(13)} `
        + `tries ${r.attempts}  ${claimable ? '<- CLAIMABLE NOW' : ''}`;
    });

    const top = runs[0];
    const at = DateTime.fromJSDate(top.post_at);
    const why = top.posted_at
      ? `already sent${top.message_id ? ' live' : ` as ${top.form ?? 'a dry run'}`}, so the ticker skips it. \`!bbresend\` reopens it.`
      : at > now
        ? `not due until ${fmt(top.post_at)}.`
        : top.attempts >= 5
          ? 'out of attempts. `!bbretry` resets the count.'
          : top.items === 0
            ? 'claimable, but it holds no items, so the digest would be empty. `!bbbackfill 100` fills it.'
            : 'claimable right now. If nothing is posting, the ticker is not running: check the boot log for "bestbuy digests are ON".';

    await message.reply(
      `\`\`\`\n${lines.join('\n')}\n\`\`\`\n`
      + `Newest run is ${why}`
      + (top.error ? `\nLast error: ${top.error}` : ''),
    );
  } catch (err) {
    await message.reply(`Could not read the runs: ${err.message}`);
  }
}

/**
 * `!targetprobe <tcin> [...]` reads Target listings from this service and
 * reports exactly what came back.
 *
 * The Target raffle automation wants to re-check listings so a reminder can
 * drop items Target pulled mid draw. Whether Target will serve those pages to
 * Railway at all is unknown: it blocks plenty of automated reads, and this is
 * a datacenter address. Rather than assume either way, this answers it with
 * evidence before the feature is built on top of the assumption.
 */
async function targetProbe(message, rest) {
  const tcins = (rest ?? '').split(/[\s,]+/).map((t) => t.trim()).filter(Boolean).slice(0, 5);
  if (!tcins.length) {
    await message.reply('Give me at least one TCIN, for example `!targetprobe 1011407490`.');
    return;
  }

  await message.reply(`Reading ${tcins.length} listing${tcins.length === 1 ? '' : 's'} from Target, one at a time.`);

  const blocks = [];
  for (const tcin of tcins) {
    // Serially, not in parallel: a burst is the quickest way to get walled,
    // and this is meant to measure the normal case.
    blocks.push(formatProbe(await probeListing(tcin)));
  }

  let chunk = '';
  for (const b of blocks) {
    if (chunk && chunk.length + b.length > 1800) {
      await message.channel.send(`\`\`\`\n${chunk}\n\`\`\``);
      chunk = '';
    }
    chunk = chunk ? `${chunk}\n${'-'.repeat(40)}\n${b}` : b;
  }
  if (chunk) await message.channel.send(`\`\`\`\n${chunk}\n\`\`\``);
}

/**
 * `!crosspost <sub> [title]` sends the most recent Reddit post into another sub.
 *
 * Driven by hand and never by a run. Crossposting into subs HK does not
 * moderate is what risks a domain ban on the affiliate links, and a domain ban
 * would break those links in r/PokeCollectors and r/TCGHub too, including in
 * posts already up. So this is a deliberate act with a named target, on a code
 * path nothing automatic touches.
 *
 * The bot cannot approve in a sub it does not moderate, so there is no approve
 * step here. If the sub's AutoModerator removes it, that is the sub's answer.
 */
async function redditCrosspost(message, args) {
  const [, sub, title] = args.match(/^\s+(?:r\/)?([A-Za-z0-9_]{2,21})(?:\s+(.+))?$/) ?? [];
  if (!sub) {
    await message.reply('Usage: `!crosspost <subreddit> [title]`. Without a title the original post\'s title is reused.');
    return;
  }

  const reddit = await import('./reddit.js');
  if (!await reddit.isConnected()) {
    await message.reply('Reddit is not connected yet. Open the connect URL from the startup logs first.');
    return;
  }

  const latest = await latestRedditPost();
  if (!latest) {
    await message.reply('No Reddit post has gone out yet, so there is nothing to crosspost.');
    return;
  }

  try {
    const r = await reddit.crosspost({
      sub, title: title?.trim() || latest.title, fullname: latest.fullname,
    });
    await message.reply(
      `Crossposted to r/${sub}: ${r.url}\n`
      + `Source: r/${latest.sub} "${latest.title}"\n`
      + 'Not approved, since the bot does not moderate that sub. If their AutoModerator removes it, that is their call.',
    );
  } catch (err) {
    await message.reply(`Crosspost to r/${sub} failed: ${err.message}`);
  }
}

/**
 * `!targetscan [n]` reads recent Target channel history and starts a run.
 *
 * Discord never replays messages a bot could not see at the time, so a
 * permission problem or an outage during a raffle loses it permanently: the
 * embeds sit in the channel and the bot will never hear about them. That is
 * not hypothetical, it is how the first live Target raffle was missed.
 *
 * Feeds the same batcher the live handler uses, so a scan and a live embed
 * land in one run rather than two. Items already held are reported as repeats
 * rather than added twice.
 */
async function targetScan(message, raw) {
  if (!TARGET_CHANNEL_ID) {
    await message.reply('TARGET_CHANNEL_ID is not set, so there is no channel to scan.');
    return;
  }
  if (!flag(TARGET_ENABLED)) {
    await message.reply('TARGET_ENABLED is off, so a scan would collect items nothing would post.');
    return;
  }

  const limit = Math.min(Math.max(parseInt(raw, 10) || 50, 1), 100);
  try {
    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!channel?.isTextBased?.()) {
      await message.reply(`Channel ${TARGET_CHANNEL_ID} is not a text channel the bot can read.`);
      return;
    }

    const fetched = await channel.messages.fetch({ limit });
    // Oldest first, so the batcher sees them in the order they were posted.
    const ordered = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const added = [];
    const repeats = [];
    const skipped = [];
    let held = 0;

    for (const m of ordered) {
      for (const embed of m.embeds ?? []) {
        if (!isRaffleEmbed(embed)) {
          skipped.push(`"${embed?.author?.name ?? 'no author'}" [${(embed?.fields ?? []).map((f) => f.name).join(', ') || 'no fields'}]`);
          continue;
        }
        const t = parseTargetRaffle(embed, { now: DateTime.now() });
        if (!t) { skipped.push('a raffle embed with no usable tcin or title'); continue; }
        const r = targetBatcher.add(t);
        held = r.size;
        (r.joined ? added : repeats).push(`${t.productName} (${t.tcin})`);
      }
    }

    const uniqueSkips = [...new Set(skipped)];
    await message.reply(
      `Scanned the last ${ordered.length} message(s) in the Target channel.\n`
      + `Added ${added.length}, already held ${repeats.length}, ${held} now in the run.\n`
      + (added.length ? `\n**Added**\n${added.join('\n')}\n` : '')
      + (uniqueSkips.length
        ? `\n**Not raffles** (${skipped.length} embed(s), ${uniqueSkips.length} shape(s))\n`
          + uniqueSkips.slice(0, 5).join('\n')
        : '')
      + (added.length
        ? `\n\nThe run fires after ${Number(TARGET_QUIET_PERIOD_MS) / 60000} minutes of quiet.`
        : ''),
    );
  } catch (err) {
    await message.reply(`Could not scan the Target channel: ${err.message}`);
  }
}

/**
 * `!drawrepair [n]` re-reads the Walmart channel and repairs the last draw.
 *
 * Exists because a classifier bug dropped a real product from a live draw.
 * The run is stored with only the items that were postable at the time, so
 * once the bug is fixed there is nothing in the database to rebuild from: the
 * item has to be recovered from the channel.
 *
 * Repairs rather than re-runs. The announcement has already gone out on both
 * X accounts and in Discord and cannot be unsent, so it is left alone and only
 * the unpublished posts are rewritten. Anything already sent is reported, not
 * touched.
 */
async function drawRepair(message, raw) {
  const limit = Math.min(Math.max(parseInt(raw, 10) || 60, 1), 100);
  try {
    const run = await latestDrawRun();
    if (!run) { await message.reply('No fired draw run to repair.'); return; }

    const channel = await client.channels.fetch(WALMART_CHANNEL_ID);
    if (!channel?.isTextBased?.()) {
      await message.reply('The Walmart channel is not readable, so there is nothing to re-read.');
      return;
    }

    const sheet = await loadAffiliateLinks().catch(() => null);
    const fetched = await channel.messages.fetch({ limit });
    const seen = new Map();
    const scanned = [];
    for (const m of [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
      for (const embed of m.embeds ?? []) {
        let item;
        try { item = parseEmbed(embed, { now: DateTime.now(), sheet }); } catch { continue; }
        if (!item) continue;
        scanned.push(item);
        // Only this draw's items. The channel holds queue drops and older
        // draws too, and pulling those in would invent a run.
        if (item.drawDate !== run.draw_date) continue;
        if (!isPostable(item.classification)) continue;
        seen.set(item.pid, item);
      }
    }

    if (!seen.size) {
      // Says what it DID see, so a date mismatch is visible rather than
      // reading as an empty channel. The first version of this message said
      // only "found no items" and sent HK to re-run with a bigger number when
      // the real fault was comparing a string to a Date.
      const dates = [...new Set(scanned.map((i) => i.drawDate).filter(Boolean))];
      await message.reply(
        `Re-read ${fetched.size} message(s) and found no items for draw date ${run.draw_date}.\n`
        + (dates.length
          ? `Draw dates actually seen: ${dates.join(', ')}.`
          : 'No draw embeds at all in that many messages, so try a larger count.'),
      );
      return;
    }

    const had = new Set(run.items.map((i) => String(i.pid)));
    const recovered = [...seen.values()].filter((i) => !had.has(String(i.pid)));
    if (!recovered.length) {
      await message.reply(`Re-read ${fetched.size} message(s). All ${seen.size} item(s) for `
        + `${run.draw_date} are already in the run, so there is nothing to repair.`);
      return;
    }

    await message.reply(`Recovering ${recovered.length} item(s) into ${run.draw_date}: `
      + `${recovered.map((i) => i.productName).join('; ')}\nRebuilding the image and the posts.`);

    await addDrawItems(run.id, recovered);
    const full = await latestDrawRun();

    const naming = await nameItems(full.items);
    const named = orderedItems(naming.items.map((i, idx) => ({ ...full.items[idx], ...i })));
    const sets = setsOf(named);
    const startsAt = DateTime.fromJSDate(full.starts_at).setZone('America/New_York');
    const endsAt = DateTime.fromJSDate(full.ends_at).setZone('America/New_York');

    // The grid has to be rebuilt, not patched: it is one composed image and
    // the missing product has to take its place among the others.
    let image = null;
    let imageError = null;
    try {
      const photos = await Promise.all(named.map(async (i) => {
        try { return { pid: i.pid, buffer: (await fetchAndTrim(i.imageUrl)).buffer }; }
        catch { return { pid: i.pid, buffer: undefined }; }
      }));
      const byPid = new Map(photos.map((p) => [p.pid, p]));
      image = await buildDrawImage({
        runId: full.id,
        drawDate: full.draw_date,
        startsAt,
        items: orderedPokemon(named).map((i) => ({ ...i, buffer: byPid.get(i.pid)?.buffer })),
      });
      if (image?.url) await setRunImage(full.id, image.url);
    } catch (err) {
      imageError = err.message;
    }

    // Buffer. The announcement and the wins draft are left alone: the first
    // has published and the second is HK's to send by hand.
    const recorded = await drawBufferPosts(full.id);
    const byChannel = {
      [CHANNELS.pokemonfindr]: buildPosts({ items: named, sets, startsAt, endsAt, variant: 'default' }),
      [CHANNELS.collectfinder]: buildPosts({ items: named, sets, startsAt, endsAt, variant: 'collectfinder' }),
    };
    const altText = altTextFor({ items: named, startsAt });

    const edited = [];
    const refused = [];
    for (const row of recorded) {
      if (row.slot === 'announcement' || row.slot === 'wins_draft') continue;
      const post = byChannel[row.channelId]?.find((p) => p.slot === row.slot);
      if (!post) continue;
      try {
        await editPost({
          postId: row.bufferPostId,
          text: post.text,
          imageUrl: image?.url ?? full.image_url ?? null,
          altText,
        });
        edited.push(`${row.slot} on ${row.channelId === CHANNELS.pokemonfindr ? 'PokemonFindr' : 'CollectFinder'}`);
      } catch (err) {
        refused.push(`${row.slot}: ${err.message}`);
      }
    }

    // Discord, pending rows only.
    const dposts = buildDiscordPosts({ items: named, sets, startsAt, endsAt, role: ROLE_MENTION });
    const dUpdated = [];
    for (const d of dposts) {
      const updated = await updatePendingDiscordPost({
        runId: full.id, slot: d.slot, body: d.text, imageUrl: image?.url ?? full.image_url ?? null,
      });
      if (updated) dUpdated.push(d.slot);
    }

    await message.reply(
      `**Repaired ${full.draw_date}** now ${named.length} item(s)\n`
      + `Image: ${image?.url ?? `not rebuilt. ${imageError}`}\n`
      + `Buffer: ${edited.length ? `updated ${edited.join(', ')}` : 'nothing updated'}`
      + `${refused.length ? `\n  refused: ${refused.join('; ')}` : ''}\n`
      + `Discord: ${dUpdated.length ? `updated ${dUpdated.join(', ')}` : 'no pending posts'}\n`
      + 'The announcement is unchanged on both accounts and in Discord, since it has already gone out.',
    );
  } catch (err) {
    await message.reply(`Could not repair the draw: ${err.message}`);
  }
}

/** `!bbstatus` prints the BestBuy settings as this process actually reads them. */
async function bestbuyStatus(message) {
  const line = (name, v, on) => `${on ? 'ON ' : 'OFF'}  ${name} = ${flagRaw(v)}`;
  await message.reply(
    '```\n'
    + `${line('BESTBUY_ENABLED', BESTBUY_ENABLED, flag(BESTBUY_ENABLED))}\n`
    + `${line('BESTBUY_LIVE   ', BESTBUY_LIVE, flag(BESTBUY_LIVE))}\n`
    + `     BESTBUY_CHANNEL_ID       = ${BESTBUY_CHANNEL_ID ?? 'not set'}\n`
    + `     BESTBUY_ALERT_CHANNEL_ID = ${BESTBUY_ALERT_CHANNEL_ID ?? 'not set'}\n`
    + `     BESTBUY_CHECKER_CHANNEL_ID = ${BESTBUY_CHECKER_CHANNEL_ID ?? 'not set'}\n`
    + `     post hour (ET)           = ${POST_HOUR}\n`
    + '```\n'
    + (flag(BESTBUY_ENABLED) && flag(BESTBUY_LIVE)
      ? 'Digests are on and will post to members.'
      : !flag(BESTBUY_ENABLED)
        ? 'The ticker is not running. BESTBUY_ENABLED must be true.'
        : 'The ticker runs but sends nothing. BESTBUY_LIVE must be true.'),
  );
}

/**
 * `!bbresend` reopens the latest digest so the ticker sends it again.
 *
 * For the case `!bbretry` cannot reach: a digest built while BESTBUY_LIVE was
 * off is marked posted without anything leaving the bot, and only this can
 * put it back in the queue.
 */
async function bestbuyResend(message) {
  try {
    const run = await reopenBestbuyRun();
    if (!run) { await message.reply('There are no BestBuy digests to resend.'); return; }

    const live = flag(BESTBUY_LIVE);
    const history = !run.posted_at
      ? 'It had not been sent yet.'
      : run.message_id
        ? '**Careful: that digest already went out live, so members will see it twice.**'
        : `It had only been built as a dry run (${run.form ?? 'no form recorded'}), so nothing reached members.`;

    await message.reply(
      `Reopened the ${run.post_date} digest. The ticker picks it up within a minute.\n`
      + `${history}\n`
      + (live
        ? 'BESTBUY_LIVE is true, so this one goes to members.'
        : `**This will build another dry run and send nothing.** This process reads `
          + `BESTBUY_LIVE as ${flagRaw(BESTBUY_LIVE)}. It must be the name in capitals and a `
          + 'value of true, 1, yes or on. Fix it in Railway, wait for the redeploy, then run this again.'),
    );
  } catch (err) {
    await message.reply(`Resend failed: ${err.message}`);
  }
}

/**
 * `!bbbackfill [1-100]` banks Daily Summary embeds the bot never saw live.
 *
 * Gateway events are not replayed. A restart, a deploy or a permission fix
 * between the 1AM burst and the 7AM post loses the whole night: the embeds sit
 * in the channel and the database has nothing, so the ticker finds no run due
 * and the morning passes in silence. `!bbscan` only reads. This writes.
 *
 * Each embed is dated by its own message rather than by now, so one posted at
 * 1AM is filed against that morning's 7AM slot and not tomorrow's. A slot that
 * has already passed makes the run due immediately and the ticker sends it
 * within the minute.
 */
async function bestbuyBackfill(message, raw) {
  if (!BESTBUY_CHANNEL_ID) {
    await message.reply('BESTBUY_CHANNEL_ID is not set, so there is nothing to read.');
    return;
  }
  const limit = Math.min(Math.max(parseInt(raw, 10) || 50, 1), 100);

  try {
    const channel = await client.channels.fetch(BESTBUY_CHANNEL_ID);
    if (!channel?.isTextBased?.()) {
      await message.reply(`Channel ${BESTBUY_CHANNEL_ID} is not a text channel the bot can read.`);
      return;
    }

    const fetched = await channel.messages.fetch({ limit });
    // Oldest first, so a product repeated during the night ends up holding its
    // latest numbers rather than its first.
    const ordered = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const banked = [];
    const slots = new Map();
    const errors = [];
    let embeds = 0;
    let skipped = 0;
    let late = 0;

    for (const m of ordered) {
      for (const embed of m.embeds ?? []) {
        embeds += 1;
        const item = parseSummaryEmbed(embed, { now: DateTime.fromMillis(m.createdTimestamp) });
        if (item === null) { skipped += 1; continue; }
        if (item.error) { errors.push(`${item.title ?? '(no title)'}: ${item.error}`); continue; }
        try {
          const res = await recordBestbuyItem({
            postDate: item.postDate, postAt: item.postAt.toISO(), item,
          });
          if (res.late) late += 1;
          banked.push(`${res.inserted ? '+' : '~'} ${item.sku}  ${String(item.units).padStart(5)}u  `
            + item.rawTitle.slice(0, 52));
          const slot = slots.get(item.postDate) ?? { n: 0, at: item.postAt };
          slot.n += 1;
          slots.set(item.postDate, slot);
        } catch (err) {
          errors.push(`${item.sku}: ${err.message}`);
        }
      }
    }

    const now = DateTime.now();
    const slotLines = [...slots.entries()].map(([date, { n, at }]) => {
      const when = at.setZone('America/New_York').toFormat('ccc LLL d, h:mma');
      return `  ${date}: ${n} product(s), posts ${when}${at <= now ? ' (DUE NOW)' : ''}`;
    });

    await message.reply(
      `Read the last ${fetched.size} message(s) in <#${BESTBUY_CHANNEL_ID}>.\n`
      + `${embeds} embed(s): **${banked.length} banked**, ${skipped} not summaries, `
      + `${errors.length} unreadable.`
      + (slotLines.length ? `\n\nDigest slots:\n${slotLines.join('\n')}` : '')
      + (late
        ? `\n\n${late} of these belong to a digest that is already closed. `
          + 'Run `!bbresend` to reopen it and send it with them included.'
        : '')
      + (errors.length ? `\n\nUnreadable:\n${errors.slice(0, 5).join('\n')}` : '')
      + (banked.length
        ? `\n\nBanked:\n\`\`\`\n${banked.slice(0, 25).join('\n')}\n\`\`\``
        : '\n\nNothing banked. If the embeds are there, `!bbscan` says why they were skipped.'),
    );
  } catch (err) {
    await message.reply(
      `Backfill failed: ${err.message}\n`
      + 'A permissions error here means the bot cannot read the monitor channel, '
      + 'which is also why nothing banks on its own.',
    );
  }
}

/**
 * `!drawrefresh` rebuilds the member Discord posts that have not gone out yet.
 *
 * The post bodies are written once when a run fires, so a copy change after
 * that leaves the rest of the day's posts carrying the old wording. This
 * rebuilds them from the stored run using the current code. Posts already
 * sent are left alone and so are the due times: this changes wording, not
 * the schedule.
 */
async function drawRefresh(message) {
  if (!DISCORD_MEMBER_CHANNEL_ID) {
    await message.reply('DISCORD_MEMBER_CHANNEL_ID is not set, so there are no member posts to refresh.');
    return;
  }
  try {
    const run = await latestDrawRun();
    if (!run) { await message.reply('No fired draw run to refresh.'); return; }
    if (!run.items.length) { await message.reply(`Run ${run.draw_date} has no items.`); return; }

    // product_name and price survive in the database, the set names do not,
    // so the naming step runs again to recover them.
    const naming = await nameItems(run.items);
    const named = naming.items.map((i, idx) => ({ ...run.items[idx], ...i }));
    const sets = setsOf(named);

    const posts = buildDiscordPosts({
      items: named,
      sets,
      startsAt: DateTime.fromJSDate(run.starts_at).setZone('America/New_York'),
      endsAt: DateTime.fromJSDate(run.ends_at).setZone('America/New_York'),
      role: ROLE_MENTION,
    });

    const updated = [];
    for (const p of posts) {
      const row = await updatePendingDiscordPost({
        runId: run.id, slot: p.slot, body: p.text, imageUrl: run.image_url ?? null,
      });
      if (row) {
        updated.push(`${row.slot} (${DateTime.fromJSDate(row.due_at).setZone('America/New_York').toFormat('ccc LLL d, h:mma')})`);
      }
    }

    await message.reply(
      `Rebuilt the member posts for ${run.draw_date} from ${named.length} item(s), `
      + `naming from the ${naming.source}${naming.note ? ` (${naming.note})` : ''}.\n`
      + (updated.length
        ? `Updated ${updated.length} pending post(s): ${updated.join(', ')}.`
        : 'No pending posts to update, they have all gone out already.')
      + `\n\nNew order:\n${named.length ? itemBlock(orderedPokemon(named.filter((i) => i.classification === 'pokemon' || !i.classification)).concat(named.filter((i) => i.classification && i.classification !== 'pokemon'))) : ''}`.slice(0, 1200),
    );

    // The rebuilt announcement, so the new wording can be read rather than
    // inferred from the item order.
    const announcement = posts.find((p) => p.slot === 'announcement');
    if (announcement) {
      await alertBlock(`**Discord announcement** for ${run.draw_date}, rebuilt and ready to copy`, announcement.text);
    }
  } catch (err) {
    await message.reply(`Draw refresh failed: ${err.message}`);
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

    const bb = content.match(/^!bbpreview(?:\s+(\d+))?$/i);
    if (bb) { await bestbuyPreview(message, bb[1]); return; }

    const bbscan = content.match(/^!bbscan(?:\s+(\d+))?$/i);
    if (bbscan) { await bestbuyScan(message, bbscan[1]); return; }

    if (/^!bbretry$/i.test(content)) { await bestbuyRetry(message); return; }

    if (/^!bbruns$/i.test(content)) { await bestbuyRuns(message); return; }
    if (/^!bbstatus$/i.test(content)) { await bestbuyStatus(message); return; }

    const tscan = content.match(/^!targetscan(?:\s+(\d+))?$/i);
    if (tscan) { await targetScan(message, tscan[1]); return; }

    const tprobe = content.match(/^!targetprobe\b(.*)$/i);
    if (tprobe) { await targetProbe(message, tprobe[1]); return; }
    if (/^!bbresend$/i.test(content)) { await bestbuyResend(message); return; }

    const bbfill = content.match(/^!bbbackfill(?:\s+(\d+))?$/i);
    if (bbfill) { await bestbuyBackfill(message, bbfill[1]); return; }

    if (/^!drawrefresh$/i.test(content)) { await drawRefresh(message); return; }

    const drepair = content.match(/^!drawrepair(?:\s+(\d+))?$/i);
    if (drepair) { await drawRepair(message, drepair[1]); return; }

    if (/^!sheet$/i.test(content)) {
      forgetSheet();
      try {
        const m = await loadAffiliateLinks();
        const body = missingLinksAlert(m, { mention: null, sheetUrl: WALMART_SHEET_URL ?? null });
        const parts = splitAlert(`${summariseSheet(m)}\n\n${body ?? 'Every SKU has an affiliate link.'}`);
        for (const part of parts) await message.reply(part);
        // Asked for on purpose, so the dedup is reset: the next boot reports
        // again rather than staying silent because this reply already said it.
        await setSecret('walmart_missing_links', '').catch(() => {});
      } catch (err) {
        await message.reply(`Could not read the sheet: ${err.message}`);
      }
      return;
    }

    const xpost = content.match(/^!crosspost\b(.*)$/i);
    if (xpost) { await redditCrosspost(message, xpost[1]); return; }

    return;
  }

  // BestBuy in store Daily Summaries. These land around 1AM in their own
  // channel and publish at 7AM, so nothing happens here beyond banking them
  // against the morning they belong to.
  if (BESTBUY_CHANNEL_ID && message.channelId === BESTBUY_CHANNEL_ID) {
    if (!flag(BESTBUY_ENABLED)) return;
    for (const embed of message.embeds ?? []) {
      let item;
      try {
        item = parseSummaryEmbed(embed, { now: DateTime.now() });
      } catch (err) {
        await alert(`Could not parse a BestBuy summary embed from ${message.url}: ${err.message}`);
        continue;
      }
      if (item === null) continue;
      if (item.error) {
        await alert(`A "${SUMMARY_AUTHOR}" embed could not be read and was ignored: ${item.error}\n${message.url}`);
        continue;
      }
      try {
        const res = await recordBestbuyItem({ postDate: item.postDate, postAt: item.postAt.toISO(), item });
        console.log(
          `${res.inserted ? 'added' : 'updated'} bestbuy ${item.sku} ${item.rawTitle} `
          + `(${item.units} units, ${item.states} states) -> digest ${item.postDate}`,
        );
        if (res.late) {
          await alert(
            `**Late BestBuy summary for ${item.postDate}**\n`
            + `${item.rawTitle} (${item.sku}) arrived after the digest had gone out, so it is not in it.`,
          );
        }
        if (item.unknownStates.length) {
          await alert(
            `BestBuy summary for ${item.rawTitle} listed states with no region mapping, `
            + `so their units are missing from the totals: ${item.unknownStates.join(', ')}`,
          );
        }
      } catch (err) {
        await alert(`Could not record a BestBuy summary item: ${err.message}`);
      }
    }
    return;
  }

  if (flag(TARGET_ENABLED) && TARGET_CHANNEL_ID && message.channelId === TARGET_CHANNEL_ID) {
    if (!message.embeds?.length) {
      console.log(`target channel: a message with no embeds from ${message.author?.username ?? 'unknown'}`);
      return;
    }
    for (const embed of message.embeds) {
      // A Raffle Status field is the only thing separating a raffle from an
      // ordinary restock. The Type field reads "Restock" on both.
      //
      // Logged when it does not match rather than skipped in silence. A wrong
      // discriminator and a channel the bot cannot see look identical from
      // outside otherwise, which is exactly what happened on the first live
      // raffle.
      if (!isRaffleEmbed(embed)) {
        console.log(`target channel: skipped an embed, author "${embed?.author?.name ?? 'none'}", `
          + `fields [${(embed?.fields ?? []).map((f) => f.name).join(', ') || 'none'}]`);
        continue;
      }
      const t = parseTargetRaffle(embed, { now: DateTime.now() });
      if (!t) {
        await alert(`A Target Raffles embed had a Raffle Status but no usable tcin or title, so it was ignored.\n${message.url}`);
        continue;
      }
      const r = targetBatcher.add(t);
      console.log(`${r.joined ? 'added' : 'repeat'} target ${t.tcin} ${t.productName} (${r.size} held)`);
    }
    return;
  }

  if (message.channelId !== WALMART_CHANNEL_ID) return;
  if (!message.embeds?.length) return;

  // Loaded once for the whole message rather than per embed. It is cached for
  // five minutes anyway, but a drop arrives as a burst of embeds and there is
  // no reason to ask the cache ten times.
  //
  // A sheet that cannot be read must not stop a drop being posted: the items
  // fall back to plain PokeFinder links, which is exactly the behaviour
  // before the sheet existed, and the alert says so once.
  let sheet = null;
  try {
    sheet = await loadAffiliateLinks();
  } catch (err) {
    if (!sheetWarned) {
      sheetWarned = true;
      await alert(`The affiliate sheet could not be read, so items will post with plain PokeFinder links: ${err.message}`);
    }
  }

  for (const embed of message.embeds) {
    let item;
    try {
      item = parseEmbed(embed, { now: DateTime.now(), sheet });
    } catch (err) {
      await alert(`Could not parse an embed from ${message.url}: ${err.message}`);
      continue;
    }

    if (item === null) {
      // Not a draw. It may still be a queue item from the Droplist monitor,
      // which posts to this same channel.
      if (!flag(QUEUE_ENABLED)) continue;
      let q;
      try {
        q = parseQueueEmbed(embed, { now: DateTime.now(), sheet });
      } catch (err) {
        await alert(`Could not parse a queue embed from ${message.url}: ${err.message}`);
        continue;
      }
      if (q === null) {
        // The late queue comes through the restock monitor, flagged in its
        // title. Everything else from that monitor stays ignored.
        const pq = parsePotentialQueueEmbed(embed, { now: DateTime.now(), sheet });
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

/**
 * The reminder ticker.
 *
 * Target draws run for days, so the reminders cannot be written at
 * announcement time: by the time one fires, Target may have pulled half the
 * listings. Each pass looks for a reminder coming due, re-checks every listing
 * in that run, and only then builds the post.
 *
 * Deliberately serial. Two overlapping passes would both see the same reminder
 * as unposted and create it twice, and Buffer has no way to tell that the
 * second is a duplicate of the first.
 */
function startTargetTicker() {
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const did = await tickTargetReminders({
        asDraft: !flag(TARGET_LIVE),
        discordChannelId: flag(TARGET_LIVE) ? (DISCORD_MEMBER_CHANNEL_ID ?? null) : null,
        discordRole: DISCORD_MEMBER_ROLE_ID ? `<@&${DISCORD_MEMBER_ROLE_ID}>` : '@PokeFinder+',
        reddit: flag(REDDIT_ENABLED),
        alert,
      });
      for (const d of did) {
        if (d.action === 'completed') {
          console.log(`target run #${d.runId} closed${d.why ? `, ${d.why}` : ''}`);
        } else {
          console.log(`target run #${d.runId} reminder(s) ${d.slots.join(', ')} created`);
        }
      }
    } catch (err) {
      // Logged rather than alerted: a failing tick retries in minutes, and a
      // database hiccup every five minutes would bury the alert channel.
      console.error(`target reminder tick failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setInterval(pass, Number(TARGET_TICK_MS)).unref?.();
  pass();
}

/**
 * The Reddit ticker.
 *
 * Separate from the Discord one because the failure modes are different: a
 * Discord post either sends or does not, while a Reddit post can succeed and
 * then be removed by AutoModerator, which is why posting and approving happen
 * together inside one claim.
 *
 * Serial, like the others. Two overlapping passes could claim nothing twice
 * thanks to SKIP LOCKED, but they would still both be submitting from one
 * account at the same moment, which is what Reddit throttles.
 */
/**
 * Tell HK which SKUs still need an affiliate link.
 *
 * Sent only when the set of missing SKUs differs from the last time it was
 * sent. Railway rolls containers over on every deploy and several can land
 * within a minute, so alerting on each boot would be the same message three
 * times. The fingerprint is kept in the secrets table rather than in memory
 * precisely because the process restarts; an in-memory one would never
 * suppress anything.
 *
 * Nothing is sent when nothing is missing. An all clear on every boot is
 * noise, and the absence of this message already means the sheet is complete.
 */
async function alertMissingLinks(map) {
  try {
    const mention = ALERT_USER_ID ? `<@${ALERT_USER_ID}>` : null;
    const body = missingLinksAlert(map, { mention, sheetUrl: WALMART_SHEET_URL ?? null });
    // Fingerprinted with the mention, so gaining one counts as a change.
    const fingerprint = missingFingerprint(map, { mention });
    const previous = await getSecret('walmart_missing_links').catch(() => null);
    if (fingerprint === (previous ?? '')) return;
    await setSecret('walmart_missing_links', fingerprint);
    // Split rather than truncated: alert() cuts at 1900 characters, which on a
    // long list would drop the SKUs at the bottom, the ones not got to yet.
    for (const part of splitAlert(body)) await alert(part);

    // Reported alongside, but deduplicated separately: a conflict and a
    // missing link are fixed differently, and one being resolved should not
    // silence the other.
    const clash = conflictAlert(map, {
      mention: ALERT_USER_ID ? `<@${ALERT_USER_ID}>` : null,
      sheetUrl: WALMART_SHEET_URL ?? null,
    });
    const clashPrint = (map.conflicts ?? []).map((c) => c.sku).sort().join(',');
    if (clash && clashPrint !== (await getSecret('walmart_sku_conflicts').catch(() => null) ?? '')) {
      await setSecret('walmart_sku_conflicts', clashPrint);
      for (const part of splitAlert(clash)) await alert(part);
    }
  } catch (err) {
    // Never load bearing. A failure here must not stop the bot booting.
    console.error(`could not report missing affiliate links: ${err.message}`);
  }
}

function startRedditTicker() {
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const did = await tickReddit({ alert, mode: REDDIT_MODE });
      for (const d of did) {
        if (d.skipped) { console.log(`reddit: ${d.due} post(s) due but ${d.skipped}`); continue; }
        if (d.error) { console.log(`reddit ${d.slot} to r/${d.sub} failed: ${d.error}`); continue; }
        if (d.manual) { console.log(`reddit ${d.slot} for r/${d.sub} delivered to the alert channel to paste`); continue; }
        console.log(`reddit ${d.slot} to r/${d.sub}: ${d.url}${d.approved ? ' (approved)' : ' NOT APPROVED'}`);
      }
    } catch (err) {
      // Logged, not alerted: a failing tick retries in a minute and a database
      // hiccup every minute would bury the alert channel.
      console.error(`reddit tick failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setInterval(pass, Number(REDDIT_TICK_MS)).unref?.();
  pass();
}

/**
 * Check the bot can actually see the channels it claims to be watching.
 *
 * Discord delivers MessageCreate only for channels the bot can view. Without
 * the permission, or in a guild the bot is not in, no event ever arrives and
 * the service looks exactly as it does when everything is fine: a startup line
 * saying it is reading a channel, and then silence.
 *
 * That silence cost an afternoon on the first live Target raffle, so each
 * configured channel is now fetched at boot and the result said out loud.
 */
async function checkChannels() {
  // Only channels the bot reads from or posts to. BESTBUY_CHECKER_CHANNEL_ID
  // is deliberately absent: it is used solely to render a <#channel> link
  // inside the digest text, so the bot never needs to view it, and reporting
  // it as unreadable is the kind of false alarm that trains people to ignore
  // the alert.
  // The channels the bot writes to, as opposed to only reads.
  const POST_CHANNELS = new Set(['alert', 'member']);

  const wanted = [
    ['walmart', WALMART_CHANNEL_ID],
    ['target', flag(TARGET_ENABLED) ? TARGET_CHANNEL_ID : null],
    ['bestbuy', flag(BESTBUY_ENABLED) ? BESTBUY_CHANNEL_ID : null],
    ['alert', ALERT_CHANNEL_ID],
    ['member', DISCORD_MEMBER_CHANNEL_ID],
  ].filter(([, id]) => id);

  const bad = [];
  for (const [label, id] of wanted) {
    try {
      const ch = await client.channels.fetch(id);
      if (!ch) throw new Error('not found');
      // Viewable is the one that matters: a channel can be fetched by id and
      // still deliver no messages if the bot cannot view it.
      const canView = ch.viewable ?? true;

      // Viewable is not enough for the channels the bot posts into. The draw
      // announcement failed five times with "Missing Permissions" on a channel
      // this check had already reported as fine, because reading and writing
      // are separate permissions and only reading was being tested.
      const me = ch.guild?.members?.me ?? null;
      const perms = me && ch.permissionsFor ? ch.permissionsFor(me) : null;
      const posts = POST_CHANNELS.has(label);
      const canSend = !posts || !perms ? true : perms.has(PermissionsBitField.Flags.SendMessages);
      const canAttach = !posts || !perms ? true : perms.has(PermissionsBitField.Flags.AttachFiles);

      const faults = [
        !canView && 'cannot view',
        !canSend && 'cannot send messages',
        // The draw and raffle posts all carry a grid, so losing attachments
        // costs the picture rather than the post.
        canSend && !canAttach && 'cannot attach files, so posts will go out without the grid image',
      ].filter(Boolean);

      console.log(`channel ${label}: #${ch.name ?? id} in ${ch.guild?.name ?? 'no guild'}`
        + `${faults.length ? `  ${faults.join(', ').toUpperCase()}` : ''}`);
      for (const f of faults) bad.push(`${label} (#${ch.name}) ${f}`);
    } catch (err) {
      console.error(`channel ${label} (${id}) could not be fetched: ${err.message}`);
      bad.push(`${label} (${id}) could not be fetched: ${err.message}`);
    }
  }

  if (bad.length) {
    await alert('**Some channels cannot be read, so nothing from them will ever arrive:**\n'
      + bad.map((b) => `- ${b}`).join('\n'));
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`listening as ${c.user.tag} on channel ${WALMART_CHANNEL_ID}`);
  if (DISCORD_MEMBER_CHANNEL_ID) {
    startDiscordScheduler(client, { onError: alert });
    checkChannels().catch((err) => console.error(`channel check failed: ${err.message}`));
    console.log(`member draw posts will go to channel ${DISCORD_MEMBER_CHANNEL_ID}`
      + (DISCORD_MEMBER_ROLE_ID ? ` pinging role ${DISCORD_MEMBER_ROLE_ID}` : ' with NO role ping configured'));
  } else {
    console.log('DISCORD_MEMBER_CHANNEL_ID is not set, so no member draw posts will be sent');
  }
  console.log(flag(QUEUE_ENABLED)
    ? `queue monitoring is ON, posting ${flag(QUEUE_LIVE) ? 'LIVE' : 'to DRAFTS only'}`
    : 'queue monitoring is OFF, set QUEUE_ENABLED=true to turn it on');

  if (flag(BESTBUY_ENABLED) && BESTBUY_CHANNEL_ID && BESTBUY_ALERT_CHANNEL_ID) {
    startBestbuyScheduler(client, {
      channelId: BESTBUY_ALERT_CHANNEL_ID,
      role: DISCORD_MEMBER_ROLE_ID ? `<@&${DISCORD_MEMBER_ROLE_ID}>` : '@PokeFinder+',
      checkerChannel: BESTBUY_CHECKER_CHANNEL_ID
        ? `<#${BESTBUY_CHECKER_CHANNEL_ID}>` : '#bestbuy-instore-check',
      live: flag(BESTBUY_LIVE),
      onError: alert,
      onPosted: async ({ run, digest, dryRun, skipped }) => {
        if (skipped) {
          await alert(`BestBuy digest for ${run.post_date}: ${skipped}, nothing sent.`);
          return;
        }
        const names = digest.items.map((i) => i.name).join(', ');
        await alert(
          `**BestBuy digest ${dryRun ? 'BUILT (dry run, nothing sent)' : 'posted'}** ${run.post_date}\n`
          + `${digest.items.length} product(s), ${digest.text.length} chars, ${digest.form} form\n`
          + `${names}`
          + (dryRun ? `\n\n${digest.text}` : ''),
        );
      },
    });
    console.log(`bestbuy digests are ON, reading ${BESTBUY_CHANNEL_ID}, posting `
      + `${flag(BESTBUY_LIVE) ? 'LIVE' : 'as a DRY RUN'} to ${BESTBUY_ALERT_CHANNEL_ID}`);
  } else {
    console.log('bestbuy digests are OFF, set BESTBUY_ENABLED=true with the two channel IDs to turn them on');
  }
  if (flag(TARGET_ENABLED) && TARGET_CHANNEL_ID) {
    console.log(`target raffles are ON, reading ${TARGET_CHANNEL_ID}, posting ${flag(TARGET_LIVE) ? 'LIVE' : 'to DRAFTS only'}`);
    startTargetTicker();
    console.log(`target reminders are checked every ${Number(TARGET_TICK_MS) / 1000}s, built ${LEAD_MS / 60_000}min ahead`);
  } else {
    console.log('target raffles are OFF, set TARGET_ENABLED=true with TARGET_CHANNEL_ID to turn them on');
  }
  if (flag(REDDIT_ENABLED)) {
    startRedditTicker();
    console.log(`reddit is ON in ${REDDIT_MODE === 'api' ? 'API' : 'MANUAL (paste ready to the alert channel)'} mode, `
      + `checked every ${Number(REDDIT_TICK_MS) / 1000}s, `
      + `draws to ${DRAW_SUBS.map((x) => `r/${x}`).join(' + ')}, queues to ${QUEUE_SUBS.map((x) => `r/${x}`).join(' + ')}`);
  } else {
    console.log('reddit is OFF, set REDDIT_ENABLED=true to turn it on');
  }
  if (process.env.WALMART_SHEET_CSV) {
    loadAffiliateLinks()
      .then(async (m) => {
        console.log(`walmart affiliate ${summariseSheet(m)}`);
        await alertMissingLinks(m);
      })
      .catch((err) => console.error(`walmart affiliate sheet unreadable at boot: ${err.message}`));
  } else {
    console.log('no WALMART_SHEET_CSV set, so items post with plain PokeFinder links');
  }
  if (publicBaseUrl()) {
    console.log(`target close bookmarklet: ${publicBaseUrl()}/target/bookmarklet?key=${setupKey}`);
    console.log(`reddit connect: ${publicBaseUrl()}/reddit/connect?key=${setupKey}`);
  }
  console.log(
    `quiet period ${Number(QUIET_PERIOD_MS) / 1000}s`
    + ` (queue ${Number(QUEUE_QUIET_PERIOD_MS) / 1000}s, target ${Number(TARGET_QUIET_PERIOD_MS) / 1000}s)`
    + `, ceiling ${Number(CEILING_MS) / 1000}s`,
  );
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
