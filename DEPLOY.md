# Deploying this to Railway

No git and no command line needed. Everything here is done in a browser.

## 1. Put the files on GitHub

GitHub is just storage that Railway can read from.

1. Go to github.com and sign in, or create a free account.
2. Click **New repository**. Name it `pokefinder-draws`. Set it to **Private**.
   Do not tick "Add a README". Click **Create repository**.
3. On the empty repo page click **uploading an existing file**.
4. Unzip the folder I sent you, then drag everything inside it into the browser:
   `package.json`, `schema.sql`, `README.md`, `DEPLOY.md`, `.env.example`, and
   the `src` and `test` folders. Do not drag the outer folder itself, drag what
   is inside it.
5. At the bottom click the green **Commit changes** button.

"Commit" just means save. That button is the whole of it.

## 2. Point Railway at it

1. Open your Railway project, the one that already has Postgres in it.
2. Click **New** then **GitHub Repo**. Authorise GitHub if it asks, and pick
   `pokefinder-draws`.

Railway reads the files, works out it is a Node project, installs it and starts
it. The first build fails because the variables are not set yet. That is
expected.

## 3. Set the variables

Open the new service, go to **Variables**, and add these four.

| Name | Value |
| --- | --- |
| `DISCORD_TOKEN` | your bot token |
| `WALMART_CHANNEL_ID` | `1366430736877355098` |
| `ALERT_CHANNEL_ID` | `1369491926922952818` |
| `DATABASE_URL` | see below |

For `DATABASE_URL`, do not type a value. Railway can link it to your existing
database. Click **Add a Variable Reference**, or type `${{Postgres.DATABASE_URL}}`
exactly as written, with the name matching your Postgres service. If your
Postgres service is called something else, use that name in the braces.

Railway restarts the service by itself once you save.

## 4. Check it worked

Open the **Deployments** tab and click the running deployment to see its logs.
A healthy boot looks like this:

```
database schema is up to date
listening as YourBotName#1234 on channel 1366430736877355098
quiet period 300s (queue 300s), ceiling 1200s
```

If you see all three lines, it is done. It will now sit quietly until the next
Walmart draw and then post a summary to your alert channel.

## When something is wrong

**`missing required env var ...`** means one of the four is not set, or is
spelled differently.

**`could not apply the database schema`** means `DATABASE_URL` is not pointing
at your Postgres. Check the service name inside the braces.

**It boots fine but a draw goes past with no summary.** Almost always the
Message Content intent on the Discord bot page, which has to be on or the
embeds arrive empty. Second most likely is the bot not having permission to
post in the alert channel.

## Stage two: turn on the public domain

Stage two added a small web server that hosts the draw images, so the service
now needs an address on the internet. This was pointless before, because
nothing was listening.

1. Click the **PokeFinder-Draws** service box to open its panel.
2. Open the **Settings** tab inside that panel, not the project settings from
   the top bar.
3. Scroll to **Networking**, or **Public Networking**, and click
   **Generate Domain**.
4. If it asks for a port, enter `3000`.

Railway gives you something like `pokefinder-draws-production.up.railway.app`
and sets it as `RAILWAY_PUBLIC_DOMAIN` by itself, so there is no variable to
add. The service picks it up on the next restart.

Check it worked by opening the domain in a browser. It should say `ok`. The
logs will also now read:

```
image server listening on port 3000
images will be served from https://your-domain.up.railway.app/images/
```

If you skip this, everything else still runs. Images get downloaded, trimmed
and stored, and the run summary says no public URL is configured yet. Nothing
breaks, the images just are not reachable from outside until you do it.

## Stage three: connecting Canva

Add two variables in Railway, both taken from your Canva app's Credentials
section:

```
CANVA_CLIENT_ID
CANVA_CLIENT_SECRET
```

In the Canva Developer Portal, under Outside Canva then Redirect URLs, set
URL 1 to your Railway domain followed by `/oauth/redirect`, for example:

```
https://pokefinder-draws-production.up.railway.app/oauth/redirect
```

After the service restarts, open the Deploy Logs. You will see:

```
CANVA IS NOT CONNECTED YET. Open this once, in a browser, and approve:
  https://your-domain.up.railway.app/canva/connect?key=3f9a...
```

Open that link, approve on Canva's own screen, and you should land on a page
saying the refresh token is stored. That is the whole of it. Restart the
service and the logs will now read `canva is connected`.

You only ever do this once. Canva rotates its refresh tokens on every use and
the service handles that by itself.

The key in that URL changes every time the service restarts, so if the link
stops working just take the current one from the latest logs. You can pin it by
setting a `SETUP_KEY` variable, but there is no need.

## Changing it later

When I send you new files, go to the repo on GitHub, click **Add file** then
**Upload files**, drag the new ones in, and commit. Railway notices and
redeploys on its own. You never need to touch Railway again after the first
setup.

---

## Stage three b: the draw image

This stage makes the bot build the Canva image for a draw and host it here.
There are **no new Railway variables** — the Canva connection you already
approved is all it needs.

### What changed

| File | New? | What it does |
|---|---|---|
| `src/canva-api.js` | new | Talks to Canva: uploads photos, runs the autofill, exports the PNG |
| `src/draw-image.js` | new | Picks the right template, writes the header, hosts the result |
| `src/index.js` | changed | Calls the image builder once a run fires |
| `src/db.js` | changed | Records which Canva design a run produced |
| `test/draw-image.test.js` | new | Tests for the header wording and template choice |

### Uploading

Same as before:

1. Open your GitHub repository in a browser.
2. Click **Add file**, then **Upload files**.
3. Drag in the five files above, keeping them in the same folders
   (`src/...` files go in `src`, the test goes in `test`).
   GitHub will ask about overwriting `index.js` and `db.js` — that is expected.
4. Scroll down, leave "Commit directly to the main branch" selected, and click
   **Commit changes**.

Railway sees the commit and redeploys on its own. Nothing to click there.

### What you should see

The next time the monitor posts a draw, the run summary in the alert channel
gains a line like:

```
Draw image: https://your-app.up.railway.app/images/<id>.png (284KB, design DAHZK...)
```

Open that link. It is the finished draw image, served from your own bot rather
than from Canva, so it will still work when Buffer fetches it days later.

If it says `Draw image: not built.` the reason follows on the same line. The
two likely ones are a product photo that would not download, and a draw with
more items than there are templates (there are five, for one to five items).
Everything else about the run still succeeded; only the image is missing.

---

## The `!drawtest` command

Type `!drawtest` in the alert channel and the bot builds a real draw image from
stand in products, using exactly the same code a live draw uses. It replies
with a link to the finished image. Add a number to change the item count:
`!drawtest 5` exercises the five slot layout. Valid range is 1 to 5.

