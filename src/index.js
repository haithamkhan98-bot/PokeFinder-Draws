import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { DateTime } from 'luxon';
import { parseEmbed, DRAW_AUTHOR } from './parse.js';
import { Batcher } from './batcher.js';
import { saveRun, pool, migrate } from './db.js';

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
        + (suspect ? `\nWarnings:\n${suspect}` : '')
        + `\n\nStage one stops here. No posts have been created.`,
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

client.on(Events.MessageCreate, async (message) => {
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
