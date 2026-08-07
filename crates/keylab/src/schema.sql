CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS device (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  uniq         TEXT,
  first_ts     INTEGER NOT NULL,
  keymap_kind  TEXT,
  keymap_hash  TEXT
);

CREATE TABLE IF NOT EXISTS profile (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

-- `id` is a surrogate: six child tables reference `bucket(id)`, so it has to stay a single opaque
-- column. The seal second lives in `ts`, and identity is the triple below — one bucket per device
-- per profile per second. Two keyboards sealing in the same second are two buckets, not a
-- collision. The UNIQUE constraint's own index leads with `ts`, which is what every range read
-- filters on, so no separate index on `ts` is warranted.
CREATE TABLE IF NOT EXISTS bucket (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  device_id   INTEGER NOT NULL REFERENCES device(id),
  profile_id  INTEGER REFERENCES profile(id),
  span_ms     INTEGER NOT NULL,
  active_ms   INTEGER NOT NULL,
  keystrokes  INTEGER NOT NULL,
  autorepeats INTEGER NOT NULL,
  UNIQUE (ts, device_id, profile_id)
);

CREATE TABLE IF NOT EXISTS finger_count (
  bucket_id INTEGER NOT NULL REFERENCES bucket(id),
  finger_id INTEGER NOT NULL,
  presses   INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, finger_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS row_count (
  bucket_id INTEGER NOT NULL REFERENCES bucket(id),
  hand      INTEGER NOT NULL,
  row_idx   INTEGER NOT NULL,
  presses   INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, hand, row_idx)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS hold_hist (
  bucket_id  INTEGER NOT NULL REFERENCES bucket(id),
  finger_id  INTEGER NOT NULL,
  dur_bucket INTEGER NOT NULL,
  n          INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, finger_id, dur_bucket)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS mod_hold_hist (
  bucket_id  INTEGER NOT NULL REFERENCES bucket(id),
  mod_class  INTEGER NOT NULL,
  dur_bucket INTEGER NOT NULL,
  n          INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, mod_class, dur_bucket)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS gap_hist (
  bucket_id  INTEGER NOT NULL REFERENCES bucket(id),
  hand       INTEGER NOT NULL,
  gap_bucket INTEGER NOT NULL,
  n          INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, hand, gap_bucket)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS event_count (
  bucket_id INTEGER NOT NULL REFERENCES bucket(id),
  kind      INTEGER NOT NULL,
  subject   INTEGER NOT NULL,
  n         INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, kind, subject)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS key_window (
  id          INTEGER PRIMARY KEY,
  device_id   INTEGER NOT NULL REFERENCES device(id),
  profile_id  INTEGER REFERENCES profile(id),
  start_ts    INTEGER NOT NULL,
  end_ts      INTEGER NOT NULL,
  keystrokes  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pos_count (
  window_id INTEGER NOT NULL REFERENCES key_window(id),
  pos       INTEGER NOT NULL,
  presses   INTEGER NOT NULL,
  PRIMARY KEY (window_id, pos)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ngram_window (
  id          INTEGER PRIMARY KEY,
  device_id   INTEGER NOT NULL REFERENCES device(id),
  profile_id  INTEGER REFERENCES profile(id),
  start_ts    INTEGER NOT NULL,
  end_ts      INTEGER NOT NULL,
  corrections INTEGER NOT NULL,
  degraded    INTEGER NOT NULL,
  dropped     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ngram (
  window_id      INTEGER NOT NULL REFERENCES ngram_window(id),
  pos_a          INTEGER NOT NULL,
  pos_b          INTEGER NOT NULL,
  pos_c          INTEGER NOT NULL,
  mod_mask       INTEGER NOT NULL,
  latency_bucket INTEGER NOT NULL,
  run_bucket     INTEGER NOT NULL,
  n              INTEGER NOT NULL,
  PRIMARY KEY (window_id, pos_a, pos_b, pos_c, mod_mask, latency_bucket, run_bucket)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ngram_finger (
  window_id      INTEGER NOT NULL REFERENCES ngram_window(id),
  finger_a       INTEGER NOT NULL,
  finger_b       INTEGER NOT NULL,
  finger_c       INTEGER NOT NULL,
  mod_mask       INTEGER NOT NULL,
  latency_bucket INTEGER NOT NULL,
  run_bucket     INTEGER NOT NULL,
  n              INTEGER NOT NULL,
  PRIMARY KEY (window_id, finger_a, finger_b, finger_c, mod_mask, latency_bucket, run_bucket)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS live_snapshot (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at INTEGER NOT NULL,
  json       TEXT NOT NULL
);
