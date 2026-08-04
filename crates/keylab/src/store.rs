use crate::aggregate::{TierASeal, TierBSeal};
use crate::config::{MIN_BUCKET_SECONDS, MIN_TIER_A_SEAL_FLOOR, MIN_TIER_B_SEAL_COUNT};
use crate::keymap::Keymap;
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS device (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  uniq      TEXT,
  first_ts  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bucket (
  id          INTEGER PRIMARY KEY,
  device_id   INTEGER NOT NULL REFERENCES device(id),
  span_ms     INTEGER NOT NULL,
  active_ms   INTEGER NOT NULL,
  keystrokes  INTEGER NOT NULL,
  autorepeats INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS live_snapshot (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at INTEGER NOT NULL,
  json       TEXT NOT NULL
);
"#;

const CACHEDIR_TAG: &str = concat!(
    "Signature: 8a477f597d28d172789f06886806bc55\n",
    "# This directory contains privacy-sensitive local keystroke aggregates.\n"
);
const DATA_README: &str = concat!(
    "This directory contains keylab's privacy-sensitive local keystroke aggregate database.\n",
    "Exclude the entire directory from backups, sync tools, and cloud storage.\n"
);

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: &Path, keymap: &Keymap, now_ts: i64) -> Result<Self> {
        prepare_private_storage(path)?;
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .context("failed to open keylab database")?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA secure_delete = ON;
                 PRAGMA wal_autocheckpoint = 1000;",
            )
            .context("failed to apply database privacy pragmas")?;
        connection
            .execute_batch(SCHEMA)
            .context("failed to initialize database schema")?;
        initialize_meta(&connection, keymap, now_ts)?;
        Ok(Self { connection })
    }

    pub fn register_device(
        &mut self,
        name: &str,
        uniq: Option<&str>,
        first_ts: i64,
    ) -> Result<i64> {
        // Reconnects must reuse the existing identity, otherwise every reconnect mints a new
        // device_id and fragments the history of one physical keyboard across many rows.
        let existing: Option<i64> = self
            .connection
            .query_row(
                "SELECT id FROM device WHERE name = ?1 AND uniq IS ?2 ORDER BY id LIMIT 1",
                params![name, uniq],
                |row| row.get(0),
            )
            .optional()
            .context("failed to look up a previously registered input device")?;
        if let Some(device_id) = existing {
            return Ok(device_id);
        }
        self.connection
            .execute(
                "INSERT INTO device(name, uniq, first_ts) VALUES (?1, ?2, ?3)",
                params![name, uniq, first_ts],
            )
            .context("failed to register input device")?;
        Ok(self.connection.last_insert_rowid())
    }

    pub fn seal_tier_a(&mut self, device_id: i64, seal: &TierASeal) -> Result<()> {
        if seal.data.keystrokes < MIN_TIER_A_SEAL_FLOOR {
            bail!("refusing to persist a Tier A bucket below the privacy count floor");
        }
        if seal.span_ms < MIN_BUCKET_SECONDS * 1_000 {
            bail!("refusing to persist a Tier A bucket below the privacy time floor");
        }
        let bucket_exists: bool = self
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM bucket WHERE id = ?1)",
                [seal.bucket_id],
                |row| row.get(0),
            )
            .context("failed to check Tier A bucket identity")?;
        if bucket_exists {
            // The verbatim v1 schema has a global bucket-id primary key. If two matching devices
            // share a start second, discarding the later seal records less; reusing the first row
            // would mix device marginals, and inventing a timestamp would falsify bucket identity.
            return Ok(());
        }
        let span_ms = to_i64(seal.span_ms, "Tier A span")?;
        let active_ms = to_i64(seal.data.active_ms, "active time")?;
        let transaction = self
            .connection
            .transaction()
            .context("failed to begin Tier A transaction")?;
        transaction
            .execute(
                "INSERT INTO bucket(id, device_id, span_ms, active_ms, keystrokes, autorepeats)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    seal.bucket_id,
                    device_id,
                    span_ms,
                    active_ms,
                    seal.data.keystrokes,
                    seal.data.autorepeats
                ],
            )
            .context("failed to write Tier A bucket")?;

        write_finger_counts(&transaction, seal)?;
        write_row_counts(&transaction, seal)?;
        write_hold_histograms(&transaction, seal)?;
        write_modifier_histograms(&transaction, seal)?;
        write_gap_histograms(&transaction, seal)?;
        write_event_counts(&transaction, seal)?;
        transaction
            .commit()
            .context("failed to commit Tier A transaction")
    }

    pub fn seal_tier_b(&mut self, device_id: i64, seal: &TierBSeal) -> Result<()> {
        if seal.keystrokes < MIN_TIER_B_SEAL_COUNT {
            bail!("refusing to persist a Tier B window below the privacy count floor");
        }
        let position_total = seal
            .pos_count
            .iter()
            .copied()
            .fold(0_u32, u32::saturating_add);
        if position_total != seal.keystrokes {
            bail!("refusing to persist an inconsistent Tier B position histogram");
        }
        let start_ts = to_i64(seal.start_ts, "Tier B start timestamp")?;
        let end_ts = to_i64(seal.end_ts, "Tier B end timestamp")?;
        let transaction = self
            .connection
            .transaction()
            .context("failed to begin Tier B transaction")?;
        transaction
            .execute(
                "INSERT INTO key_window(device_id, start_ts, end_ts, keystrokes)
                 VALUES (?1, ?2, ?3, ?4)",
                params![device_id, start_ts, end_ts, seal.keystrokes],
            )
            .context("failed to write Tier B window")?;
        let window_id = transaction.last_insert_rowid();
        for (index, presses) in seal.pos_count.iter().copied().enumerate() {
            if presses == 0 {
                continue;
            }
            let pos = if index == 80 {
                -1
            } else {
                i64::try_from(index).context("position index does not fit SQLite integer")?
            };
            transaction
                .execute(
                    "INSERT INTO pos_count(window_id, pos, presses) VALUES (?1, ?2, ?3)",
                    params![window_id, pos, presses],
                )
                .context("failed to write Tier B position count")?;
        }
        transaction
            .commit()
            .context("failed to commit Tier B transaction")
    }

    pub fn replace_live_snapshot(
        &mut self,
        updated_at: i64,
        finger_counts: &[u32; 10],
        keystrokes: u32,
        elapsed_ms: u64,
    ) -> Result<()> {
        let rate = if elapsed_ms == 0 {
            0.0
        } else {
            f64::from(keystrokes) * 60_000.0 / elapsed_ms as f64
        };
        let snapshot = serde_json::to_string(&json!({
            "finger_count": finger_counts,
            "keystrokes_per_minute": rate,
        }))
        .context("failed to encode live snapshot")?;
        self.connection
            .execute(
                "REPLACE INTO live_snapshot(id, updated_at, json) VALUES (1, ?1, ?2)",
                params![updated_at, snapshot],
            )
            .context("failed to replace live snapshot")?;
        Ok(())
    }

    pub fn close(self) -> Result<()> {
        self.connection
            .close()
            .map_err(|(_, error)| error)
            .context("failed to close keylab database")
    }

    #[cfg(test)]
    fn connection(&self) -> &Connection {
        &self.connection
    }
}