Nothing is written to the run history, and it does not touch Buffer. It is
safe to run whenever you want to check the pipeline is healthy.

The stand in products are deliberately awkward: each is a coloured block inside
a wide white margin, and every one is a different shape. That is the hard case,
because the margin has to be trimmed off and the remaining shape padded to fit
the slot. If the geometry is right, every block sits square in its slot with
nothing cut off and even spacing throughout. If a block looks stretched, or has
its top or side sliced away, the padding step is wrong and worth telling me
about.

Files for this: `src/selftest.js` (new), `src/index.js` and `src/draw-image.js`
(changed).

---

## Stage four: the Buffer posts

### New Railway variables

| Name | Needed? | What it is |
|---|---|---|
| `BUFFER_TOKEN` | yes | Your Buffer API key from publish.buffer.com/settings/api |
| `ANTHROPIC_API_KEY` | optional | Lets Claude name the sets and tidy product titles. Without it the bot falls back to a built in list of known sets |
| `BUFFER_LIVE` | no | Leave unset. Posts are created as drafts. Set it to `true` only when you want them scheduled for real |

### What it does

Once the draw image is built, the bot composes the full post set and creates
each one on PokemonFindr and CollectFinder with the image attached:

| Slot | When | Carries |
|---|---|---|
| announcement | no schedule | link, items, bookmark line |
| morning | 9AM ET on draw day | link, items, tips, bookmark line |
| ten_minutes | 10 minutes before | link, items, tips, bookmark line |
| going_live | 1 minute before | link, items, tips |
| thirty_left | 30 minutes after | link, items |
| over | at the draw end | no link, ends at #Pokemon |
| wins_draft | no schedule, PokemonFindr only, no image | the wins wording |

The Discord post is printed into the alert channel for you to copy.

Every post is created as a **draft** carrying its intended send time, so you can
read the whole set in Buffer and approve it. Nothing goes out on its own.

### Trying it before a live draw

`!drawpreview` in the alert channel composes the whole set from stand in
products and prints it, touching neither Buffer nor Canva. Add a number for
more items: `!drawpreview 3`. Read the copy, and tell me about anything that
reads wrong.

`!drawtest` still builds a real image and remains unaffected by this stage.

---

## Getting the announcement out faster

Two settings, and the second matters more.

### 1. Shorten the quiet period

The bot waits for a gap in new items before firing, so it does not build a
five item draw from the first embed it sees. That wait was 5 minutes, which is
nearly all of the delay you see.

Railway variable, no code change:

```
QUIET_PERIOD_MS=30000
```

That is 30 seconds. If the monitor posts every item for a draw in one burst,
30 seconds of silence is ample evidence the draw is complete.

This one is the DRAW period. It also covers the late "Potential WM Droplist"
queue, which is announced 10 to 20 minutes before the drop and so has to stay
fast for the same reason.

The standard queue has its own, set separately:

```
QUEUE_QUIET_PERIOD_MS=300000
```

Default 5 minutes. Do not shorten this one to match the draws. A draw is a
race and you want the announcement out first. A queue drop is announced the
night before, so there is nothing to race, and Droplist embeds are the less
consistent of the two monitors: they can trickle rather than arrive in one
burst. Firing early on a queue means publishing a post that is missing items,
and the stragglers then hit the amend path, which writes nothing and asks for
the run to be handled by hand.

### 2. Publish the announcement automatically

Even with a short quiet period, the announcement sits in Buffer as a draft
until someone presses publish. That human step is now the longest part of the
wait.

```
BUFFER_LIVE_ANNOUNCEMENT=true
```

With that set, the announcement publishes to both X channels the moment it is
composed. The other six posts still land as drafts carrying their schedules,
so nothing else goes out unreviewed.

`BUFFER_LIVE=true` means the whole set goes live: the announcement publishes
immediately and the other six are scheduled for real. The announcement
publishes immediately under either flag.

### A post whose time has passed

Once posting is live, a draw detected after one of its anchors has already gone
by (a draw announced at noon on its own day, whose 9AM reminder cannot run)
would be rejected by Buffer. Those posts are now skipped deliberately and named
in the run summary as "skipped, its send time had already passed", rather than
showing up as failures.

### Expected timing with both

| Step | Time |
|---|---|
| Monitor posts the embeds | 0s |
| Quiet period elapses | 30s |
| Image built and hosted | about 41s |
| Announcement live on both channels | about 45s |

Down from roughly six minutes.

---

## Non Pokemon items in draws

Walmart sometimes puts One Piece, sports cards or another card game through the
same draw. These now appear in the posts, always after Pokemon.

**Headline.** Pokemon sets are named first, 30th Anniversary leading, then
"One Piece TCG", "Sports Cards" or "Other TCG" as applicable.

**Product list.** Pokemon items first with no heading, then a blank line, then
a subheading and the rest. The subheading is named when the non Pokemon items
are all of one kind and generic when they are mixed:

| What is in the draw | Subheading |
|---|---|
| Only One Piece | One Piece TCG Draws |
| Only sports cards | Sports Card Draws |
| Anything mixed, or another game such as Magic or Lorcana | Other TCG Draws |

**Dropped.** Repacks, mystery boxes, and non card merchandise such as
Nendoroids, figures and plush are left out entirely, as before.

**Not recognised.** A product matching none of the patterns is reported in the
run summary as NOT RECOGNISED rather than silently dropped. If one of those is
a card product that should have been posted, say so and the patterns get
updated.

**Image.** Templates now run from 1 to 8 items, so a longer draw still gets a
picture. Past 8, every product still appears in the posts and the image shows
the first 8, which are the highest priority because the run is ordered Pokemon
first. The summary names anything left out of the picture.

---

## Member facing Discord posts

The bot posts four times per draw to a members channel, each pinging the role.

| Slot | When | Carries |
|---|---|---|
| announcement | immediately | items, countdown to the open |
| morning | 9AM ET on draw day | items, tips, countdown to the open |
| going_live | 1 minute before the draw opens | items, countdown to the close |
| thirty_left | 30 minutes after it opens | items, countdown to the close |

### Two new Railway variables

```
DISCORD_MEMBER_CHANNEL_ID=<the channel the posts go to>
DISCORD_MEMBER_ROLE_ID=<the PokeFinder+ role ID>
```

Leave `DISCORD_MEMBER_CHANNEL_ID` unset and none of this runs; the Discord text
is printed to the alert channel for you to paste, as before.

### Finding the role ID

