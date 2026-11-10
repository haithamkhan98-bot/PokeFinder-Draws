-- Stage one schema. Run once with: npm run migrate

CREATE TABLE IF NOT EXISTS draw_runs (
  id             BIGSERIAL PRIMARY KEY,
  draw_date      DATE        NOT NULL UNIQUE,
  status         TEXT        NOT NULL DEFAULT 'collecting',
  starts_at      TIMESTAMPTZ NOT NULL,
  ends_at        TIMESTAMPTZ NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  fired_at       TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  error          TEXT,
  canva_design_id TEXT,
  image_url      TEXT
);

-- status: collecting -> fired -> complete, or error at any point.

CREATE TABLE IF NOT EXISTS draw_items (
  id             BIGSERIAL PRIMARY KEY,
  run_id         BIGINT      NOT NULL REFERENCES draw_runs(id) ON DELETE CASCADE,
  pid            TEXT        NOT NULL,
  raw_title      TEXT        NOT NULL,
  product_name   TEXT,
  price_display  TEXT        NOT NULL,
  price_cents    INTEGER,
  image_url      TEXT,
  classification TEXT        NOT NULL,
  withdrawn      BOOLEAN     NOT NULL DEFAULT FALSE,
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, pid)
);

-- Holds the Buffer post IDs so a partially failed run can resume, and so the
-- amend path can edit the right posts when an item is pulled from a draw.
CREATE TABLE IF NOT EXISTS buffer_posts (
  id             BIGSERIAL PRIMARY KEY,
  run_id         BIGINT      NOT NULL REFERENCES draw_runs(id) ON DELETE CASCADE,
  slot           TEXT        NOT NULL,
  channel_id     TEXT        NOT NULL,
  buffer_post_id TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, slot, channel_id)
);

-- slot: announcement | morning | ten_minutes | going_live | thirty_left | over | wins_draft

-- Single row key/value store. Holds the rotating Canva refresh token, which is
-- single use and must be replaced after every refresh.
CREATE TABLE IF NOT EXISTS secrets (
  key        TEXT PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS draw_items_run_idx   ON draw_items(run_id);
CREATE INDEX IF NOT EXISTS buffer_posts_run_idx ON buffer_posts(run_id);

-- Draw images live in the database rather than on disk. Railway containers get
-- a fresh filesystem on every deploy, and these have to stay reachable for days
-- because Buffer fetches the image when a post SENDS, not when it is scheduled.
-- Keeping them here means a redeploy cannot break a queued post.
CREATE TABLE IF NOT EXISTS draw_images (
  id         TEXT PRIMARY KEY,
  run_id     BIGINT REFERENCES draw_runs(id) ON DELETE SET NULL,
  pid        TEXT,
  kind       TEXT        NOT NULL,
  mime       TEXT        NOT NULL,
  bytes      BYTEA       NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS draw_images_run_idx ON draw_images(run_id);

-- Discord has no scheduled posts, so the bot holds the schedule itself. In
-- memory timers would be lost on every Railway redeploy, which for a going
-- live post means it silently never arrives. Rows here survive restarts and a
-- ticker sends whatever is due.
CREATE TABLE IF NOT EXISTS discord_posts (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT      NOT NULL REFERENCES draw_runs(id) ON DELETE CASCADE,
  slot       TEXT        NOT NULL,
  channel_id TEXT        NOT NULL,
  due_at     TIMESTAMPTZ NOT NULL,
  body       TEXT        NOT NULL,
  posted_at  TIMESTAMPTZ,
  message_id TEXT,
  error      TEXT,
  attempts   INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, slot)
);

CREATE INDEX IF NOT EXISTS discord_posts_due_idx
  ON discord_posts(due_at) WHERE posted_at IS NULL;

-- The draw graphic, so member posts carry the same image as the tweets.
-- Added after the table, so existing deployments pick it up on the next boot.
ALTER TABLE discord_posts ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Walmart's collectibles queue, which drops at 9PM Eastern on Wednesdays.
-- Kept apart from draw_runs because a queue run has no entry window, posts to
-- one channel rather than two, and groups its items by game.
CREATE TABLE IF NOT EXISTS queue_runs (
  id           BIGSERIAL PRIMARY KEY,
  drop_date    DATE        NOT NULL UNIQUE,
  status       TEXT        NOT NULL DEFAULT 'collecting',
  drops_at     TIMESTAMPTZ NOT NULL,
  headline     TEXT,
  image_url    TEXT,
  error        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fired_at     TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS queue_items (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT      NOT NULL REFERENCES queue_runs(id) ON DELETE CASCADE,
  pid           TEXT        NOT NULL,
  raw_title     TEXT        NOT NULL,
  product_name  TEXT,
  price_display TEXT,
  price_cents   INTEGER,
  image_url     TEXT,
  classification TEXT       NOT NULL,
  seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, pid)
);

CREATE TABLE IF NOT EXISTS queue_posts (
  id             BIGSERIAL PRIMARY KEY,
  run_id         BIGINT      NOT NULL REFERENCES queue_runs(id) ON DELETE CASCADE,
  slot           TEXT        NOT NULL,
  channel_id     TEXT        NOT NULL,
  buffer_post_id TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, slot, channel_id)
);