fn prepare_private_storage(db_path: &Path) -> Result<()> {
    let data_dir = db_path
        .parent()
        .context("database path must have a parent directory")?;
    if data_dir.exists() {
        verify_exact_mode(data_dir, 0o700, "data directory")?;
    } else {
        let mut builder = DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(data_dir)
            .context("failed to create private data directory")?;
        fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))
            .context("failed to set private data directory mode")?;
        verify_exact_mode(data_dir, 0o700, "data directory")?;
    }

    write_private_file(&data_dir.join("CACHEDIR.TAG"), CACHEDIR_TAG)?;
    write_private_file(&data_dir.join("README.txt"), DATA_README)?;

    if db_path.exists() {
        verify_exact_mode(db_path, 0o600, "database file")?;
    } else {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(db_path)
            .context("failed to create private database file")?;
        fs::set_permissions(db_path, fs::Permissions::from_mode(0o600))
            .context("failed to set private database mode")?;
        verify_exact_mode(db_path, 0o600, "database file")?;
    }
    Ok(())
}

fn write_private_file(path: &Path, content: &str) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .with_context(|| format!("failed to create {}", path.display()))?;
    file.write_all(content.as_bytes())
        .with_context(|| format!("failed to write {}", path.display()))?;
    file.sync_all()
        .with_context(|| format!("failed to sync {}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("failed to set mode on {}", path.display()))?;
    verify_exact_mode(path, 0o600, "privacy marker")
}

fn verify_exact_mode(path: &Path, expected: u32, description: &str) -> Result<()> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("failed to inspect {description}"))?;
    if metadata.file_type().is_symlink() {
        bail!("refusing symlink for {description}");
    }
    let actual = metadata.mode() & 0o777;
    if actual != expected {
        bail!("refusing {description} with mode {actual:04o}; required {expected:04o}");
    }
    Ok(())
}