This one matters. When you type `@PokeFinder+` in Discord, the app quietly
turns it into a real mention behind the scenes. A bot sending that same text
sends **plain text that notifies nobody**. It has to send the role's ID.

1. Discord, User Settings, Advanced, turn on **Developer Mode**.
2. Server Settings, Roles, right click **PokeFinder+**, **Copy Role ID**.
3. Paste that number into Railway as `DISCORD_MEMBER_ROLE_ID`.

The channel ID is the same idea: right click the channel, Copy Channel ID.

The bot needs permission to post in that channel and to mention the role. If
the role is not set to "Allow anyone to @mention this role", the bot's own role
needs the **Mention @everyone, @here and All Roles** permission.

### How the schedule survives

Discord has no scheduled posts. The four posts are written to Postgres with
their due times, and a ticker sends whatever has come due. A redeploy or a
crash therefore cannot lose the going live post, which in memory timers would.

A post that fails is retried on the next tick, up to five times, and each
failure is reported to the alert channel with the reason.

---

## Walmart queue runs

The Droplist monitor posts to the same channel as the draw monitor, under the
author name "Walmart Droplist". Those embeds are now collected into queue runs.

### Turning it on

```
QUEUE_ENABLED=true
```

Leave it unset and queue embeds are ignored exactly as they are today, so you
can deploy this and look at it before anything goes live.

### What is different from a draw

| | Draws | Queue |
|---|---|---|
| Timing | read from the embed | worked out: next Wednesday 9PM ET |
| Channels | PokemonFindr and CollectFinder | CollectFinder only |
| Posts | seven | three: announcement, 9AM reminder, 8:59PM going live |
| Image | Canva template, prices shown | composited grid, no prices |
| Grouping | Pokemon, then other card games | Pokemon, Magic, One Piece, Sports Cards |

### The drop date

Queue embeds carry no time at all, so the bot uses the next Wednesday 9PM
Eastern that has not already passed. Embeds landing Tuesday evening point at
the following night. Embeds landing after a Wednesday drop roll on a week.

### Ordering

Groups run Pokemon, Magic: The Gathering, One Piece, Sports Cards, then
anything else. Inside each group it is price descending, except that Magic
leads with its Collector products and sports cards lead with Topps, with the
Bowman and Chrome titles first inside that. Upper Deck and College products are
excluded entirely.

### The grid

Queue images are composited directly rather than built in Canva. A queue grid
is only product photos on the standard background with no text, and its canvas
has to scale with the item count, which would otherwise need a separate Canva
template for every count and every canvas size. Layout follows the existing
convention: three across for three items, three then two for five, four then
three for seven, three by three for nine.

### Trying it first

`!queuepreview` in the alert channel builds a whole run from stand in products
across several games and prints it, with the grid attached as an image. Nothing
reaches Buffer. Add a number for more items, up to 8. The eighth stand in is an
Upper Deck product, so running `!queuepreview 8` also shows the exclusion
working.

### When a draw and a queue drop fall on the same day

Both land on Wednesdays, so the draw's 6PM closing post now hands the audience
straight on to the 9PM queue instead of ending flat:

```
💫 Today's Walmart Draw is Now Over! Next we have a Walmart Queue drop at 9PM EST / 6PM PST!

Queue Link: https://howl.link/ffngiff7nu8la

Pokemon
• ...

Magic: The Gathering
• ...

#Pokemon #ad
```

It ends at `#Pokemon #ad` rather than plain `#Pokemon`, because unlike the
ordinary closing post this one carries a link.

This works whichever run fires first. If the draw run goes first, the queue run
rewrites the already scheduled closing post. If the queue run goes first, the
draw run composes the closing post with the queue in it from the start. The
draw image stays attached either way, since that post is still the draw's.

The rewrite uses Buffer's `editPost` mutation. Buffer documents the mutation
but not the name of its id field, so the bot tries `id` and falls back to
`postId`, remembering which worked. The run summary says how many channels were
rewritten.

### Affiliate links

The bot takes each item's link from the embed's own title link, which Discord
carries on every embed. If you have set the affiliate mapping on the monitor
side, that link arrives already affiliated and is used as is.

A link is treated as an affiliate link when its host matches one of:

```
howl.link, mavely.app.link, go.magik.ly, shopmy.us
```

Override with `AFFILIATE_HOSTS` in Railway, comma separated, if you add
another network.

Anything else, including a plain walmart.com URL and a missing link, falls back
to `https://www.walmart.com/ip/PokeFinder/[PID]`, exactly as before.

Every run summary reports coverage, for example `Affiliate links: 7/9 came
from the monitor`. If that reads 0 out of N, the monitor mapping is not set for
those products and the posts are earning nothing.

This is deliberately not a Google Sheet lookup. The Sheet would need a service
account, would add a lookup that can fail mid run, and would be a second place
affiliate links live. The monitor already knows the mapping.

### Marketplace sellers in the late queue

The potential droplist embeds carry a predicted seller. Walmart.com, and a
missing seller, are first party and stay in the main list. Anything else is a
marketplace seller and gets its own list below, under the seller's name as the
monitor reports it:

```
GT Collectibles and Toys
Pokemon TCG Prismatic Evolutions Booster Bundle https://howl.link/...
```

Nothing is filtered out. If every item is first party there is no heading at
all, so the post reads exactly as it did before. Sellers are ordered by the
best priority item each one has, and inside a section the usual game order
still applies. The grid image is unchanged: all items, one priority order.

### The late queue summary line and shortened names

The title now carries a product summary: Pokemon by set name alone, every
other card game by the game's name, sports cards by their line.

```
💫 Walmart Queue Going Live at 9PM EST / 6PM PST! Mega Evolution, Prismatic Evolutions, Magic The Gathering and Topps Chrome!
```

Groups keep the order the product lists use, so the summary and the lists never
disagree about what leads. That order is Pokemon, One Piece, Magic, Sports,
Other, set once in `GROUP_ORDER` in `src/queue.js` and used by the summary, the
product lists, the group headings and the grid alike. A set with several products is named once. A Pokemon
item whose set the naming step could not place contributes "Pokemon".

Sports lines live in `SPORTS_LINES` in `src/queue-copy.js`, longest first. An
unrecognised brand falls back to "Sports Cards"; add the brand to that list to
name it.

Product list names are shortened for these queue posts only. The whole rule:

| out | |
| --- | --- |
| Pokemon Trading Card Game(s), Pokemon TCG | removed |
| Trading Card(s), Trading Card Game(s) | removed |
| Collectible Card Game | removed |
| a leading "Sports Cards" | removed |
| Magic: The Gathering | MTG |
| One Piece Card Game | One Piece |
| Elite Trainer Box | ETB |
| Ultra Premium Collection | UPC |