CREATE INDEX IF NOT EXISTS queue_items_run_idx ON queue_items(run_id);

-- BestBuy in store Daily Summaries.
--
-- Unlike draws and queues nothing publishes immediately: embeds arrive around
-- 1AM and the digest goes out at 7AM. A run is therefore a collection bucket
-- keyed on the morning it will be posted, and stays open until the ticker
-- picks it up. A straggler at 3AM joins the same run.
CREATE TABLE IF NOT EXISTS bestbuy_runs (
  id          BIGSERIAL PRIMARY KEY,
  post_date   DATE        NOT NULL UNIQUE,
  post_at     TIMESTAMPTZ NOT NULL,
  body        TEXT,
  form        TEXT,
  posted_at   TIMESTAMPTZ,
  message_id  TEXT,
  error       TEXT,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bestbuy_items (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT      NOT NULL REFERENCES bestbuy_runs(id) ON DELETE CASCADE,
  sku           TEXT        NOT NULL,
  raw_title     TEXT        NOT NULL,
  price_display TEXT,
  link          TEXT,
  image_url     TEXT,
  units         INTEGER     NOT NULL,
  states        INTEGER     NOT NULL,
  stock         JSONB       NOT NULL,
  regions       JSONB       NOT NULL,
  merch         BOOLEAN     NOT NULL DEFAULT false,
  seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, sku)
);

CREATE INDEX IF NOT EXISTS bestbuy_items_run_idx ON bestbuy_items(run_id);
CREATE INDEX IF NOT EXISTS bestbuy_runs_due_idx
  ON bestbuy_runs(post_at) WHERE posted_at IS NULL;

-- Close times for Target draws.
--
-- Target only shows a draw's window to a signed in account, so the bot cannot
-- read it. HK sends it from his own browser with a bookmarklet. Keyed on the
-- TCIN because a draw is a set of individual listings, not one event, and the
-- listings are what he has open when he clicks.
CREATE TABLE IF NOT EXISTS target_close_times (
  tcin        TEXT        PRIMARY KEY,
  closes_at   TIMESTAMPTZ NOT NULL,
  source      TEXT        NOT NULL DEFAULT 'bookmarklet',
  raw         TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Target raffle runs.
--
-- Unlike a Walmart draw or queue drop, a Target draw is not assembled once and
-- then fixed. It is already open when the monitor sees it, it runs for days,
-- and Target adds and removes listings while it runs. So a run stays open for
-- the whole window and its membership is rebuilt before each post, rather than
-- being frozen at first assembly.
--
-- closes_at is nullable because Target only shows the window to a signed in
-- account. It arrives later, from the bookmarklet, and until it does the live
-- announcement still goes out and only the reminders are missing.
CREATE TABLE IF NOT EXISTS target_runs (
  id            BIGSERIAL   PRIMARY KEY,
  status        TEXT        NOT NULL DEFAULT 'collecting',
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closes_at     TIMESTAMPTZ,
  headline      TEXT,
  image_url     TEXT,
  error         TEXT,
  announced_at  TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

-- Items are never deleted, only marked removed. A reminder needs to know what
-- Target pulled so it can say so, and a deleted row cannot tell anyone that.
CREATE TABLE IF NOT EXISTS target_items (
  id             BIGSERIAL   PRIMARY KEY,
  run_id         BIGINT      NOT NULL REFERENCES target_runs(id) ON DELETE CASCADE,
  tcin           TEXT        NOT NULL,
  raw_title      TEXT        NOT NULL,
  product_name   TEXT,
  set_name       TEXT,
  link           TEXT        NOT NULL,
  affiliate      BOOLEAN     NOT NULL DEFAULT false,
  image_url      TEXT,
  classification TEXT        NOT NULL,
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at     TIMESTAMPTZ,
  UNIQUE (run_id, tcin)
);

CREATE TABLE IF NOT EXISTS target_posts (
  id             BIGSERIAL   PRIMARY KEY,
  run_id         BIGINT      NOT NULL REFERENCES target_runs(id) ON DELETE CASCADE,
  slot           TEXT        NOT NULL,
  channel_id     TEXT        NOT NULL,
  buffer_post_id TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, slot, channel_id)
);

CREATE INDEX IF NOT EXISTS target_runs_open_idx
  ON target_runs(opened_at DESC) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS target_items_run_idx ON target_items(run_id);

-- Member facing Discord posts for Target raffles.
--
-- A separate table from discord_posts rather than a source column on it,
-- because that table's run_id is a foreign key into draw_runs and a Target run
-- id would violate it. Dropping the key to share one table would trade real
-- integrity for a saved table.
CREATE TABLE IF NOT EXISTS target_discord_posts (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT      NOT NULL REFERENCES target_runs(id) ON DELETE CASCADE,
  slot       TEXT        NOT NULL,
  channel_id TEXT        NOT NULL,
  due_at     TIMESTAMPTZ NOT NULL,
  body       TEXT        NOT NULL,
  image_url  TEXT,
  posted_at  TIMESTAMPTZ,
  message_id TEXT,
  error      TEXT,
  attempts   INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, slot)
);

CREATE INDEX IF NOT EXISTS target_discord_posts_due_idx
  ON target_discord_posts(due_at) WHERE posted_at IS NULL;