fn initialize_meta(connection: &Connection, keymap: &Keymap, now_ts: i64) -> Result<()> {
    let schema_version: Option<String> = connection
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .context("failed to read schema version")?;
    if schema_version.as_deref().is_some_and(|value| value != "1") {
        bail!("unsupported database schema version");
    }
    connection
        .execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')",
            [],
        )
        .context("failed to initialize schema version")?;
    connection
        .execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('daemon_version', ?1)",
            [env!("CARGO_PKG_VERSION")],
        )
        .context("failed to write daemon version")?;
    connection
        .execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('git_commit', ?1)",
            [&keymap.git_commit],
        )
        .context("failed to write git commit")?;
    connection
        .execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES ('created_at', ?1)",
            [now_ts.to_string()],
        )
        .context("failed to write creation timestamp")?;
    connection
        .execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('alt_hand_ambiguous', ?1)",
            [if keymap.alt_hand_ambiguous { "1" } else { "0" }],
        )
        .context("failed to write ALT ambiguity marker")?;

    let previous_hash: Option<String> = connection
        .query_row(
            "SELECT value FROM meta WHERE key = 'keymap_hash'",
            [],
            |row| row.get(0),
        )
        .optional()
        .context("failed to read keymap hash")?;
    let history_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM meta WHERE key = 'keymap_hash_history')",
            [],
            |row| row.get(0),
        )
        .context("failed to inspect keymap hash history")?;
    if !history_exists {
        append_keymap_history(
            connection,
            previous_hash.as_deref().unwrap_or(&keymap.hash),
            now_ts,
        )?;
    }
    if previous_hash
        .as_deref()
        .is_some_and(|hash| hash != keymap.hash)
    {
        append_keymap_history(connection, &keymap.hash, now_ts)?;
    }
    connection
        .execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('keymap_hash', ?1)",
            [&keymap.hash],
        )
        .context("failed to write keymap hash")?;
    Ok(())
}

fn append_keymap_history(connection: &Connection, hash: &str, from_ts: i64) -> Result<()> {
    let existing: Option<String> = connection
        .query_row(
            "SELECT value FROM meta WHERE key = 'keymap_hash_history'",
            [],
            |row| row.get(0),
        )
        .optional()
        .context("failed to read keymap hash history")?;
    let mut history = match existing {
        Some(value) => serde_json::from_str::<Value>(&value)
            .context("invalid keymap hash history in database")?,
        None => Value::Array(Vec::new()),
    };
    let entries = history
        .as_array_mut()
        .context("keymap hash history is not a JSON array")?;
    entries.push(json!({ "hash": hash, "from_ts": from_ts }));
    let encoded =
        serde_json::to_string(&history).context("failed to encode keymap hash history")?;
    connection
        .execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('keymap_hash_history', ?1)",
            [encoded],
        )
        .context("failed to write keymap hash history")?;
    Ok(())
}