Nothing else is touched, so pack counts, variant names and set names all stay.
The standard queue posts are unchanged: their group headings already carry the
game, so their names are short already.

### Fixes found by running a full sample queue

Two live bugs, both caught by driving a realistic six item Wednesday drop
through the whole pipeline rather than reasoning about it:

- `classifyQueue` had no merchandise check, so "Pokemon Plush Pikachu 8in"
  classified as Pokemon and would have been posted. It now runs the draw
  path's own `NOT_CARDS` list, imported rather than copied, before the game
  patterns. The queue and the draws can no longer disagree about what a card
  is.
- `cleanTitle` only knew the singular "Pokemon Trading Card Game", so a title
  reading "Pokemon Trading Card Games 30th Celebration" came out as
  "s 30th Celebration". Walmart uses both spellings. This one also affected
  draw posts whenever the naming step fell back to the local list.

The queue headline fallback now uses the same summary rule as the late queue
draft: Pokemon by set, every other game by name, sports by line. The old
fallback named each group's lead product in full and produced headlines over a
hundred characters long.

### The queue schedule

Three tweets, all to CollectFinder:

| slot | when |
| --- | --- |
| announcement | immediately, published |
| one_hour | 8:00PM on drop day |
| going_live | 8:59PM on drop day |

There is no 9AM reminder. A queue drop is announced the night before and
reminded twice on the night itself.

The same day handoff is a fourth post and works whichever run fires first.
Draw first: the queue run rewrites the draw's already scheduled 6PM closing
post in place, keeping its image. Queue first: the draw run looks up the day's
queue run and builds that closing post with the queue wording from the start.
Either way the 6PM post reads:

```
💫 Today's Walmart Draw is Now Over! Next we have a Walmart Queue drop at 9PM EST / 6PM PST!
```

### Going live on queues, in two steps

The queue has its own flag, separate from the draws'. `BUFFER_LIVE` is the
draws' and is already on; it has no effect on queue posts.

| | |
| --- | --- |
| `QUEUE_ENABLED=true` | collect Droplist embeds and produce a run |
| `QUEUE_LIVE=true` | and post it for real |

With `QUEUE_ENABLED=true` alone, a run produces everything it normally would
and sends it to Buffer as drafts: the announcement as a draft with no time, the
two reminders as drafts carrying their intended send times. Nothing sends.

The one thing a dry run deliberately skips is the same day handoff, in both
directions. The draw's 6PM closing post is already scheduled and real, so a
dry run does not rewrite it, and a draw firing while the queue is in drafts
does not pick up the queue wording either. The alert prints the text the
handoff would have written so it can be checked.

The late "Potential WM Droplist" draft is unaffected: it is always a draft,
whatever these flags say.

Boot logs which mode it is in: `queue monitoring is ON, posting to DRAFTS only`.

### The member Discord schedule

| slot | when |
| --- | --- |
| announcement | immediately, with the run |
| one_hour | 4:00PM, an hour before the draw opens |
| going_live | 5:00PM exactly |
| ten_left | 5:50PM, ten minutes before the close |

`going_live` is on the hour, not a minute early like the tweet: the tweet gets
ahead of the draw on purpose, this post marks it actually opening. The ticker
polls every ten seconds, so the worst case is ten seconds late. Shorten the
interval, or move the slot to 16:59:30, if it has to be early rather than
late.

`ten_left` is anchored to the close rather than the open, so a draw that ever
runs longer than an hour still gets its reminder in the last ten minutes.

The tweet schedule is untouched: 9AM morning, 10 minutes out, 4:59PM go live,
30 minutes left.

## BestBuy in store digests

The monitor posts a "Daily Summary" embed per product in
`#bestbuy-instore-monitor`, usually around 1AM and not every day. The bot banks
them and posts one digest to `#instore-alerts` at 7AM.

### Variables

```
BESTBUY_CHANNEL_ID=1488227877248962562          read the summaries from here
BESTBUY_ALERT_CHANNEL_ID=1338323559486980127    post the digest here
BESTBUY_CHECKER_CHANNEL_ID=1386868205783482459  linked in the closing line
BESTBUY_ENABLED=true                            collect and build
BESTBUY_LIVE=true                               and actually post it
```

`BESTBUY_POST_HOUR` overrides the 7AM slot if you ever want it earlier or
later. The role ping reuses `DISCORD_MEMBER_ROLE_ID`.

Two step rollout, the same as queues. With `BESTBUY_ENABLED=true` alone the bot
collects the embeds, builds the digest at 7AM and prints the whole thing to the
alert channel without sending anything to members. Add `BESTBUY_LIVE=true` once
it reads right.

### How the timing works

A run is a collection bucket keyed on the morning it will post, which is the
next 7AM Eastern that has not passed. Embeds at 1:10AM and at 3:40AM share one
key and one digest, so a straggler joins the post rather than causing a second
one. Nothing closes early, because nothing here is a race.

If an embed arrives after the digest has already gone out, it is recorded and
you get an alert saying it missed the post.

### What the digest contains

Products follow the same priority as the draws and the queues: Pokemon first,
then One Piece, Magic, sports and anything else, with the biggest restock
leading inside each group. Ordering and filtering both come from
`classifyQueue`, so BestBuy can never disagree with the rest of the bot about
what a Pokemon product is or what counts as merchandise. Merchandise and the
Upper Deck and college exclusions are dropped; everything else is included.

Each product gets its name, price, total units, state count and units per
region, biggest region first. The opening line bolds every product name.

Titles shorten the way the queue posts shorten theirs, with two BestBuy
additions: the "Pokemon - Trading Card Game:" prefix and the "(1 Ex Box per
Order) - Styles May Vary" suffix come off, and a variant bundle written
"Sylveon ex Box or Greninja ex Box" becomes "Sylveon ex Box / Greninja ex Box".

Region mapping lives in `REGIONS` in `src/bestbuy.js`. A state the monitor names
that is not in the map has its units left out of the regional totals, and you
get an alert naming it, so the numbers can never quietly stop adding up. That
warning earned its keep on the first live scan: the monitor writes the district
as "Washington DC", not "District of Columbia", so its units were being dropped
from every total. `STATE_ABBR` now accepts every spelling of it, and
"Washington" on its own is still the state.

Discord's 2,000 character limit is handled by degrading, never by truncating:
roughly eight products fit in the full form, beyond that it drops to one line
per product, and past that to names only. A test drives 30 products through it
and asserts every name still appears.

### Checking it without waiting for a summary

