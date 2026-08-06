import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_NOW = 1_700_000_000;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE device (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, uniq TEXT, first_ts INTEGER NOT NULL,
  keymap_kind TEXT, keymap_hash TEXT
);
CREATE TABLE profile (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE bucket (
  id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES device(id),
  profile_id INTEGER REFERENCES profile(id), span_ms INTEGER NOT NULL,
  active_ms INTEGER NOT NULL, keystrokes INTEGER NOT NULL, autorepeats INTEGER NOT NULL
);
CREATE TABLE finger_count (
  bucket_id INTEGER NOT NULL REFERENCES bucket(id), finger_id INTEGER NOT NULL, presses INTEGER NOT NULL,
  PRIMARY KEY (bucket_id, finger_id)
) WITHOUT ROWID;
CREATE TABLE row_count (
  bucket_id INTEGER NOT NULL REFERENCES bucket(id), hand INTEGER NOT NULL, row_idx INTEGER NOT NULL,
  presses INTEGER NOT NULL, PRIMARY KEY (bucket_id, hand, row_idx)
) WITHOUT ROWID;
CREATE TABLE hold_hist (
  bucket_id INTEGER NOT NULL REFERENCES bucket(id), finger_id INTEGER NOT NULL, dur_bucket INTEGER NOT NULL,
  n INTEGER NOT NULL, PRIMARY KEY (bucket_id, finger_id, dur_bucket)
) WITHOUT ROWID;
CREATE TABLE mod_hold_hist (
  bucket_id INTEGER NOT NULL REFERENCES bucket(id), mod_class INTEGER NOT NULL, dur_bucket INTEGER NOT NULL,
  n INTEGER NOT NULL, PRIMARY KEY (bucket_id, mod_class, dur_bucket)
) WITHOUT ROWID;
CREATE TABLE gap_hist (
  bucket_id INTEGER NOT NULL REFERENCES bucket(id), hand INTEGER NOT NULL, gap_bucket INTEGER NOT NULL,
  n INTEGER NOT NULL, PRIMARY KEY (bucket_id, hand, gap_bucket)
) WITHOUT ROWID;
CREATE TABLE event_count (
  bucket_id INTEGER NOT NULL REFERENCES bucket(id), kind INTEGER NOT NULL, subject INTEGER NOT NULL,
  n INTEGER NOT NULL, PRIMARY KEY (bucket_id, kind, subject)
) WITHOUT ROWID;
CREATE TABLE key_window (
  id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES device(id),
  profile_id INTEGER REFERENCES profile(id), start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL, keystrokes INTEGER NOT NULL
);
CREATE TABLE pos_count (
  window_id INTEGER NOT NULL REFERENCES key_window(id), pos INTEGER NOT NULL, presses INTEGER NOT NULL,
  PRIMARY KEY (window_id, pos)
) WITHOUT ROWID;
CREATE TABLE ngram_window (
  id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES device(id),
  profile_id INTEGER REFERENCES profile(id), start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
  corrections INTEGER NOT NULL, degraded INTEGER NOT NULL, dropped INTEGER NOT NULL
);
CREATE TABLE ngram (
  window_id INTEGER NOT NULL REFERENCES ngram_window(id),
  pos_a INTEGER NOT NULL, pos_b INTEGER NOT NULL, pos_c INTEGER NOT NULL,
  mod_mask INTEGER NOT NULL, latency_bucket INTEGER NOT NULL, run_bucket INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (window_id, pos_a, pos_b, pos_c, mod_mask, latency_bucket, run_bucket)
) WITHOUT ROWID;
CREATE TABLE ngram_finger (
  window_id INTEGER NOT NULL REFERENCES ngram_window(id),
  finger_a INTEGER NOT NULL, finger_b INTEGER NOT NULL, finger_c INTEGER NOT NULL,
  mod_mask INTEGER NOT NULL, latency_bucket INTEGER NOT NULL, run_bucket INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (window_id, finger_a, finger_b, finger_c, mod_mask, latency_bucket, run_bucket)
) WITHOUT ROWID;
CREATE TABLE live_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1), updated_at INTEGER NOT NULL, json TEXT NOT NULL
);
`;

interface MetaPosition {
  pos: number;
  hand: "L" | "R";
  row: number;
  col: number | null;
  baseKeycode: string | null;
}

export interface SeededFixture {
  directory: string;
  path: string;
  metaPath: string;
  recentBucketId: number;
  cleanup(): void;
}

export function createFixture(
  options: { empty?: boolean; schemaVersion?: number; future?: boolean } = {},
): SeededFixture {
  const directory = mkdtempSync(join(tmpdir(), "keylab-analysis-"));
  const path = join(directory, "keylab.db");
  const metaPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../out/keymap-meta.json");
  const metadata = JSON.parse(readFileSync(metaPath, "utf8")) as { positions: MetaPosition[] };
  const database = new Database(path, { create: true });
  database.exec(SCHEMA);
  database.query("INSERT INTO meta(key, value) VALUES (?, ?)").run(
    "schema_version", String(options.schemaVersion ?? 4),
  );
  database.query("INSERT INTO meta(key, value) VALUES (?, ?)").run("alt_hand_ambiguous", "1");
  database.query("INSERT INTO device(id, name, uniq, first_ts, keymap_kind, keymap_hash) VALUES (1, 'fixture', NULL, ?, 'glove80', 'fixture')")
    .run(FIXTURE_NOW - 1_000_000);
  database.query("INSERT INTO profile(id, name) VALUES (1, 'default')").run();
  database.query("INSERT INTO live_snapshot(id, updated_at, json) VALUES (1, ?, ?)")
    .run(FIXTURE_NOW, JSON.stringify({
      finger_count: Array(10).fill(0), keystrokes_per_minute: 0,
      paused: false, profile: "default", profiles: ["default", "gaming"],
    }));

  const recentBucketId = FIXTURE_NOW - 60;
  if (!options.empty) {
    const oldBucketId = FIXTURE_NOW - 8 * 86_400;
    const insertBucket = database.query(
      "INSERT INTO bucket(id, device_id, profile_id, span_ms, active_ms, keystrokes, autorepeats) VALUES (?, 1, 1, 10000, 8000, ?, ?)",
    );
    insertBucket.run(recentBucketId, 100, 5);
    insertBucket.run(oldBucketId, 1_000, 50);

    const insertFinger = database.query(
      "INSERT INTO finger_count(bucket_id, finger_id, presses) VALUES (?, ?, ?)",
    );
    for (const [finger, presses] of [[0, 30], [1, 20], [5, 25], [9, 25]] as const) {
      insertFinger.run(recentBucketId, finger, presses);
    }
    insertFinger.run(oldBucketId, 0, 1_000);

    const insertRow = database.query(
      "INSERT INTO row_count(bucket_id, hand, row_idx, presses) VALUES (?, ?, ?, ?)",
    );
    for (const [hand, row, presses] of [[0, 1, 20], [0, 2, 30], [1, 1, 10], [1, 3, 40]] as const) {
      insertRow.run(recentBucketId, hand, row, presses);
    }
    insertRow.run(oldBucketId, 0, 1, 1_000);

    const insertHold = database.query(
      "INSERT INTO hold_hist(bucket_id, finger_id, dur_bucket, n) VALUES (?, ?, ?, ?)",
    );
    insertHold.run(recentBucketId, 0, 0, 10);
    insertHold.run(recentBucketId, 0, 20, 2);
    insertHold.run(recentBucketId, 0, 21, 1);

    const insertModHold = database.query(
      "INSERT INTO mod_hold_hist(bucket_id, mod_class, dur_bucket, n) VALUES (?, ?, ?, ?)",
    );
    insertModHold.run(recentBucketId, 0, 0, 1);
    insertModHold.run(recentBucketId, 0, 1, 2);
    insertModHold.run(recentBucketId, 0, 21, 1);
    insertModHold.run(recentBucketId, 5, 20, 2);

    const insertEvent = database.query(
      "INSERT INTO event_count(bucket_id, kind, subject, n) VALUES (?, ?, ?, ?)",
    );
    for (const [kind, subject, n] of [
      [0, 0, 2], [1, 0, 3], [2, 0, 1], [3, 0, 2], [3, 4, 1], [3, 6, 1],
    ] as const) {
      insertEvent.run(recentBucketId, kind, subject, n);
    }

    const outerLeft = metadata.positions.find(
      (position) => position.hand === "L" && position.row === 1 && position.col === 6,
    );
    const outerRight = metadata.positions.find(
      (position) => position.hand === "R" && position.row === 1 && position.col === 6,
    );
    const thumbBackspace = metadata.positions.find(
      (position) => position.hand === "R" && position.col === null
        && position.baseKeycode === "KEY_BACKSPACE",
    );
    const rightHomeInner = metadata.positions.find(
      (position) => position.hand === "R" && position.row === 4 && position.col === 1,
    );
    if (!outerLeft || !outerRight || !thumbBackspace || !rightHomeInner) {
      throw new Error("Fixture could not find required keymap positions");
    }

    const insertWindow = database.query(
      "INSERT INTO key_window(id, device_id, profile_id, start_ts, end_ts, keystrokes) VALUES (?, 1, 1, ?, ?, ?)",
    );
    insertWindow.run(1, recentBucketId, recentBucketId + 30, 100);
    insertWindow.run(2, oldBucketId, oldBucketId + 30, 1_000);
    const insertPosition = database.query(
      "INSERT INTO pos_count(window_id, pos, presses) VALUES (?, ?, ?)",
    );
    insertPosition.run(1, outerLeft.pos, 12);
    insertPosition.run(1, outerRight.pos, 20);
    insertPosition.run(1, thumbBackspace.pos, 8);
    insertPosition.run(1, rightHomeInner.pos, 30);
    insertPosition.run(1, -1, 30);
    insertPosition.run(2, rightHomeInner.pos, 1_000);

    // Tier C. Two windows so a key that appears in both has to be summed rather than averaged, one
    // trigram carrying the -2/-1 sentinels, and a window whose counts are split across degraded and
    // dropped so the shares are not both zero.
    const positionOf = (keycode: string): number => {
      const position = metadata.positions.find((entry) => entry.baseKeycode === keycode);
      if (!position) throw new Error(`Fixture could not find keymap position for ${keycode}`);
      return position.pos;
    };
    const [t, h, e, a, s, d, q, w] = (
      ["KEY_T", "KEY_H", "KEY_E", "KEY_A", "KEY_S", "KEY_D", "KEY_Q", "KEY_W"] as const
    ).map(positionOf) as [number, number, number, number, number, number, number, number];

    const insertNgramWindow = database.query(
      "INSERT INTO ngram_window(id, device_id, profile_id, start_ts, end_ts, corrections, degraded, dropped)"
      + " VALUES (?, 1, 1, ?, ?, ?, ?, ?)",
    );
    insertNgramWindow.run(1, recentBucketId, recentBucketId + 30, 320, 50, 20);
    insertNgramWindow.run(2, recentBucketId + 40, recentBucketId + 70, 180, 0, 0);

    const insertNgram = database.query(
      "INSERT INTO ngram(window_id, pos_a, pos_b, pos_c, mod_mask, latency_bucket, run_bucket, n)"
      + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // mod_mask 8 is bit 3, L_SHIFT.
    for (const row of [
      [1, t, h, e, 0, 0, 0, 120],
      [1, t, h, e, 0, 3, 1, 40],
      [1, a, s, d, 8, 2, 2, 60],
      [1, -2, -1, e, 0, 1, 0, 30],
      [2, t, h, e, 0, 0, 0, 80],
      [2, q, w, e, 0, 3, 6, 100],
    ] as const) {
      insertNgram.run(...row);
    }

    const insertNgramFinger = database.query(
      "INSERT INTO ngram_finger(window_id, finger_a, finger_b, finger_c, mod_mask, latency_bucket, run_bucket, n)"
      + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertNgramFinger.run(1, 0, 1, 5, 0, 0, 0, 40);
    insertNgramFinger.run(1, 3, -1, 3, 0, 2, 1, 10);

    if (options.future) {
      const futureTs = FIXTURE_NOW + 60;
      insertBucket.run(futureTs, 77, 0);
      insertFinger.run(futureTs, 2, 77);
      insertRow.run(futureTs, 0, 1, 77);
      insertWindow.run(3, futureTs, futureTs + 30, 88);
      insertPosition.run(3, rightHomeInner.pos, 88);
    }
  }
  database.close();

  return {
    directory,
    path,
    metaPath,
    recentBucketId,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/**
 * Two devices in two different position spaces, each with its own Tier A and Tier B rows. Tier A
 * may be pooled across them; Tier B may not, and the guard has to say so out loud.
 */
export function createMultiDeviceFixture(): SeededFixture {
  const directory = mkdtempSync(join(tmpdir(), "keylab-devices-"));
  const path = join(directory, "keylab.db");
  const metaPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../out/keymap-meta.json");
  const database = new Database(path, { create: true });
  database.exec(SCHEMA);
  database.query("INSERT INTO meta(key, value) VALUES ('schema_version', '4')").run();
  database.query("INSERT INTO meta(key, value) VALUES ('alt_hand_ambiguous', '0')").run();
  database.query(`
    INSERT INTO device(id, name, uniq, first_ts, keymap_kind, keymap_hash) VALUES
      (1, 'Evsieve Virtual Device', NULL, ?, 'glove80', 'glove80-hash'),
      (2, 'AT Translated Set 2 keyboard', NULL, ?, 'qwerty-ansi', 'qwerty-hash')
  `).run(FIXTURE_NOW - 1_000_000, FIXTURE_NOW - 1_000_000);
  database.query("INSERT INTO profile(id, name) VALUES (1, 'default')").run();
  database.query("INSERT INTO live_snapshot(id, updated_at, json) VALUES (1, ?, ?)")
    .run(FIXTURE_NOW, JSON.stringify({
      finger_count: Array(10).fill(0), keystrokes_per_minute: 0,
      paused: false, profile: "default", profiles: ["default"],
    }));

  const recentBucketId = FIXTURE_NOW - 60;
  const insertBucket = database.query(
    "INSERT INTO bucket(id, device_id, profile_id, span_ms, active_ms, keystrokes, autorepeats)"
    + " VALUES (?, ?, 1, 10000, 8000, ?, 0)",
  );
  insertBucket.run(recentBucketId, 1, 100);
  insertBucket.run(recentBucketId + 20, 2, 60);
  const insertFinger = database.query(
    "INSERT INTO finger_count(bucket_id, finger_id, presses) VALUES (?, ?, ?)",
  );
  insertFinger.run(recentBucketId, 0, 100);
  insertFinger.run(recentBucketId + 20, 3, 60);

  const insertWindow = database.query(
    "INSERT INTO key_window(id, device_id, profile_id, start_ts, end_ts, keystrokes)"
    + " VALUES (?, ?, 1, ?, ?, ?)",
  );
  insertWindow.run(1, 1, recentBucketId, recentBucketId + 10, 100);
  insertWindow.run(2, 2, recentBucketId + 20, recentBucketId + 30, 60);
  const insertPosition = database.query(
    "INSERT INTO pos_count(window_id, pos, presses) VALUES (?, ?, ?)",
  );
  insertPosition.run(1, 0, 100);
  insertPosition.run(2, 0, 60);

  // A sealed Tier C window on each keyboard, so an n-gram read that pools them has its own conflict
  // to trip over rather than borrowing the Tier B guard's.
  const insertNgramWindow = database.query(
    "INSERT INTO ngram_window(id, device_id, profile_id, start_ts, end_ts, corrections, degraded, dropped)"
    + " VALUES (?, ?, 1, ?, ?, ?, 0, 0)",
  );
  insertNgramWindow.run(1, 1, recentBucketId, recentBucketId + 10, 500);
  insertNgramWindow.run(2, 2, recentBucketId + 20, recentBucketId + 30, 500);
  const insertNgram = database.query(
    "INSERT INTO ngram(window_id, pos_a, pos_b, pos_c, mod_mask, latency_bucket, run_bucket, n)"
    + " VALUES (?, ?, ?, ?, 0, 0, 0, ?)",
  );
  insertNgram.run(1, 0, 1, 2, 500);
  insertNgram.run(2, 0, 1, 2, 500);
  database.close();

  return {
    directory,
    path,
    metaPath,
    recentBucketId,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/**
 * 100 keystrokes on the `default` profile and 40 on `gaming`, so a filtered read, an unfiltered
 * read, and a pooled read all produce visibly different totals.
 */
export function createProfileFixture(): SeededFixture {
  const directory = mkdtempSync(join(tmpdir(), "keylab-profiles-"));
  const path = join(directory, "keylab.db");
  const metaPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../out/keymap-meta.json");
  const database = new Database(path, { create: true });
  database.exec(SCHEMA);
  database.query("INSERT INTO meta(key, value) VALUES ('schema_version', '4')").run();
  database.query("INSERT INTO meta(key, value) VALUES ('alt_hand_ambiguous', '0')").run();
  database.query("INSERT INTO device(id, name, uniq, first_ts, keymap_kind, keymap_hash) VALUES (1, 'fixture', NULL, ?, 'glove80', 'fixture')")
    .run(FIXTURE_NOW - 1_000_000);
  database.query("INSERT INTO profile(id, name) VALUES (1, 'default'), (2, 'gaming')").run();
  database.query("INSERT INTO live_snapshot(id, updated_at, json) VALUES (1, ?, ?)")
    .run(FIXTURE_NOW, JSON.stringify({
      finger_count: Array(10).fill(0), keystrokes_per_minute: 0,
      paused: false, profile: "default", profiles: ["default", "gaming"],
    }));

  const recentBucketId = FIXTURE_NOW - 60;
  const insertBucket = database.query(
    "INSERT INTO bucket(id, device_id, profile_id, span_ms, active_ms, keystrokes, autorepeats)"
    + " VALUES (?, 1, ?, 10000, 8000, ?, 0)",
  );
  insertBucket.run(recentBucketId, 1, 100);
  insertBucket.run(recentBucketId + 20, 2, 40);

  const insertFinger = database.query(
    "INSERT INTO finger_count(bucket_id, finger_id, presses) VALUES (?, ?, ?)",
  );
  insertFinger.run(recentBucketId, 0, 100);
  insertFinger.run(recentBucketId + 20, 3, 40);

  const insertWindow = database.query(
    "INSERT INTO key_window(id, device_id, profile_id, start_ts, end_ts, keystrokes)"
    + " VALUES (?, 1, ?, ?, ?, ?)",
  );
  insertWindow.run(1, 1, recentBucketId, recentBucketId + 10, 100);
  insertWindow.run(2, 2, recentBucketId + 20, recentBucketId + 30, 40);
  const insertPosition = database.query(
    "INSERT INTO pos_count(window_id, pos, presses) VALUES (?, ?, ?)",
  );
  insertPosition.run(1, 0, 100);
  insertPosition.run(2, 1, 40);
  database.close();

  return {
    directory,
    path,
    metaPath,
    recentBucketId,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
