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