`!bbpreview` in the alert channel. With no argument it builds the digest from
whatever the monitor has actually banked for the next 7AM slot, which is the
real thing rather than a mock. With no summary banked, or with a number
(`!bbpreview 5`), it uses stand in products so the formatting can still be
checked.

The preview replies with the slot it would post into, the product count, the
character count and which form it used, then prints the digest itself. Mentions
are suppressed on that message, so the role pill is visible but nobody is
pinged, and nothing is written to the run or sent to `#instore-alerts`.

### When a morning goes by with no digest

Three causes look identical from outside: the bot cannot see the monitor
channel, no summary was posted that night, or the parser does not recognise
the embeds. `!bbscan` separates them without waiting for another night.

It reads the last 50 messages (or `!bbscan 100`) from the monitor channel and
reports how many embeds it found, how many parsed as Daily Summaries, and for
anything skipped, the actual author name or Type value that did not match. It
writes nothing. A permissions error in the reply means the bot cannot see the
channel, which is also why nothing would ever be banked.

`!bbretry` resets a run the ticker gave up on. The ticker stops after five
failed attempts; it now says so in the alert rather than going quiet. Fix the
cause, run `!bbretry`, and it is picked up within a minute.

`!bbpreview` reports a stuck run rather than hiding it, and reads the newest
unposted run rather than the oldest. Reading the oldest meant one failed run
made every later preview show stale products.

### Not included

`src/reddit-copy.js` and its tests ship with this but nothing imports them. That
is the Reddit work in progress and it is inert until the posting layer is built.

## Product list ordering

`itemBlock` used to list the Pokemon items in whatever order the monitor sent
the embeds, while the headline was sorted. A draw could therefore announce
"30th Celebration and Prismatic Evolutions" and then list Prismatic first.

Both now sort through `setRank` in `src/copy.js`: 30th Celebration first, then
30th Anniversary, then everything else in arrival order. An item whose set the
naming step could not place sorts last rather than first.

Inside a set, `productRank` orders by product shape: Ultra or Super Premium
first, then Booster Box, Elite Trainer Box, Booster Bundle, 3-Pack Blister,
then anything unrecognised. Walmart hyphenates inconsistently, so
"Ultra-Premium" and "Ultra Premium" rank the same.

Sets stay grouped. Ranking on `setRank` alone would interleave two sets that
share a rank, so the sets are ordered first and each item carries its set's
position rather than just its set's rank.

This covers the tweets and the member Discord posts, which share `itemBlock`.

### Applying a copy change to posts already scheduled

Post bodies are written once, when a run fires, so a wording or ordering
change after that leaves the rest of the day's posts carrying the old text.

`!drawrefresh` rebuilds the member Discord posts for the most recent fired
run using the current code. Posts already sent are left alone, and the due
times are not touched: it changes wording, not the schedule. It reports which
slots it updated and prints the new product order.

The set names are not stored on `draw_items`, only the raw titles, so the
naming step runs again to recover them. The reply says whether that came from
the model or the local fallback.

There is no equivalent for the tweets, because Buffer holds those and they can
be edited through its own API.

## The draw graphic in Discord

Member posts now carry the same Canva graphic as the tweets. `discord_posts`
gained an `image_url` column, filled from the Railway hosted copy of the export
rather than the Canva link, which expires within a day.

The column is added with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so an
existing deployment picks it up on the next boot with nothing manual to do.
Posts scheduled before this deploy have no image and will send without one.

## Per channel reminder schedules

Both X accounts carry every draw. Identical posts at identical times meant
anyone following both saw the same tweet twice at the same minute.

| slot | PokemonFindr | CollectFinder |
| --- | --- | --- |
| announcement | instant | instant |
| morning | 9:00AM | 11:30AM |
| out | 4:50PM, "in 10 Minutes" | 4:30PM, "in 30 Minutes" |
| going_live | 4:59PM | 4:59PM |
| left | 5:30PM, "30 Minutes Left" | 5:45PM, "15 Minutes Left" |
| over | 6:00PM | 6:15PM |

Go live stays simultaneous on purpose: it is the one moment that genuinely is
the moment, and offsetting it only makes one account late.

The schedules live in `SCHEDULES` in `src/copy.js`. `outMinutes` and
`leftMinutes` drive both the clock and the sentence, so a reminder cannot
claim an interval it is not sent at. A test walks every schedule and asserts
the wording matches the timing.

Two slots were renamed, because their interval is no longer fixed:
`ten_minutes` became `out` and `thirty_left` became `left`. Rows already in
`buffer_posts` keep their old slot names; nothing reads them back.

`publishRun` now builds one post set per channel and sends each to its own
channel, walking slot by slot so the announcement reaches both accounts before
anything else is created.

## The graphic matches the list

The draw graphic is built before the posts, and the naming step used to run
inside `publishRun`, which is after. So at image time the items had no set
names and the grid came out in monitor arrival order while the written list
was sorted.

Naming now runs once in `index.js` before the image, `orderedItems` gives the
single display order, and the graphic, the product lists and the alt text are
all filled from it. `publishRun` takes the result as `prenamed` rather than
making the same API call again.

## The Discord announcement as copy-pastable text

Every draw run report in the alert channel is now followed by a second
message holding the member Discord announcement inside a code fence, the same
way `!bbscan` prints its parsed rows. Select it, copy it, paste it anywhere:
what comes out is the raw text, headings and `<@&role>` and `<t:…>` tags
intact, rather than Discord's rendering of it.

A fence also means the block cannot ping anyone, which is the reason it is
safe to print a post carrying the role mention into a channel the role can
see. `allowedMentions` is set to nothing as well, so there are two
independent reasons it stays quiet.

Discord caps a message at 2000 characters. `alertBlock` splits a longer body
on line boundaries and numbers the parts, rather than cutting it off: half an
announcement is no use to paste. A five item announcement is about 490
characters, so this only matters for an unusually large draw.

The same block appears in three places:

- after a live draw run fires, the announcement that was just scheduled
- `!drawrefresh`, the rebuilt announcement, so a wording change can be read
  rather than inferred from the item order
- `!drawpreview`, all four member posts, each in its own fence

### A correction to `!drawpreview`

`!drawpreview` was only ever composing one post set, with no variant, so
after the staggered schedules shipped it was showing the PokemonFindr times
and wording only. I had said it would show both. It now builds both.

Where the two accounts use the same words it prints one copy carrying both
times, as `out (PF 4:50PM / CF 4:30PM)`. The two reminders whose wording
differs between the accounts are printed twice, labelled by account.

## The BestBuy digest needs BESTBUY_LIVE

