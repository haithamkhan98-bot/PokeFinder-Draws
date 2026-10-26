# PokeFinder Walmart draw automation

Stage one of the build described in the Walmart Draw Automation Spec: it watches
the Walmart channel, groups the embeds belonging to one draw, and writes a run
record. **It does not post anything.** Canva and Buffer arrive in stages three
and four.

## What it does

1. Listens to Discord channel `1366430736877355098` over the gateway, so
   detections are pushed in real time rather than polled.
2. Keeps only embeds whose author is **Walmart Draws**. The restock monitor
   (`Walmart US V2`) and the older `PokeFinder Monitors` format both post to the
   same channel and are ignored, so nothing needs switching off on their side.
3. Reads Title, PID, Price, Time and the thumbnail from each draw embed.
4. Converts the Pacific window to Eastern and infers the year as the nearest
   occurrence, so a January draw announced in December does not land in the past.
5. Holds items for a five minute quiet period, capped at twenty minutes from the
   first item, then fires once per draw date.
6. Writes the run and its items to Postgres and posts a summary to the alert
   channel.

## Setup

```bash
npm install
cp .env.example .env     # fill in DISCORD_TOKEN and ALERT_CHANNEL_ID
npm run migrate          # applies schema.sql, safe to re-run
npm start
```

The Discord bot needs the **Message Content** privileged intent, which is
toggled on the bot page of the Discord developer portal. Without it the embeds
arrive empty.

`DATABASE_URL` is injected by Railway. Everything else is in `.env.example`.

## Tests

```bash
npm test
```

Sixteen tests, no network or database needed. They run against the two real
embeds from the channel plus a replay of the five item draw from 21 October.

## Things that are deliberate

**A draw date that has already fired never opens a second run.** A repost of an
item the run already held is dropped as noise. A genuinely new item is reported
as a late arrival, because it means the image and the scheduled posts are now
wrong. That is the amend case and stage five will automate it.

**An unreadable window is an error, not a guess.** If the Time field cannot be
parsed, or the window lands more than sixty days out, the item is flagged to the
alert channel rather than scheduled. A wrong time is worse than a missed one.

**Non Pokemon and repack items are separated, not dropped silently.** They are
counted in the run summary so you can see what was skipped and why.

## Not done yet

Stage two is the image pipeline: download the thumbnail, run the whitespace
trim, and serve the result from a permanent URL on this service. That last part
is what stops the Buffer media failures, because Buffer fetches the image when
the post sends, not when it is scheduled. No Buffer call should ever carry a
Canva export link.
