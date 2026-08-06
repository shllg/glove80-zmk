import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SUPPORTED_TRAINER_SCHEMA_VERSION = 2;

/**
 * The trainer's own database, separate from keylab's.
 *
 * Hygiene rule from the design: the corpus is self-generated, so day one there is no secret in it —
 * but once corpora are built from your own commits and code the keystroke log contains your source
 * material, and a "type your own text" mode would make it genuinely sensitive. It therefore gets
 * the same 0700 directory, the same CACHEDIR.TAG, and the same backup exclusion as keylab from the
 * start. Do not create a second, laxer standard.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS session (
  id             INTEGER PRIMARY KEY,
  started_ts     INTEGER NOT NULL,
  ended_ts       INTEGER,
  mode           TEXT NOT NULL CHECK (mode IN ('benchmark', 'drill')),
  language       TEXT NOT NULL,
  corpus_id      TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  seed           INTEGER NOT NULL,
  device_label   TEXT NOT NULL,
  keylab_profile TEXT,
  text           TEXT
);

CREATE TABLE IF NOT EXISTS keystroke (
  session_id    INTEGER NOT NULL REFERENCES session(id),
  seq           INTEGER NOT NULL,
  ts_ms         INTEGER NOT NULL,
  code          TEXT NOT NULL,
  expected_code TEXT,
  correct       INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS keystroke_by_expected ON keystroke(expected_code);

-- A separate table, not a kind column on keystroke. Backspace rows inside keystroke would silently
-- change the WPM and accuracy denominators for every historical comparison.
CREATE TABLE IF NOT EXISTS correction (
  session_id    INTEGER NOT NULL REFERENCES session(id),
  seq           INTEGER NOT NULL,
  ts_ms         INTEGER NOT NULL,
  char_index    INTEGER NOT NULL,
  run_length    INTEGER NOT NULL,
  expected_code TEXT,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
`;

const CACHEDIR_TAG = "Signature: 8a477f597d28d172789f06886806bc55\n"
  + "# This directory contains a privacy-sensitive local typing-practice keystroke log.\n";
const DATA_README =
  "This directory contains the keylab trainer's keystroke log. Unlike keylab's aggregates this is\n"
  + "a full, ordered keystroke record of everything typed during a practice session.\n"
  + "Exclude the entire directory from backups, sync tools, and cloud storage.\n";

export type SessionMode = "benchmark" | "drill";

export interface SessionRecord {
  id: number;
  startedTs: number;
  endedTs: number | null;
  mode: SessionMode;
  language: string;
  corpusId: string;
  corpusVersion: string;
  seed: number;
  deviceLabel: string;
  keylabProfile: string | null;
  /**
   * The generated prompt. A correction attributes to a word, and the word is only knowable from the
   * text the corpus produced — a drill's text is not regenerable from `corpusId` and `seed` alone.
   * Null for sessions recorded before schema v2, which therefore cannot be attributed at all.
   *
   * This adds no privacy surface: `keystroke` already holds the full ordered record of what was
   * typed, so the storage hygiene in the comment above is what protects both.
   */
  text: string | null;
}

export interface KeystrokeRecord {
  seq: number;
  tsMs: number;
  /** `KeyboardEvent.code`, i.e. the physical key, not the character it produced. */
  code: string;
  /** The physical key the corpus asked for; `null` when the trainer could not attribute one. */
  expectedCode: string | null;
  correct: boolean;
}

/**
 * One backspace run. `seq` is independent of `keystroke.seq`: corrections have their own sequence
 * within a session, because they are a different instrument reading, not a kind of keystroke.
 */
export interface CorrectionRecord {
  seq: number;
  tsMs: number;
  /** Index in the session text of the *first* character removed. */
  charIndex: number;
  /** How many characters the run removed; a held Backspace or Ctrl+Backspace removes several. */
  runLength: number;
  /** The physical key the corpus asked for at `charIndex`; `null` when none can be attributed. */
  expectedCode: string | null;
}

export interface TrainerStore {
  database: Database;
  startSession(session: Omit<SessionRecord, "id" | "endedTs" | "text"> & { text?: string | null }): number;
  finishSession(sessionId: number, endedTs: number): void;
  recordKeystrokes(sessionId: number, keystrokes: readonly KeystrokeRecord[]): void;
  recordCorrections(sessionId: number, corrections: readonly CorrectionRecord[]): void;
  sessions(mode?: SessionMode): SessionRecord[];
  session(sessionId: number): SessionRecord | null;
  keystrokes(sessionId: number): KeystrokeRecord[];
  corrections(sessionId: number): CorrectionRecord[];
  close(): void;
}

export function defaultTrainerPath(): string {
  return join(homedir(), ".local/share/glove80-lab/trainer.db");
}

function toSessionRecord(row: Record<string, unknown>): SessionRecord {
  return {
    id: Number(row.id),
    startedTs: Number(row.started_ts),
    endedTs: row.ended_ts === null ? null : Number(row.ended_ts),
    mode: row.mode as SessionMode,
    language: String(row.language),
    corpusId: String(row.corpus_id),
    corpusVersion: String(row.corpus_version),
    seed: Number(row.seed),
    deviceLabel: String(row.device_label),
    keylabProfile: row.keylab_profile === null ? null : String(row.keylab_profile),
    text: row.text === null || row.text === undefined ? null : String(row.text),
  };
}