`BESTBUY_ENABLED=true` starts the ticker. It does not send anything. Sending
is gated separately on `BESTBUY_LIVE=true`, so with the first set and the
second missing the digest is built every morning, marked posted and never
sent. The only sign is an alert in the test channel reading "BestBuy digest
BUILT (dry run, nothing sent)" with the full text under it.

Both variables are needed:

- `BESTBUY_ENABLED=true` turns the feature on
- `BESTBUY_LIVE=true` lets it post to the alerts channel

### Recovering a digest a dry run ate

A dry run marks the run posted so it is not rebuilt every minute. That also
puts it out of reach of `!bbretry`, which only touches runs that never
posted, so turning the flag on afterwards finds nothing to send.

`!bbresend` reopens the most recent digest whatever its state, clearing the
post and the attempt count so the ticker claims it again. It says what the
run's previous state was, and warns when the digest genuinely did go out, so
a live resend is a deliberate choice rather than an accident. It also refuses
to be useful quietly: if `BESTBUY_LIVE` is still not true it says so instead
of building a second dry run in silence.

### A night the bot never saw

Gateway events are not replayed, so a restart, deploy or permission change
between the 1AM burst and the 7AM post loses the night: the embeds sit in the
channel and nothing is banked. `!bbscan` only reads, which is why it could
not show this.

`!bbbackfill [1-100]` reads the same history and writes it. Each embed is
dated by its own message rather than by the current time, so a 1AM embed is
filed against that morning's 7AM slot. A slot that has passed makes the run
due at once and the ticker sends within the minute.

`!bbscan` also used to print only the first 10 parsed rows under an accurate
count, which read as a parser miss. The cap is now 25.

### The digest follows the draw ordering

The BestBuy post used to sort by group and then by units, so the biggest
restock of the night led regardless of what it was. It now uses the same
convention as the Walmart draws: Pokemon first with its sets held together
and 30th Celebration leading, products inside a set running Ultra or Super
Premium, Booster Box, Elite Trainer Box, Booster Bundle, blister, then the
other games in queue order. Units only break ties that remain.

That needs set names, so `nameItems` now runs before the digest is built, the
same call the draws make. It falls back to local naming by itself, so a
naming outage costs the set grouping and never the post.

### Overnight timing

The burst has been arriving from around midnight rather than 1AM. Nothing
needed changing: an embed is filed against the next 7AM that has not passed,
so anything from late evening through 6:59AM lands in that morning's digest
and an 11:45PM embed shares a post with a 3AM one. The only cliff is 7AM.

### Env flags are no longer exact string matches

Every flag used to be compared against the literal string `true`, so
`BESTBUY_LIVE=True`, `TRUE`, `1`, or a value with a stray space read as off,
and the bot reported itself as off without saying why. This cost a morning.

`true`, `1`, `yes` and `on` are all accepted now, in any case, with
surrounding whitespace trimmed. The same change applies to `BESTBUY_ENABLED`,
`QUEUE_ENABLED`, `QUEUE_LIVE`, `BUFFER_LIVE` and `BUFFER_LIVE_ANNOUNCEMENT`.

A wrong variable NAME still cannot be guessed at, so the bot now shows what it
reads instead of only its verdict. `!bbstatus` prints every BestBuy setting as
this process sees it, including a name that is simply absent, and `!bbresend`
quotes the value it read when it declines to go live.

### Digest copy: the list is the post

The opening line used to name every product before the reader reached the
list, which on a big night was most of the message. It is now one line that
names none of them, and the bulleted list carries everything.

Regions are gone. Units and states are what a reader acts on; "mostly West"
told them nothing they could use.

The degradation ladder changed with it. Full is one bullet per product with
price, units and states. Too long drops to name and price. Too long again
keeps as many names as fit and ends with "and N more", rather than silently
cutting the bottom off the list.

### Name shortening for BestBuy titles

BestBuy writes titles the draws never see, so several were coming through at
full length:

- `Mega Evolution—Delta Reign Elite Trainer Box` kept its series prefix. The
  prefix is stripped only when a dash follows it, because the base Mega
  Evolution set's own products carry the name with nothing after it.
- `(1 Ultra-Premium Collection per Order)` survived: the old rule matched the
  Ex Box wording alone. Any `(1 ... per Order)` is dropped now, since the post
  states the cap anyway.
- `Ultra-Premium Collection` never became UPC, because the shortener only
  knows the spaced spelling. The hyphen is normalised first.
- `Mewto` is BestBuy's own typo and is corrected to Mewtwo.

The shortener now runs over the naming step's `postName` as well as the raw
title, so a long name from naming gets trimmed instead of passing straight
through.

## Target raffles

Target now runs draws on individual product listings rather than one catchall
page, which changes the shape of the automation in three ways: there is no
single link to post, the draw is live the moment the monitor sees it, and the
membership of a draw changes while it runs.

### Variables

| Name | What it does |
| --- | --- |
| `TARGET_CHANNEL_ID` | The Discord channel the Target Raffles monitor posts into. Required; without it the whole Target path stays off. |
| `TARGET_ENABLED` | `true` to read that channel. Off by default. |
| `TARGET_LIVE` | `true` to publish and schedule. Off means every post is created as a Buffer draft instead, which is how the first real draw should be watched. |
| `TARGET_QUIET_PERIOD_MS` | How long to wait for more listings before firing a run. Default 600000 (10 minutes). Target posts a draw's listings over several minutes, and each one arrives as its own embed. |
| `TARGET_TICK_MS` | How often to look for a reminder coming due. Default 300000 (5 minutes). |
| `TARGET_CLOSE_KEY` | The key the bookmarklet signs its close-time report with. Set it to a fixed value, or it regenerates on every deploy and the bookmark in the bar stops working. |

### Rollout

1. Set `TARGET_CHANNEL_ID` and `TARGET_ENABLED=true`, leaving `TARGET_LIVE`
   unset. The next draw produces a full set of Buffer drafts and an alert, and
   nothing reaches an audience.
2. Read the drafts. Check the item list against the Discord embeds, the ranking
   against the set priority, and the grid against the listings.
3. Set `TARGET_LIVE=true`.

### The close time comes from the bookmarklet

Target shows a draw's close time only to a signed-in visitor, so the bot cannot
read it. The window is also absent from the signed-out page in any form: every
ISO timestamp in it is an experiment-flag expiry, every epoch is a React Query
cache stamp, and the one stray `22:00:00` is store hours.

So HK clicks a bookmarklet on the listing page and it reports the close time
back. `GET /target/bookmarklet?key=$SETUP_KEY` hands out the bookmark to drag,
and the bookmarklet itself posts to `/target/close`. Changing
`bookmarkletSource` means re-dragging the bookmark, because the code lives in
the bookmark rather than on the server.

