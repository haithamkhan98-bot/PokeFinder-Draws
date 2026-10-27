import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { DateTime } from 'luxon';
import { parseEmbed, DRAW_AUTHOR } from './parse.js';
import { Batcher } from './batcher.js';
import { saveRun, pool, migrate, storeImage } from './db.js';
import { fetchAndTrim } from './image.js';
import { startServer, imageUrl, publicBaseUrl, setupKey } from './server.js';
import { buildDrawImage, MAX_ITEMS } from './draw-image.js';
import { sampleItems } from './selftest.js';
import { isConnected as canvaConnected } from './canva.js';

const {
  DISCORD_TOKEN,
  WALMART_CHANNEL_ID,
  ALERT_CHANNEL_ID,
  QUIET_PERIOD_MS = 300_000,
  CEILING_MS = 1_200_000,
} = process.env;

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
    const usable = items.filter((i) => i.classification === 'pokemon');
    const skipped = items.filter((i) => i.classification !== 'pokemon');

    try {
      if (!usable.length) {
        await alert(`Draw ${drawDate}: ${items.length} item(s) detected, none of them Pokemon TCG. Nothing to post.`);
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
      } else if (usable.length > MAX_ITEMS) {
        drawImageError = `${usable.length} items, but templates only exist for 1 to ${MAX_ITEMS}`;
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

      const lines = usable.map((i) => `  ${i.productName} (${i.pid}) ${i.priceDisplay}`).join('\n');
      const skippedNote = skipped.length
        ? `\nSkipped ${skipped.length}: ` + skipped.map((i) => `${i.rawTitle} [${i.classification}]`).join('; ')
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
            : `not built. ${drawImageError}`}`
        + (suspect ? `\nWarnings:\n${suspect}` : '')
        + `\n\nNo posts have been created. Buffer publishing comes in the next stage.`,
      );
    } catch (err) {
      await alert(`Draw ${drawDate} failed while saving the run: ${err.message}`);
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
  const startsAt = DateTime.now().setZone('America/New_York').set({ hour: 17, minute: 0, second: 0, millisecond: 0 });

  await message.reply(`Building a ${n} item test image. This usually takes under a minute.`);
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
      + `Every block should sit square in its slot with no part cut off, and the prices should read `
      + `${items.map((i) => i.priceDisplay).join(', ')}.`,
    );
  } catch (err) {
    await message.reply(`Test image failed after ${((Date.now() - began) / 1000).toFixed(1)}s: ${err.message}`);
  }
}

client.on(Events.MessageCreate, async (message) => {
  // The command branch only. The bot check must NOT cover the monitor channel:
  // the Walmart monitor posts as a bot, so filtering bots there would make the
  // service deaf to every draw.
  if (ALERT_CHANNEL_ID && message.channelId === ALERT_CHANNEL_ID) {
    if (message.author?.bot) return;
    const cmd = message.content?.trim().match(/^!drawtest(?:\s+(\d+))?$/i);
    if (cmd) await drawTest(message, cmd[1]);
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

    if (item === null) continue;                 // not a draw, almost always the restock monitor

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
  console.log(`quiet period ${Number(QUIET_PERIOD_MS) / 1000}s, ceiling ${Number(CEILING_MS) / 1000}s`);
});

async function shutdown(signal) {
  console.log(`${signal} received, flushing ${batcher.pending().length} pending run(s)`);
  batcher.flush();
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