fn write_finger_counts(transaction: &Transaction<'_>, seal: &TierASeal) -> Result<()> {
    for (finger_id, presses) in seal.data.finger_count.iter().copied().enumerate() {
        if presses > 0 {
            transaction
                .execute(
                    "INSERT INTO finger_count(bucket_id, finger_id, presses) VALUES (?1, ?2, ?3)",
                    params![seal.bucket_id, finger_id, presses],
                )
                .context("failed to write finger marginal")?;
        }
    }
    Ok(())
}

fn write_row_counts(transaction: &Transaction<'_>, seal: &TierASeal) -> Result<()> {
    for (index, presses) in seal.data.row_count.iter().copied().enumerate() {
        if presses > 0 {
            let hand = index / 6;
            let row_idx = index % 6 + 1;
            transaction
                .execute(
                    "INSERT INTO row_count(bucket_id, hand, row_idx, presses) VALUES (?1, ?2, ?3, ?4)",
                    params![seal.bucket_id, hand, row_idx, presses],
                )
                .context("failed to write row marginal")?;
        }
    }
    Ok(())
}

fn write_hold_histograms(transaction: &Transaction<'_>, seal: &TierASeal) -> Result<()> {
    for (finger_id, histogram) in seal.data.hold_hist.iter().enumerate() {
        for (bucket, count) in histogram.iter().copied().enumerate() {
            if count > 0 {
                transaction
                    .execute(
                        "INSERT INTO hold_hist(bucket_id, finger_id, dur_bucket, n) VALUES (?1, ?2, ?3, ?4)",
                        params![seal.bucket_id, finger_id, bucket, count],
                    )
                    .context("failed to write hold histogram")?;
            }
        }
    }
    Ok(())
}

fn write_modifier_histograms(transaction: &Transaction<'_>, seal: &TierASeal) -> Result<()> {
    for (mod_class, histogram) in seal.data.mod_hold_hist.iter().enumerate() {
        for (bucket, count) in histogram.iter().copied().enumerate() {
            if count > 0 {
                transaction
                    .execute(
                        "INSERT INTO mod_hold_hist(bucket_id, mod_class, dur_bucket, n) VALUES (?1, ?2, ?3, ?4)",
                        params![seal.bucket_id, mod_class, bucket, count],
                    )
                    .context("failed to write modifier hold histogram")?;
            }
        }
    }
    Ok(())
}

fn write_gap_histograms(transaction: &Transaction<'_>, seal: &TierASeal) -> Result<()> {
    for (hand, histogram) in seal.data.gap_hist.iter().enumerate() {
        for (bucket, count) in histogram.iter().copied().enumerate() {
            if count > 0 {
                transaction
                    .execute(
                        "INSERT INTO gap_hist(bucket_id, hand, gap_bucket, n) VALUES (?1, ?2, ?3, ?4)",
                        params![seal.bucket_id, hand, bucket, count],
                    )
                    .context("failed to write gap histogram")?;
            }
        }
    }
    Ok(())
}

fn write_event_counts(transaction: &Transaction<'_>, seal: &TierASeal) -> Result<()> {
    for (kind, subjects) in seal.data.event_count.iter().enumerate() {
        for (subject, count) in subjects.iter().copied().enumerate() {
            if count > 0 {
                transaction
                    .execute(
                        "INSERT INTO event_count(bucket_id, kind, subject, n) VALUES (?1, ?2, ?3, ?4)",
                        params![seal.bucket_id, kind, subject, count],
                    )
                    .context("failed to write behavioral counter")?;
            }
        }
    }
    Ok(())
}