Times are read as Central and converted, because Target is Minneapolis-based
and writes its copy that way ("Enter by 10am CT on Nov 11" is 11am ET). The
conversion goes through the IANA zone `America/Chicago` rather than a fixed
offset, so a draw either side of a DST boundary lands on the right hour.

### Reminders are built late, on purpose

A Target draw runs for days, and Target adds and removes listings while it is
open. Reminders are therefore NOT created at announcement time: the ticker
finds each one about 15 minutes before it is due, re-checks every listing in
the run, and only then writes the post. A reminder built on Monday would
otherwise still be sending people on Wednesday to listings nobody can enter.

Removal is read from `fast_selling.queue_gated` in the listing's
`__NEXT_DATA__`, which Target serves to Railway's datacenter IP under an honest
bot User-Agent. Only an explicit `false` counts as pulled. Anything
unreadable — a timeout, a bot wall, a changed page shape — is recorded as
unreadable and removes nothing, and if every listing in a run is unreadable the
run is left intact. Target refusing to answer is not the same as a draw being
emptied, and the expensive mistake is dropping a product people can still
enter.

If every listing really has been pulled, the run is closed and an alert says so
rather than a reminder going out for nothing.

### The grid

Composited locally with sharp through the same `buildGrid` the queue uses, not
through Canva: the picture is product photos on a background with no text, so a
template adds nothing and the canvas has to scale with the item count anyway.

The announcement's grid is reused by a reminder only while membership is
unchanged. Once anything has been pulled the grid is rebuilt, since the picture
is what most people read before the text.

A grid that fails to build does not stop the post. Every link and the close
time are in the text, so a failed picture costs reach rather than the
announcement.

### Naming: the series prefix

"Mega Evolution" is a master set with sets of its own under it, and the posts
name the set rather than the series. `Mega Evolution Delta Reign Elite Trainer
Box` is written `Delta Reign Elite Trainer Box`: the prefix is long and would
repeat on every line of a post.

It is stripped only when another known set follows it, because the master set
has its own products too and `Mega Evolution Elite Trainer Box` is that
product's real name. Dropping the prefix there would leave a bare "Elite
Trainer Box" with no set at all.

This replaced the dash-only rule the BestBuy titles needed. Target and Walmart
write the same thing with a space rather than a dash, so matching on the
following set name covers every retailer with one rule instead of one per
retailer. A new set under Mega Evolution needs adding to `KNOWN_SETS` to be
recognised; the strip then follows automatically.

### The member Discord posts

Two per draw, live and closing, matching the `discord` flags on the beats. The
morning reminder deliberately gets no Discord post: members already had the
announcement and will get the hour warning, and a third ping on a draw they
have had a day to enter is what makes people mute a role.

They go through a durable queue in Postgres, the same way the Walmart member
posts do, so a redeploy cannot lose one. Target keeps its own
`target_discord_posts` table rather than a `source` column on `discord_posts`,
because that table's `run_id` is a foreign key into `draw_runs` and a Target
run id would violate it. Sharing one table would have meant dropping that key:
real integrity traded for a saved table.

One scheduler serves both queues. Each claimed row carries its `source`, so
there is one retry policy rather than two poll loops drifting out of step.

Close times are Discord timestamps (`<t:epoch:F>`), not written-out clock
times. They render in each member's own timezone and count themselves down, so
a post written Monday still reads correctly on Wednesday.

Member posts are queued only when `TARGET_LIVE` is set. Drafts are for reading
in Buffer, and a Discord ping cannot be taken back. With no
`DISCORD_MEMBER_CHANNEL_ID` they are skipped rather than queued to nowhere.

## Reddit

**Manual by default.** Reddit closed self-service API access to new
developers, so the bot cannot submit these itself: app creation at
/prefs/apps is gated behind the Responsible Builder Policy and new accounts
are routed to Devvit, which is a different product for apps that run inside
Reddit.

So the same queue that would have posted them delivers them to the alert
channel formatted to paste. The bot still works out the timing, the per sub
split, the item list and the links. The only manual part is the paste.

`REDDIT_MODE=api` switches to submitting, and needs credentials. Everything
below the manual section describes that path, which is built and tested but
has never run against Reddit. If access ever arrives, the same queued rows go
through it with no other change.

### Manual mode

Each due post arrives as a title in its own code block and a body in another,
so each can be copied in one gesture without picking up the other. Code blocks
also stop Discord rendering the markdown, which would turn the links into
previews and make the raw text impossible to copy back out. A long body splits
on line boundaries, never mid link.

Six rows are claimed per tick rather than two: a tick is Discord messages, not
Reddit submissions, and a draw's announcement covers both subs at once.
Delivering half a set and the rest a minute later would read as two separate
things to paste.

With no alert channel configured, posts are left queued rather than failed.
That is a misconfiguration, and burning attempts on it would lose them.

### The API path (not currently usable)

Native posts to both subs, as richtext so one post carries the grid image and
the affiliate links together.

### Why richtext and not markdown

Reddit's submit endpoint takes either a markdown `text` field or a
`richtext_json` document, never both, and only the richtext form can hold an
image alongside formatted text. The web editor sends richtext, which is why a
post made by hand has both. So the bot sends richtext too.

`reddit-richtext.js` converts the small markdown subset `reddit-copy.js`
produces: paragraphs, whole-line bold headings, `*` bullets and inline
`[text](url)` links. It is pure and fully tested, which matters because it is
the half that can be checked without credentials. Anything it does not
recognise passes through as plain text, so a stray asterisk costs a character
rather than a post.

### Variables

| Name | What it does |
| --- | --- |
| `REDDIT_CLIENT_ID` | From the app at reddit.com/prefs/apps. Must be a **web app**. |
| `REDDIT_CLIENT_SECRET` | Same app. |
| `REDDIT_MODE` | `manual` (default) delivers paste ready posts to the alert channel. `api` submits them, and needs credentials Reddit no longer issues. |
| `REDDIT_ENABLED` | `true` to queue and send. Off by default, and independent of `BUFFER_LIVE`: the tweets going live does not mean the subs should start getting posts. |
| `REDDIT_TICK_MS` | How often to send what is due. Default 60000. |
| `REDDIT_DRAW_LINK` / `REDDIT_QUEUE_LINK` | Reddit's own Mavely links, so its earnings separate from Discord's and Twitter's. Defaults are set in code; the variables only override them. Target raffles have no equivalent, since Target gives every item its own listing and there is no catchall page. |
| `REDDIT_SUB_POKECOLLECTORS` / `REDDIT_SUB_TCGHUB` | Sub name overrides, for testing against a private sub. |
| `REDDIT_USER_AGENT` | Reddit throttles or blocks generic agents, so this is not optional furniture. |