/** Mirrors `prepare_private_storage` in `crates/keylab/src/store.rs`. */
function preparePrivateStorage(databasePath: string): void {
  const directory = dirname(databasePath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  chmodSync(directory, 0o700);
  const mode = lstatSync(directory).mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(`Refusing data directory with mode ${mode.toString(8)}; required 0700`);
  }
  writeFileSync(join(directory, "CACHEDIR.TAG"), CACHEDIR_TAG, { mode: 0o600 });
  writeFileSync(join(directory, "README.txt"), DATA_README, { mode: 0o600 });
  if (existsSync(databasePath)) chmodSync(databasePath, 0o600);
}

/**
 * Migrates an older database in place, in the same style as keylab's daemon: the user is never
 * asked to delete practice history to pick up a schema change.
 *
 * v1 -> v2 added the `correction` table, which the `CREATE TABLE IF NOT EXISTS` above has already
 * applied, and `session.text`, which it has not — `IF NOT EXISTS` does not add columns.
 */
function migrate(database: Database, from: number): void {
  if (from > SUPPORTED_TRAINER_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported trainer schema_version ${JSON.stringify(String(from))}; `
      + `expected ${SUPPORTED_TRAINER_SCHEMA_VERSION}. This database was written by a newer `
      + "trainer; upgrade rather than downgrade, because a downgrade would drop data.",
    );
  }
  if (!Number.isInteger(from) || from < 1) {
    throw new Error(
      `Unsupported trainer schema_version ${JSON.stringify(String(from))}; `
      + `expected ${SUPPORTED_TRAINER_SCHEMA_VERSION}`,
    );
  }
  if (from < 2) {
    const columns = database.query("PRAGMA table_info(session)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "text")) {
      database.exec("ALTER TABLE session ADD COLUMN text TEXT");
    }
  }
  database.query("UPDATE meta SET value = ? WHERE key = 'schema_version'")
    .run(String(SUPPORTED_TRAINER_SCHEMA_VERSION));
}

export function openTrainerStore(path = defaultTrainerPath()): TrainerStore {
  preparePrivateStorage(path);
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON;");
  database.exec(SCHEMA);
  chmodSync(path, 0o600);

  const version = database
    .query("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | null;
  if (version && Number(version.value) !== SUPPORTED_TRAINER_SCHEMA_VERSION) {
    try {
      migrate(database, Number(version.value));
    } catch (error) {
      database.close();
      throw error;
    }
  }
  database.query("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)")
    .run(String(SUPPORTED_TRAINER_SCHEMA_VERSION));

  return {
    database,
    startSession(session) {
      database.query(`
        INSERT INTO session(started_ts, mode, language, corpus_id, corpus_version, seed,
                            device_label, keylab_profile, text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.startedTs, session.mode, session.language, session.corpusId,
        session.corpusVersion, session.seed, session.deviceLabel, session.keylabProfile,
        session.text ?? null,
      );
      const row = database.query("SELECT last_insert_rowid() AS id").get() as { id: number };
      return Number(row.id);
    },
    finishSession(sessionId, endedTs) {
      database.query("UPDATE session SET ended_ts = ? WHERE id = ?").run(endedTs, sessionId);
    },
    recordKeystrokes(sessionId, keystrokes) {
      const insert = database.query(`
        INSERT OR REPLACE INTO keystroke(session_id, seq, ts_ms, code, expected_code, correct)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      // One transaction per batch: a partially written session would silently distort per-position
      // error rates, which the weakness model then treats as ground truth.
      database.transaction(() => {
        for (const keystroke of keystrokes) {
          insert.run(
            sessionId, keystroke.seq, keystroke.tsMs, keystroke.code,
            keystroke.expectedCode, keystroke.correct ? 1 : 0,
          );
        }
      })();
    },
    recordCorrections(sessionId, corrections) {
      const insert = database.query(`
        INSERT OR REPLACE INTO correction(session_id, seq, ts_ms, char_index, run_length,
                                          expected_code)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      database.transaction(() => {
        for (const correction of corrections) {
          insert.run(
            sessionId, correction.seq, correction.tsMs, correction.charIndex,
            correction.runLength, correction.expectedCode,
          );
        }
      })();
    },
    sessions(mode) {
      const rows = mode
        ? database.query("SELECT * FROM session WHERE mode = ? ORDER BY id").all(mode)
        : database.query("SELECT * FROM session ORDER BY id").all();
      return (rows as Array<Record<string, unknown>>).map(toSessionRecord);
    },
    session(sessionId) {
      const row = database.query("SELECT * FROM session WHERE id = ?").get(sessionId);
      return row === null ? null : toSessionRecord(row as Record<string, unknown>);
    },
    keystrokes(sessionId) {
      const rows = database.query(
        "SELECT seq, ts_ms, code, expected_code, correct FROM keystroke "
        + "WHERE session_id = ? ORDER BY seq",
      ).all(sessionId) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        seq: Number(row.seq),
        tsMs: Number(row.ts_ms),
        code: String(row.code),
        expectedCode: row.expected_code === null ? null : String(row.expected_code),
        correct: Number(row.correct) === 1,
      }));
    },
    corrections(sessionId) {
      const rows = database.query(
        "SELECT seq, ts_ms, char_index, run_length, expected_code FROM correction "
        + "WHERE session_id = ? ORDER BY seq",
      ).all(sessionId) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        seq: Number(row.seq),
        tsMs: Number(row.ts_ms),
        charIndex: Number(row.char_index),
        runLength: Number(row.run_length),
        expectedCode: row.expected_code === null ? null : String(row.expected_code),
      }));
    },
    close() {
      database.close();
    },
  };
}
