import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SUPPORTED_TRAINER_SCHEMA_VERSION = 1;

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
  keylab_profile TEXT
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

export interface TrainerStore {
  database: Database;
  startSession(session: Omit<SessionRecord, "id" | "endedTs">): number;
  finishSession(sessionId: number, endedTs: number): void;
  recordKeystrokes(sessionId: number, keystrokes: readonly KeystrokeRecord[]): void;
  sessions(mode?: SessionMode): SessionRecord[];
  close(): void;
}

export function defaultTrainerPath(): string {
  return join(homedir(), ".local/share/glove80-lab/trainer.db");
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
    database.close();
    throw new Error(
      `Unsupported trainer schema_version ${JSON.stringify(version.value)}; `
      + `expected ${SUPPORTED_TRAINER_SCHEMA_VERSION}`,
    );
  }
  database.query("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)")
    .run(String(SUPPORTED_TRAINER_SCHEMA_VERSION));

  return {
    database,
    startSession(session) {
      database.query(`
        INSERT INTO session(started_ts, mode, language, corpus_id, corpus_version, seed,
                            device_label, keylab_profile)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.startedTs, session.mode, session.language, session.corpusId,
        session.corpusVersion, session.seed, session.deviceLabel, session.keylabProfile,
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
    sessions(mode) {
      const rows = mode
        ? database.query("SELECT * FROM session WHERE mode = ? ORDER BY id").all(mode)
        : database.query("SELECT * FROM session ORDER BY id").all();
      return (rows as Array<Record<string, unknown>>).map((row) => ({
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
      }));
    },
    close() {
      database.close();
    },
  };
}