### Setup

1. Create the app at reddit.com/prefs/apps as a **web app**, redirect URI
   `https://pokefinder-draws-production.up.railway.app/reddit/redirect`.
2. Set `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`.
3. Turn on **"Allow media in text posts"** in both subs' settings, or the image
   is rejected and the post goes out without it.
4. Open the connect URL printed at startup and authorize. The redirect page
   names any scope that was not granted.
5. Set `REDDIT_ENABLED=true`.

`duration=permanent` is requested, or Reddit issues a one hour token and no
refresh token and the bot stops posting an hour after setup. The refresh token
is stored in the `secrets` table, not in an environment variable, because it is
obtained at runtime.

### Approval is part of posting, not a later step

The `modposts` scope is the load bearing one. HK's own posts to his own subs are
removed instantly by AutoModerator; approving straight after submitting keeps
them up, and the gap between the two is exactly how long the post is invisible.
So submit and approve happen inside one claimed row rather than in separate
ticks.

A failed approve does not fail the post. The submission is already up, and
recording it is what lets a retry approve it rather than post it twice. That
case alerts loudly, because it is the one failure that leaves a post HK cannot
see.

A failed image upload does not fail the post either: the links and the item
list are the point, the grid is decoration.

### Crossposting

`!crosspost <sub> [title]` only, never from a run. Crossposting into subs HK
does not moderate is what risks a domain ban on `howl.link`, and that would
break the affiliate links in his own subs too, including in posts already up.
Keeping it on a separate manual path means a problem there cannot take the
owned-subs path down with it.

No approve step: the bot does not moderate those subs.

### Rate

Two posts per tick and a two second gap between them. Consecutive submissions
from one account inside a second is what Reddit's spam heuristics look for.

## Walmart affiliate links from the sheet

A monitor embed carries an affiliate link only when HK set it by hand, so most
queue and draw items arrived with none and posted as plain PokeFinder URLs,
earning nothing even when a link already existed in the sheet. This closes
that gap.

| Name | What it does |
| --- | --- |
| `WALMART_SHEET_CSV` | The Walmart tab's "publish to web" CSV URL. Unset, every item uses its plain link, exactly as before. |

### Why the published CSV and not the Sheets API

No credential in Railway and no service account, at the cost of being read
only and lagging HK's edits by Google's cache, roughly five minutes. The bot
never writes, and a link added minutes before a drop is an edge case HK fixes
by hand. Moving to a service account later changes how the rows are fetched
and nothing else.

### Resolution order

1. An affiliate link on the embed. HK set that for this drop, so it is the
   most specific thing known about the item.
2. The sheet, keyed on SKU.
3. The standard PokeFinder URL built from the PID.

### What it is careful about

The Set column is populated only on the first row of each block, so it is
carried down. Reading it per row is how two 30th Celebration SKUs were once
reported as belonging to no set at all.

`[AFFILIATE LINK NEEDED]` in the affiliate cell counts as no link. Posting the
placeholder as a URL would be worse than posting none.

A missing SKU or Affiliate Link column throws rather than returning an empty
map, because an empty map is indistinguishable from "no links known" and would
quietly post plain URLs for everything. Column headers are matched on a
substring, so renaming "Affiliate Link" to "Affiliate Links" is fine.

An unpublished sheet answers with an HTML error page and HTTP 200, which would
otherwise parse as one nonsense row, so that is detected.

A failed refresh serves the last good copy. A drop with slightly stale links
beats a drop with none. A sheet that cannot be read at all never stops a drop
posting: items fall back to plain links and the alert channel says so once per
process rather than once per embed.

### Missing links are reported, not asked for

At startup the bot posts the SKUs that still have no affiliate link to the
alert channel, pinging `ALERT_USER_ID` when one is set. Grouped by set,
because that is how the sheet is laid out and how the gaps get worked through;
a flat list of eleven SKUs means hunting for each row.

Sent only when the alert has CHANGED since the last time it was sent, where
"the alert" means the set of missing SKUs AND whether it carries a mention.
Covering the mention matters: the first version hashed only the SKUs, so
adding `ALERT_USER_ID` left the list identical and suppressed the very send
that would have carried the ping. Railway rolls containers over on every deploy and several can land
inside a minute, so alerting on each boot would be the same message three
times. The SKUs are sorted into the fingerprint, so resorting the sheet is not a
change and neither is renaming a product. Neither is worth a second ping.

The fingerprint lives in the `secrets` table rather than in memory, precisely
because the process restarts: an in-memory one would never suppress anything.

Nothing is sent when nothing is missing. An all clear on every boot is noise,
and the absence of the message already says the sheet is complete.

`[AFFILIATE LINK NEEDED]` counts as missing, so a placeholder gets chased
rather than quietly passing for a filled cell.

Each item carries its own link, taken from the sheet's own link column rather
than built from the SKU, so a wrong slug cannot creep in. Rows with no link in
that column fall back to the PokeFinder form.

Every URL is wrapped in angle brackets. Without that Discord renders a preview
card per link, and eleven missing SKUs would bury the message under eleven
embeds.

The alert is split across messages rather than truncated. `alert()` cuts at
1900 characters, which on a long list would silently drop the SKUs at the
bottom, which are the ones not got to yet.

| Name | What it does |
| --- | --- |
| `ALERT_USER_ID` | Discord user ID to @ in the missing links alert. Without it the alert still goes out, just unpinged. |
| `WALMART_SHEET_URL` | The sheet's edit URL, linked in the alert so one message has everything. Optional. |

### `!sheet`

Refetches immediately past the cache and reports the same list on demand. It
also resets the dedup, so the next startup reports again rather than staying
silent because this reply already said it.
### Target raffles on Reddit

Two posts, not the three the tweets get: the live announcement and the hour
before close. A Reddit post stays findable in the subreddit, so the
announcement is still doing its job on day two, and a third submission about
one draw to one sub reads as spam. Losing the subreddit costs more than a
missed reminder.

The live title states the deadline rather than saying it is live. Reddit
titles cannot be edited, and "live now" stops being news tomorrow while the
deadline stays true for the whole window.

No tips block. The Walmart tips are about saving a card and re-entering an
address on walmart.com, none of which applies to a Target raffle.

Every item carries its own link on its own line, because Target has no
catchall draw page to put in an Enter Here line.

Queued for the same slots the run is building, so a reminder pass does not
re-queue the announcement, and queued last and caught, so a Reddit problem
cannot cost the tweets or the Discord posts.