fn to_i64(value: u64, description: &str) -> Result<i64> {
    i64::try_from(value).with_context(|| format!("{description} exceeds SQLite integer range"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aggregate::{Aggregator, TierAAccumulator};
    use crate::encode::{BSP_BURST, BSP_BURST_AFTER_MOD, LONELY_MOD, MOD_DURING_ALPHA};
    use crate::keymap::KeyInfo;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn keymap() -> Keymap {
        Keymap::fixture(&[
            (
                30,
                KeyInfo {
                    pos: 0,
                    hand: 0,
                    finger_id: 0,
                    row_idx: 4,
                },
            ),
            (
                14,
                KeyInfo {
                    pos: 2,
                    hand: 1,
                    finger_id: 8,
                    row_idx: 3,
                },
            ),
        ])
    }

    fn open_store() -> (TempDir, PathBuf, Store, i64) {
        let temp = TempDir::new().unwrap_or_else(|error| panic!("{error}"));
        let data_dir = temp.path().join("data");
        let db_path = data_dir.join("keylab.db");
        let mut store =
            Store::open(&db_path, &keymap(), 1_000).unwrap_or_else(|error| panic!("{error:#}"));
        let device_id = store
            .register_device("fixture", None, 1_000)
            .unwrap_or_else(|error| panic!("{error:#}"));
        (temp, db_path, store, device_id)
    }

    #[test]
    fn reconnecting_reuses_the_existing_device_row() {
        let (_temp, _path, mut store, device_id) = open_store();
        let reconnected = store
            .register_device("fixture", None, 2_000)
            .unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(reconnected, device_id);
        let other = store
            .register_device("other", None, 2_000)
            .unwrap_or_else(|error| panic!("{error:#}"));
        assert_ne!(other, device_id);
        let rows: i64 = store
            .connection()
            .query_row("SELECT COUNT(*) FROM device", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(rows, 2);
    }

    #[test]
    fn applies_all_database_pragmas() {
        let (_temp, _path, store, _device_id) = open_store();
        let connection = store.connection();
        let journal: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"));
        let synchronous: i64 = connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"));
        let secure_delete: i64 = connection
            .query_row("PRAGMA secure_delete", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"));
        let checkpoint: i64 = connection
            .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(journal, "wal");
        assert_eq!(synchronous, 1);
        assert_eq!(secure_delete, 1);
        assert_eq!(checkpoint, 1_000);
    }

    #[test]
    fn initializes_required_meta_and_tracks_keymap_boundaries() {
        let (temp, db_path, store, _device_id) = open_store();
        let connection = store.connection();
        let schema_version: String = connection
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let initial_history: String = connection
            .query_row(
                "SELECT value FROM meta WHERE key = 'keymap_hash_history'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema_version, "1");
        let initial: Value = serde_json::from_str(&initial_history).unwrap();
        assert_eq!(initial.as_array().map(Vec::len), Some(1));
        store.close().unwrap();

        let mut changed = keymap();
        changed.hash = "changed".to_owned();
        let changed_store = Store::open(&db_path, &changed, 2_000).unwrap();
        let current_hash: String = changed_store
            .connection()
            .query_row(
                "SELECT value FROM meta WHERE key = 'keymap_hash'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let history: String = changed_store
            .connection()
            .query_row(
                "SELECT value FROM meta WHERE key = 'keymap_hash_history'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let history: Value = serde_json::from_str(&history).unwrap();
        let entries = history.as_array().unwrap_or_else(|| unreachable!());
        assert_eq!(current_hash, "changed");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["hash"], "fixture");
        assert_eq!(entries[0]["from_ts"], 1_000);
        assert_eq!(entries[1]["hash"], "changed");
        assert_eq!(entries[1]["from_ts"], 2_000);
        drop(changed_store);
        drop(temp);
    }

    #[test]
    fn live_snapshot_has_only_finger_marginals_and_rate() {
        let (_temp, _path, mut store, _device_id) = open_store();
        let mut counts = [0_u32; 10];
        counts[2] = 12;
        store
            .replace_live_snapshot(1_000, &counts, 30, 10_000)
            .unwrap();
        let encoded: String = store
            .connection()
            .query_row("SELECT json FROM live_snapshot WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        let snapshot: Value = serde_json::from_str(&encoded).unwrap();
        let object = snapshot.as_object().unwrap_or_else(|| unreachable!());
        assert_eq!(object.len(), 2);
        assert_eq!(snapshot["finger_count"][2], 12);
        assert_eq!(snapshot["keystrokes_per_minute"], 180.0);
        assert!(snapshot.get("pos").is_none());
        assert!(snapshot.get("keycode").is_none());
        assert!(snapshot.get("row").is_none());
    }

    #[test]
    fn creates_private_files_and_backup_exclusion_markers() {
        let (_temp, db_path, _store, _device_id) = open_store();
        let data_dir = db_path.parent().unwrap_or_else(|| unreachable!());
        assert_eq!(fs::metadata(data_dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(&db_path).unwrap().mode() & 0o777, 0o600);
        let tag = fs::read_to_string(data_dir.join("CACHEDIR.TAG")).unwrap();
        assert!(tag.starts_with("Signature: 8a477f597d28d172789f06886806bc55\n"));
        let readme = fs::read_to_string(data_dir.join("README.txt")).unwrap();
        assert!(readme.contains("Exclude"));
    }

    #[test]
    fn refuses_wider_data_directory_mode() {
        let temp = TempDir::new().unwrap();
        let data_dir = temp.path().join("data");
        fs::create_dir(&data_dir).unwrap();
        fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o755)).unwrap();
        let result = Store::open(&data_dir.join("keylab.db"), &keymap(), 1_000);
        assert!(result.is_err());
    }

    #[test]
    fn schema_carries_no_joint_or_tier_a_identity_leak() {
        let (_temp, _path, store, _device_id) = open_store();
        let connection = store.connection();
        let joint_tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master AS tables
                 WHERE tables.type = 'table'
                   AND EXISTS (SELECT 1 FROM pragma_table_info(tables.name) WHERE name = 'finger_id')
                   AND EXISTS (SELECT 1 FROM pragma_table_info(tables.name) WHERE name = 'row_idx')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let tier_a_identity_columns: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master AS tables
                 JOIN pragma_table_info(tables.name) AS columns
                 WHERE tables.name IN ('bucket', 'finger_count', 'row_count', 'hold_hist',
                                       'mod_hold_hist', 'gap_hist', 'event_count')
                   AND columns.name IN ('pos', 'keycode', 'code')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(joint_tables, 0);
        assert_eq!(tier_a_identity_columns, 0);
    }

    #[test]
    fn tier_a_floor_never_writes_sub_floor_bucket() {
        let (_temp, _path, mut store, device_id) = open_store();
        let mut aggregate = Aggregator::new(1_000);
        for index in 0..24 {
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        let first = aggregate.tick(1_010, 10_000, 25);
        assert!(first.is_none());
        assert_eq!(table_count(store.connection(), "bucket"), 0);
        for index in 24..30 {
            aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        let second = aggregate.tick(1_020, 10_000, 25);
        assert!(second.is_some());
        let second = second.unwrap_or_else(|| unreachable!());
        store
            .seal_tier_a(device_id, &second)
            .unwrap_or_else(|error| panic!("{error:#}"));
        let row: (i64, i64) = store
            .connection()
            .query_row("SELECT keystrokes, span_ms FROM bucket", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(row.0, 30);
        assert!(row.1 >= 20_000);
    }

    #[test]
    fn store_boundary_rejects_every_under_floor_seal() {
        let (_temp, _path, mut store, device_id) = open_store();
        let mut tier_a_data = TierAAccumulator {
            keystrokes: 24,
            ..TierAAccumulator::default()
        };
        let tier_a = TierASeal {
            bucket_id: 1_000,
            span_ms: 10_000,
            data: tier_a_data,
        };
        assert!(store.seal_tier_a(device_id, &tier_a).is_err());

        tier_a_data = TierAAccumulator {
            keystrokes: 25,
            ..TierAAccumulator::default()
        };
        let too_short = TierASeal {
            bucket_id: 1_000,
            span_ms: 9_999,
            data: tier_a_data,
        };
        assert!(store.seal_tier_a(device_id, &too_short).is_err());

        let mut counts = [0_u32; 81];
        counts[0] = 1_999;
        let tier_b = TierBSeal {
            start_ts: 1_000,
            end_ts: 2_000,
            keystrokes: 1_999,
            pos_count: counts,
        };
        assert!(store.seal_tier_b(device_id, &tier_b).is_err());

        let inconsistent_tier_b = TierBSeal {
            start_ts: 1_000,
            end_ts: 2_000,
            keystrokes: 2_000,
            pos_count: counts,
        };
        assert!(store.seal_tier_b(device_id, &inconsistent_tier_b).is_err());
        assert_eq!(table_count(store.connection(), "bucket"), 0);
        assert_eq!(table_count(store.connection(), "key_window"), 0);
    }

    #[test]
    fn same_second_multi_device_tier_a_collision_records_less() {
        let (_temp, _path, mut store, first_device_id) = open_store();
        let second_device_id = store.register_device("fixture-2", None, 1_000).unwrap();
        let data = TierAAccumulator {
            keystrokes: 25,
            ..TierAAccumulator::default()
        };
        let seal = TierASeal {
            bucket_id: 1_000,
            span_ms: 10_000,
            data,
        };
        store.seal_tier_a(first_device_id, &seal).unwrap();
        store.seal_tier_a(second_device_id, &seal).unwrap();
        assert_eq!(table_count(store.connection(), "bucket"), 1);
        assert_eq!(
            scalar(store.connection(), "SELECT device_id FROM bucket"),
            first_device_id
        );
    }

    #[test]
    fn tier_b_floor_and_unattributed_position_are_exact() {
        let (_temp, _path, mut store, device_id) = open_store();
        let mut aggregate = Aggregator::new(0);
        for index in 0..1_998 {
            let seal = aggregate.handle_event(index, 30, 1, &keymap(), 2_000);
            assert!(seal.is_none());
        }
        let seal = aggregate.handle_event(1_998, 200, 1, &keymap(), 2_000);
        assert!(seal.is_none());
        assert_eq!(table_count(store.connection(), "key_window"), 0);
        let seal = aggregate.handle_event(1_999, 30, 1, &keymap(), 2_000);
        assert!(seal.is_some());
        let seal = seal.unwrap_or_else(|| unreachable!());
        store
            .seal_tier_b(device_id, &seal)
            .unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(table_count(store.connection(), "key_window"), 1);
        let sum: i64 = store
            .connection()
            .query_row("SELECT SUM(presses) FROM pos_count", [], |row| row.get(0))
            .unwrap();
        let unknown: i64 = store
            .connection()
            .query_row("SELECT presses FROM pos_count WHERE pos = -1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(sum, 2_000);
        assert_eq!(unknown, 1);
    }

    #[test]
    fn shutdown_discard_writes_no_partial_rows() {
        let (_temp, _path, store, _device_id) = open_store();
        let mut tier_b_partial = Aggregator::new(0);
        for index in 0..1_500 {
            tier_b_partial.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        tier_b_partial.discard_partials(10);
        assert_eq!(tier_b_partial.tier_b_total(), 0);

        let mut tier_a_partial = Aggregator::new(0);
        for index in 0..24 {
            tier_a_partial.handle_event(index, 30, 1, &keymap(), 2_000);
        }
        assert!(tier_a_partial.tick(10, 10_000, 25).is_none());
        tier_a_partial.discard_partials(10);
        assert_eq!(tier_a_partial.tier_a.keystrokes, 0);
        assert_eq!(table_count(store.connection(), "key_window"), 0);
        assert_eq!(table_count(store.connection(), "bucket"), 0);
    }

    #[test]
    fn full_replay_produces_exact_rows_in_every_aggregate_table() {
        let (_temp, _path, mut store, device_id) = open_store();
        let mut aggregate = Aggregator::new(1_000);

        aggregate.handle_event(100, 30, 1, &keymap(), 2_000);
        aggregate.handle_event(110, 30, 0, &keymap(), 2_000);
        aggregate.handle_event(120, 29, 1, &keymap(), 2_000);
        aggregate.handle_event(130, 29, 0, &keymap(), 2_000);
        aggregate.handle_event(629, 14, 1, &keymap(), 2_000);
        aggregate.handle_event(630, 14, 0, &keymap(), 2_000);
        aggregate.handle_event(631, 30, 1, &keymap(), 2_000);

        let mut tier_b = None;
        for offset in 0..1_997 {
            let seal = aggregate.handle_event(632 + offset, 30, 1, &keymap(), 2_000);
            if seal.is_some() {
                tier_b = seal;
            }
        }
        assert!(tier_b.is_some());
        let tier_b = tier_b.unwrap_or_else(|| unreachable!());
        store.seal_tier_b(device_id, &tier_b).unwrap();
        let tier_a = aggregate
            .tick(1_010, 10_000, 25)
            .unwrap_or_else(|| unreachable!());
        store.seal_tier_a(device_id, &tier_a).unwrap();

        assert_eq!(table_count(store.connection(), "bucket"), 1);
        assert_eq!(
            scalar(store.connection(), "SELECT keystrokes FROM bucket"),
            2_000
        );
        assert_eq!(
            scalar(store.connection(), "SELECT span_ms FROM bucket"),
            10_000
        );
        assert_eq!(
            scalar(store.connection(), "SELECT active_ms FROM bucket"),
            2_528
        );
        assert_eq!(
            scalar(store.connection(), "SELECT autorepeats FROM bucket"),
            0
        );
        assert_eq!(table_count(store.connection(), "finger_count"), 2);
        assert_eq!(
            scalar(store.connection(), "SELECT SUM(presses) FROM finger_count"),
            2_000
        );
        assert_eq!(table_count(store.connection(), "row_count"), 2);
        assert_eq!(
            scalar(store.connection(), "SELECT SUM(presses) FROM row_count"),
            2_000
        );
        assert_eq!(table_count(store.connection(), "hold_hist"), 2);
        assert_eq!(
            scalar(store.connection(), "SELECT SUM(n) FROM hold_hist"),
            2
        );
        assert_eq!(table_count(store.connection(), "mod_hold_hist"), 1);
        assert_eq!(
            scalar(store.connection(), "SELECT SUM(n) FROM mod_hold_hist"),
            1
        );
        assert_eq!(table_count(store.connection(), "gap_hist"), 2);
        assert_eq!(
            scalar(store.connection(), "SELECT SUM(n) FROM gap_hist"),
            1_999
        );
        assert_eq!(table_count(store.connection(), "event_count"), 4);
        for (kind, expected) in [
            (LONELY_MOD, 1),
            (MOD_DURING_ALPHA, 1),
            (BSP_BURST_AFTER_MOD, 1),
            (BSP_BURST, 1),
        ] {
            let count: i64 = store
                .connection()
                .query_row("SELECT n FROM event_count WHERE kind = ?1", [kind], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, expected);
        }
        assert_eq!(table_count(store.connection(), "key_window"), 1);
        assert_eq!(
            scalar(store.connection(), "SELECT keystrokes FROM key_window"),
            2_000
        );
        assert_eq!(table_count(store.connection(), "pos_count"), 2);
        assert_eq!(
            scalar(store.connection(), "SELECT SUM(presses) FROM pos_count"),
            2_000
        );
        let left_finger: i64 = store
            .connection()
            .query_row(
                "SELECT presses FROM finger_count WHERE finger_id = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let right_finger: i64 = store
            .connection()
            .query_row(
                "SELECT presses FROM finger_count WHERE finger_id = 8",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let pos_a: i64 = store
            .connection()
            .query_row("SELECT presses FROM pos_count WHERE pos = 0", [], |row| {
                row.get(0)
            })
            .unwrap();
        let pos_bsp: i64 = store
            .connection()
            .query_row("SELECT presses FROM pos_count WHERE pos = 2", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!((left_finger, right_finger), (1_999, 1));
        assert_eq!((pos_a, pos_bsp), (1_999, 1));
    }

    fn table_count(connection: &Connection, table: &str) -> i64 {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        connection
            .query_row(&sql, [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"))
    }

    fn scalar(connection: &Connection, sql: &str) -> i64 {
        connection
            .query_row(sql, [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"))
    }
}
