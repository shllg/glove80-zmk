use crate::aggregate::{TierASeal, TierBSeal, TierCSeal};
use crate::config::{
    MIN_BUCKET_SECONDS, MIN_NGRAM_SEAL_COUNT, MIN_TIER_A_SEAL_FLOOR, MIN_TIER_B_SEAL_COUNT,
};
use crate::encode::{unpack_finger, unpack_ngram, FINGER_ABSENT, POS_ABSENT, POS_UNATTRIBUTED};
use crate::keymap::Keymap;
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use tracing::{info, warn};

/// The schema lives in its own file because `registry.rs` builds a database from it too, and
/// `keylabctl` cannot include this module (see the note at the top of `registry.rs`). One copy in
/// one place is the only way two files that both know the schema cannot drift apart.
const SCHEMA: &str = include_str!("schema.sql");

const CACHEDIR_TAG: &str = concat!(
    "Signature: 8a477f597d28d172789f06886806bc55\n",
    "# This directory contains privacy-sensitive local keystroke aggregates.\n"
);
const DATA_README: &str = concat!(
    "This directory contains keylab's privacy-sensitive local keystroke aggregate database.\n",
    "Exclude the entire directory from backups, sync tools, and cloud storage.\n"
);

/// Identifies the position space a device's Tier B counts belong to.
#[derive(Clone, Copy)]
pub struct DeviceKeymap<'a> {
    pub kind: &'a str,
    pub hash: &'a str,
}

/// The control state echoed into the live snapshot. The viewer reads it from there rather than
/// from its own last write, so the daemon stays the single authority on what is actually in force.
#[derive(Clone, Copy)]
pub struct LiveControl<'a> {
    pub paused: bool,
    pub profile: &'a str,
    pub profiles: &'a [String],
    /// The layer the firmware last reported, on a board that signals layers. `None` says the
    /// question cannot be answered, which is different from saying the keyboard is on Base.
    pub layer: Option<&'a str>,
}

/// A Tier A seal whose `(ts, device_id, profile_id)` identity is already on disk.
///
/// It should be impossible: the aggregator seals one bucket per device per tick. But the seal second
/// comes from the wall clock, and an NTP step backwards can land on a second that is already sealed.
/// Callers have to tell it apart from a write that genuinely failed, so it costs one bucket rather
/// than every other device's unsealed accumulator.
#[derive(Debug, Clone, Copy)]
pub struct DuplicateBucketIdentity {
    pub ts: i64,
    pub device_id: i64,
    pub profile_id: i64,
}

impl std::fmt::Display for DuplicateBucketIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "a Tier A bucket for device {} and profile {} at second {} is already sealed",
            self.device_id, self.profile_id, self.ts
        )
    }
}

impl std::error::Error for DuplicateBucketIdentity {}

pub struct Store {
    connection: Connection,
    refused_tier_a_seals: u64,
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
        Ok(Self {
            connection,
            refused_tier_a_seals: 0,
        })
    }

    /// Tier A seals refused since this process started, for the operator log lines. A non-zero count
    /// is a bug worth reporting, not a tuning knob.
    pub fn refused_tier_a_seals(&self) -> u64 {
        self.refused_tier_a_seals
    }

    /// `keymap_kind` is the device's *position space*. Tier B may only be pooled inside one space,
    /// so the space has to be recorded next to the device rather than inferred later.
    pub fn register_device(
        &mut self,
        name: &str,
        uniq: Option<&str>,
        first_ts: i64,
        keymap: &DeviceKeymap<'_>,
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
            // A keymap rebuild changes the hash for a device that already exists; the row must
            // follow the configuration rather than keep pointing at a superseded keymap.
            self.connection
                .execute(
                    "UPDATE device SET keymap_kind = ?2, keymap_hash = ?3 WHERE id = ?1",
                    params![device_id, keymap.kind, keymap.hash],
                )
                .context("failed to update a device keymap identity")?;
            return Ok(device_id);
        }
        self.connection
            .execute(
                "INSERT INTO device(name, uniq, first_ts, keymap_kind, keymap_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![name, uniq, first_ts, keymap.kind, keymap.hash],
            )
            .context("failed to register input device")?;
        Ok(self.connection.last_insert_rowid())
    }

    /// Profiles mirror the device pattern: look up first, insert only when genuinely new, so a
    /// profile switch back and forth never fragments one activity across several rows.
    pub fn register_profile(&mut self, name: &str) -> Result<i64> {
        let existing: Option<i64> = self
            .connection
            .query_row(
                "SELECT id FROM profile WHERE name = ?1",
                params![name],
                |row| row.get(0),
            )
            .optional()
            .context("failed to look up a profile")?;
        if let Some(profile_id) = existing {
            return Ok(profile_id);
        }
        self.connection
            .execute("INSERT INTO profile(name) VALUES (?1)", params![name])
            .context("failed to register a profile")?;
        Ok(self.connection.last_insert_rowid())
    }

    pub fn seal_tier_a(&mut self, device_id: i64, profile_id: i64, seal: &TierASeal) -> Result<()> {
        if seal.data.keystrokes < MIN_TIER_A_SEAL_FLOOR {
            bail!("refusing to persist a Tier A bucket below the privacy count floor");
        }
        if seal.span_ms < MIN_BUCKET_SECONDS * 1_000 {
            bail!("refusing to persist a Tier A bucket below the privacy time floor");
        }
        // `TierASeal::bucket_id` is the seal second, which v5 stores in `ts`. The row's own id is
        // whatever SQLite allocates, and it is what every child row points at.
        let ts = seal.bucket_id;
        let span_ms = to_i64(seal.span_ms, "Tier A span")?;
        let active_ms = to_i64(seal.data.active_ms, "active time")?;
        let transaction = self
            .connection
            .transaction()
            .context("failed to begin Tier A transaction")?;
        let inserted = transaction.execute(
            "INSERT INTO bucket(ts, device_id, profile_id, span_ms, active_ms, keystrokes, autorepeats)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                ts,
                device_id,
                profile_id,
                span_ms,
                active_ms,
                seal.data.keystrokes,
                seal.data.autorepeats
            ],
        );
        match inserted {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(failure, _))
                if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                // Refused, never swallowed. Returning `Ok` here is precisely how the v4 collision
                // stayed invisible until a second keyboard was configured.
                drop(transaction);
                self.refused_tier_a_seals = self.refused_tier_a_seals.saturating_add(1);
                warn!(
                    bucket_ts = ts,
                    device_id,
                    profile_id,
                    keystrokes = seal.data.keystrokes,
                    refused_tier_a_seals = self.refused_tier_a_seals,
                    "refused a Tier A bucket whose identity is already sealed"
                );
                return Err(anyhow::Error::new(DuplicateBucketIdentity {
                    ts,
                    device_id,
                    profile_id,
                }));
            }
            Err(error) => return Err(error).context("failed to write Tier A bucket"),
        }
        let bucket_id = transaction.last_insert_rowid();

        write_finger_counts(&transaction, bucket_id, seal)?;
        write_row_counts(&transaction, bucket_id, seal)?;
        write_hold_histograms(&transaction, bucket_id, seal)?;
        write_modifier_histograms(&transaction, bucket_id, seal)?;
        write_gap_histograms(&transaction, bucket_id, seal)?;
        write_event_counts(&transaction, bucket_id, seal)?;
        transaction
            .commit()
            .context("failed to commit Tier A transaction")
    }

    pub fn seal_tier_b(&mut self, device_id: i64, profile_id: i64, seal: &TierBSeal) -> Result<()> {
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
                "INSERT INTO key_window(device_id, profile_id, start_ts, end_ts, keystrokes)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![device_id, profile_id, start_ts, end_ts, seal.keystrokes],
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

    /// Writes one sealed Tier C correction-context window. `degraded` is every count that lost its
    /// position identity — by low-count suppression at seal or by cap overflow during capture —
    /// and `dropped` is every count that lost even its finger identity.
    pub fn seal_tier_c(&mut self, device_id: i64, profile_id: i64, seal: &TierCSeal) -> Result<()> {
        if seal.corrections < MIN_NGRAM_SEAL_COUNT {
            bail!("refusing to persist a Tier C window below the privacy count floor");
        }
        let degraded = seal.degraded();
        let accounted = sum_row_counts(&seal.rows)
            .saturating_add(degraded)
            .saturating_add(seal.dropped);
        if accounted != seal.corrections {
            bail!("refusing to persist an inconsistent Tier C correction window");
        }
        let start_ts = to_i64(seal.start_ts, "Tier C start timestamp")?;
        let end_ts = to_i64(seal.end_ts, "Tier C end timestamp")?;
        let transaction = self
            .connection
            .transaction()
            .context("failed to begin Tier C transaction")?;
        transaction
            .execute(
                "INSERT INTO ngram_window(device_id, profile_id, start_ts, end_ts, corrections, degraded, dropped)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    device_id,
                    profile_id,
                    start_ts,
                    end_ts,
                    seal.corrections,
                    degraded,
                    seal.dropped
                ],
            )
            .context("failed to write Tier C window")?;
        let window_id = transaction.last_insert_rowid();
        for (key, count) in &seal.rows {
            let (positions, mod_mask, latency, run) = unpack_ngram(*key);
            transaction
                .execute(
                    "INSERT INTO ngram(window_id, pos_a, pos_b, pos_c, mod_mask, latency_bucket, run_bucket, n)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        window_id,
                        on_disk_position(positions[0]),
                        on_disk_position(positions[1]),
                        on_disk_position(positions[2]),
                        mod_mask,
                        latency,
                        run,
                        count
                    ],
                )
                .context("failed to write a Tier C n-gram")?;
        }
        for (key, count) in &seal.finger_rows {
            let (fingers, mod_mask, latency, run) = unpack_finger(*key);
            transaction
                .execute(
                    "INSERT INTO ngram_finger(window_id, finger_a, finger_b, finger_c, mod_mask, latency_bucket, run_bucket, n)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        window_id,
                        on_disk_finger(fingers[0]),
                        on_disk_finger(fingers[1]),
                        on_disk_finger(fingers[2]),
                        mod_mask,
                        latency,
                        run,
                        count
                    ],
                )
                .context("failed to write a Tier C finger n-gram")?;
        }
        transaction
            .commit()
            .context("failed to commit Tier C transaction")
    }

    pub fn replace_live_snapshot(
        &mut self,
        updated_at: i64,
        finger_counts: &[u32; 10],
        keystrokes: u32,
        elapsed_ms: u64,
        control: &LiveControl<'_>,
    ) -> Result<()> {
        let LiveControl {
            paused,
            profile,
            profiles,
            layer,
        } = *control;
        let rate = if elapsed_ms == 0 {
            0.0
        } else {
            f64::from(keystrokes) * 60_000.0 / elapsed_ms as f64
        };
        // Profile names are user-authored labels, not keystroke data, so echoing them here is
        // within the logging policy. This is the viewer's only authoritative source of control
        // state: it must never infer it from its own last write.
        let snapshot = serde_json::to_string(&json!({
            "finger_count": finger_counts,
            "keystrokes_per_minute": rate,
            "paused": paused,
            "profile": profile,
            "profiles": profiles,
            "layer": layer,
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
    connection
        .execute(
            "INSERT OR IGNORE INTO profile(id, name) VALUES (1, ?1)",
            [crate::config::DEFAULT_PROFILE],
        )
        .context("failed to seed the default profile")?;

    let schema_version: Option<String> = connection
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .context("failed to read schema version")?;
    match schema_version.as_deref() {
        None | Some("5") => {}
        Some("1") => {
            migrate_v1_to_v2(connection)?;
            migrate_v2_to_v3(connection, keymap)?;
            migrate_v3_to_v4(connection)?;
            migrate_v4_to_v5(connection)?;
        }
        Some("2") => {
            migrate_v2_to_v3(connection, keymap)?;
            migrate_v3_to_v4(connection)?;
            migrate_v4_to_v5(connection)?;
        }
        Some("3") => {
            migrate_v3_to_v4(connection)?;
            migrate_v4_to_v5(connection)?;
        }
        Some("4") => migrate_v4_to_v5(connection)?,
        Some(_) => bail!("unsupported database schema version"),
    }
    connection
        .execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '5')",
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

/// v1 databases predate activity profiles. Every row they hold was captured on the Glove80 during
/// ordinary use, so backfilling them to the default profile is accurate, not a guess.
fn migrate_v1_to_v2(connection: &Connection) -> Result<()> {
    for statement in [
        "ALTER TABLE bucket ADD COLUMN profile_id INTEGER REFERENCES profile(id)",
        "ALTER TABLE key_window ADD COLUMN profile_id INTEGER REFERENCES profile(id)",
    ] {
        match connection.execute(statement, []) {
            Ok(_) => {}
            // Re-running the migration after a partial failure must not abort the daemon.
            Err(rusqlite::Error::SqliteFailure(_, Some(ref message)))
                if message.contains("duplicate column name") => {}
            Err(error) => {
                return Err(error).context("failed to add the profile column");
            }
        }
    }
    connection
        .execute_batch(
            "UPDATE bucket SET profile_id = 1 WHERE profile_id IS NULL;
             UPDATE key_window SET profile_id = 1 WHERE profile_id IS NULL;
             UPDATE meta SET value = '2' WHERE key = 'schema_version';",
        )
        .context("failed to backfill the default profile")?;
    info!("migrated database schema from version 1 to 2");
    Ok(())
}

/// v2 databases predate multi-device support, so every device they hold is the Glove80 read through
/// evsieve. Backfilling them to the default keymap kind is accurate, not a guess.
fn migrate_v2_to_v3(connection: &Connection, keymap: &Keymap) -> Result<()> {
    for statement in [
        "ALTER TABLE device ADD COLUMN keymap_kind TEXT",
        "ALTER TABLE device ADD COLUMN keymap_hash TEXT",
    ] {
        match connection.execute(statement, []) {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(_, Some(ref message)))
                if message.contains("duplicate column name") => {}
            Err(error) => {
                return Err(error).context("failed to add a device keymap column");
            }
        }
    }
    connection
        .execute(
            "UPDATE device SET keymap_kind = ?1 WHERE keymap_kind IS NULL",
            [crate::config::DEFAULT_KEYMAP_KIND],
        )
        .context("failed to backfill the default keymap kind")?;
    connection
        .execute(
            "UPDATE device SET keymap_hash = ?1 WHERE keymap_hash IS NULL",
            [&keymap.hash],
        )
        .context("failed to backfill the device keymap hash")?;
    connection
        .execute_batch("UPDATE meta SET value = '3' WHERE key = 'schema_version';")
        .context("failed to record the version 3 schema")?;
    info!("migrated database schema from version 2 to 3");
    Ok(())
}

/// v3 databases predate Tier C. There is nothing to backfill — correction context that was never
/// captured cannot be reconstructed — so this only adds the three tables. `SCHEMA` has already run
/// with `CREATE TABLE IF NOT EXISTS`, which is what makes the migration re-runnable after a
/// partial failure.
fn migrate_v3_to_v4(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(SCHEMA)
        .context("failed to create the version 4 correction-context tables")?;
    connection
        .execute_batch("UPDATE meta SET value = '4' WHERE key = 'schema_version';")
        .context("failed to record the version 4 schema")?;
    info!("migrated database schema from version 3 to 4");
    Ok(())
}

/// v4 keys a bucket by its seal second alone, so two devices sealing in the same second produced one
/// identity and one of them was discarded. v5 demotes the second to a `ts` column and makes identity
/// `(ts, device_id, profile_id)`.
///
/// Existing ids are copied verbatim into the surrogate key. Six child tables reference `bucket(id)`
/// and none of them is rewritten, so a renumbering here would orphan every finger count, hold
/// histogram and behavioural counter in the database. `ts = id` is accurate rather than a guess:
/// under v4 the id *was* the seal second.
fn migrate_v4_to_v5(connection: &Connection) -> Result<()> {
    if bucket_has_ts_column(connection)? {
        // The swap committed and only the stamp is missing, which is the one way an interrupted
        // attempt can land: everything before the stamp is inside a single transaction.
        connection
            .execute_batch("UPDATE meta SET value = '5' WHERE key = 'schema_version';")
            .context("failed to record the version 5 schema")?;
        return Ok(());
    }
    // Create, copy, drop, rename — SQLite's own table-rebuild procedure, including turning foreign
    // keys off for the duration. This build enables them by default
    // (`libsqlite3-sys` compiles with `SQLITE_DEFAULT_FOREIGN_KEYS=1`), and dropping the old table
    // performs an implicit `DELETE FROM` that every child row would refuse. The references the drop
    // breaks are exactly the ones the rename restores, because the ids are copied verbatim.
    //
    // The pragma is a no-op inside a transaction, so it has to bracket one rather than sit in it.
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .context("failed to suspend foreign keys for the version 5 rebuild")?;
    let rebuilt = connection
        .execute_batch(
            "BEGIN IMMEDIATE;
             DROP TABLE IF EXISTS bucket_v5;
             CREATE TABLE bucket_v5 (
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
             INSERT INTO bucket_v5(id, ts, device_id, profile_id, span_ms, active_ms, keystrokes,
                                   autorepeats)
               SELECT id, id, device_id, profile_id, span_ms, active_ms, keystrokes, autorepeats
               FROM bucket;
             DROP TABLE bucket;
             ALTER TABLE bucket_v5 RENAME TO bucket;
             UPDATE meta SET value = '5' WHERE key = 'schema_version';
             COMMIT;",
        )
        .context("failed to rebuild the bucket table for the version 5 schema");
    // Enforcement comes back whether or not the rebuild landed: a failed migration must not leave
    // the process writing without foreign keys for the rest of its life.
    let restored = connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .context("failed to restore foreign keys after the version 5 rebuild");
    rebuilt?;
    restored?;
    info!("migrated database schema from version 4 to 5");
    Ok(())
}

fn bucket_has_ts_column(connection: &Connection) -> Result<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('bucket') WHERE name = 'ts')",
            [],
            |row| row.get(0),
        )
        .context("failed to inspect the bucket table")
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

fn write_finger_counts(
    transaction: &Transaction<'_>,
    bucket_id: i64,
    seal: &TierASeal,
) -> Result<()> {
    for (finger_id, presses) in seal.data.finger_count.iter().copied().enumerate() {
        if presses > 0 {
            transaction
                .execute(
                    "INSERT INTO finger_count(bucket_id, finger_id, presses) VALUES (?1, ?2, ?3)",
                    params![bucket_id, finger_id, presses],
                )
                .context("failed to write finger marginal")?;
        }
    }
    Ok(())
}

fn write_row_counts(transaction: &Transaction<'_>, bucket_id: i64, seal: &TierASeal) -> Result<()> {
    for (index, presses) in seal.data.row_count.iter().copied().enumerate() {
        if presses > 0 {
            let hand = index / 6;
            let row_idx = index % 6 + 1;
            transaction
                .execute(
                    "INSERT INTO row_count(bucket_id, hand, row_idx, presses) VALUES (?1, ?2, ?3, ?4)",
                    params![bucket_id, hand, row_idx, presses],
                )
                .context("failed to write row marginal")?;
        }
    }
    Ok(())
}

fn write_hold_histograms(
    transaction: &Transaction<'_>,
    bucket_id: i64,
    seal: &TierASeal,
) -> Result<()> {
    for (finger_id, histogram) in seal.data.hold_hist.iter().enumerate() {
        for (bucket, count) in histogram.iter().copied().enumerate() {
            if count > 0 {
                transaction
                    .execute(
                        "INSERT INTO hold_hist(bucket_id, finger_id, dur_bucket, n) VALUES (?1, ?2, ?3, ?4)",
                        params![bucket_id, finger_id, bucket, count],
                    )
                    .context("failed to write hold histogram")?;
            }
        }
    }
    Ok(())
}

fn write_modifier_histograms(
    transaction: &Transaction<'_>,
    bucket_id: i64,
    seal: &TierASeal,
) -> Result<()> {
    for (mod_class, histogram) in seal.data.mod_hold_hist.iter().enumerate() {
        for (bucket, count) in histogram.iter().copied().enumerate() {
            if count > 0 {
                transaction
                    .execute(
                        "INSERT INTO mod_hold_hist(bucket_id, mod_class, dur_bucket, n) VALUES (?1, ?2, ?3, ?4)",
                        params![bucket_id, mod_class, bucket, count],
                    )
                    .context("failed to write modifier hold histogram")?;
            }
        }
    }
    Ok(())
}

fn write_gap_histograms(
    transaction: &Transaction<'_>,
    bucket_id: i64,
    seal: &TierASeal,
) -> Result<()> {
    for (hand, histogram) in seal.data.gap_hist.iter().enumerate() {
        for (bucket, count) in histogram.iter().copied().enumerate() {
            if count > 0 {
                transaction
                    .execute(
                        "INSERT INTO gap_hist(bucket_id, hand, gap_bucket, n) VALUES (?1, ?2, ?3, ?4)",
                        params![bucket_id, hand, bucket, count],
                    )
                    .context("failed to write gap histogram")?;
            }
        }
    }
    Ok(())
}

fn write_event_counts(
    transaction: &Transaction<'_>,
    bucket_id: i64,
    seal: &TierASeal,
) -> Result<()> {
    for (kind, subjects) in seal.data.event_count.iter().enumerate() {
        for (subject, count) in subjects.iter().copied().enumerate() {
            if count > 0 {
                transaction
                    .execute(
                        "INSERT INTO event_count(bucket_id, kind, subject, n) VALUES (?1, ?2, ?3, ?4)",
                        params![bucket_id, kind, subject, count],
                    )
                    .context("failed to write behavioral counter")?;
            }
        }
    }
    Ok(())
}

fn sum_row_counts(rows: &[(u64, u32)]) -> u32 {
    rows.iter()
        .map(|(_, count)| *count)
        .fold(0_u32, u32::saturating_add)
}

/// `-1` for unattributed matches `pos_count`'s existing convention deliberately, so one reader can
/// treat the value the same way in both tables. `-2` extends it: unlike Tier B, a Tier C slot can
/// hold no key at all when fewer than three keys preceded the correction.
fn on_disk_position(pos: u8) -> i64 {
    match pos {
        POS_UNATTRIBUTED => -1,
        POS_ABSENT => -2,
        other => i64::from(other),
    }
}

/// The finger projection has one absent value: a key with no base-layer position has no finger.
fn on_disk_finger(finger: u8) -> i64 {
    match finger {
        FINGER_ABSENT => -1,
        other => i64::from(other),
    }
}

fn to_i64(value: u64, description: &str) -> Result<i64> {
    i64::try_from(value).with_context(|| format!("{description} exceeds SQLite integer range"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aggregate::{Aggregator, SealPolicy, TierAAccumulator};
    use crate::encode::{
        pack_finger, pack_ngram, BSP_BURST, BSP_BURST_AFTER_MOD, LONELY_MOD, MOD_DURING_ALPHA,
    };
    use crate::keymap::KeyInfo;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn policy() -> SealPolicy {
        SealPolicy::fixture()
    }

    fn fixture_keymap() -> DeviceKeymap<'static> {
        DeviceKeymap {
            kind: crate::config::DEFAULT_KEYMAP_KIND,
            hash: "fixture",
        }
    }

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
            .register_device("fixture", None, 1_000, &fixture_keymap())
            .unwrap_or_else(|error| panic!("{error:#}"));
        (temp, db_path, store, device_id)
    }

    #[test]
    fn reconnecting_reuses_the_existing_device_row() {
        let (_temp, _path, mut store, device_id) = open_store();
        let reconnected = store
            .register_device("fixture", None, 2_000, &fixture_keymap())
            .unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(reconnected, device_id);
        let other = store
            .register_device("other", None, 2_000, &fixture_keymap())
            .unwrap_or_else(|error| panic!("{error:#}"));
        assert_ne!(other, device_id);
        let rows: i64 = store
            .connection()
            .query_row("SELECT COUNT(*) FROM device", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(rows, 2);
    }

    fn sample_tier_a_seal() -> TierASeal {
        let data = TierAAccumulator {
            keystrokes: 30,
            active_ms: 1_000,
            ..TierAAccumulator::default()
        };
        TierASeal {
            bucket_id: 1_000,
            span_ms: 10_000,
            data,
        }
    }

    /// A seal with a row in every child table, so a migration that orphaned any of them shows up as
    /// a failed join rather than as a total that happens to still add up.
    fn populated_tier_a_seal(bucket_id: i64) -> TierASeal {
        let mut data = TierAAccumulator {
            keystrokes: 30,
            active_ms: 1_000,
            autorepeats: 2,
            ..TierAAccumulator::default()
        };
        data.finger_count[0] = 20;
        data.finger_count[5] = 10;
        data.row_count[1] = 30;
        data.hold_hist[0][2] = 30;
        data.mod_hold_hist[0][3] = 4;
        data.gap_hist[0][1] = 29;
        data.event_count[0][0] = 2;
        TierASeal {
            bucket_id,
            span_ms: 10_000,
            data,
        }
    }

    /// Rebuilds `bucket` in its v4 shape — the seal second as the primary key and no `ts` column —
    /// so a migration test starts from what a real pre-v5 database actually holds.
    fn downgrade_bucket_to_v4(connection: &Connection) {
        connection
            .execute_batch(
                "PRAGMA foreign_keys = OFF;
                 CREATE TABLE bucket_v4 (
                   id          INTEGER PRIMARY KEY,
                   device_id   INTEGER NOT NULL REFERENCES device(id),
                   profile_id  INTEGER REFERENCES profile(id),
                   span_ms     INTEGER NOT NULL,
                   active_ms   INTEGER NOT NULL,
                   keystrokes  INTEGER NOT NULL,
                   autorepeats INTEGER NOT NULL
                 );
                 INSERT INTO bucket_v4
                   SELECT id, device_id, profile_id, span_ms, active_ms, keystrokes, autorepeats
                   FROM bucket;
                 DROP TABLE bucket;
                 ALTER TABLE bucket_v4 RENAME TO bucket;
                 PRAGMA foreign_keys = ON;",
            )
            .unwrap_or_else(|error| panic!("{error}"));
    }

    fn bucket_totals(connection: &Connection) -> (i64, i64, i64, i64) {
        connection
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(keystrokes), 0), COALESCE(SUM(autorepeats), 0),
                        COALESCE(SUM(active_ms), 0)
                 FROM bucket",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn v4_migrates_in_place_with_identical_totals() {
        let (_temp, path, mut store, device_id) = open_store();
        let profile_id = store
            .register_profile("gaming")
            .unwrap_or_else(|error| panic!("{error:#}"));
        store
            .seal_tier_a(device_id, profile_id, &populated_tier_a_seal(1_000))
            .unwrap_or_else(|error| panic!("{error:#}"));
        store
            .seal_tier_a(device_id, 1, &populated_tier_a_seal(2_000))
            .unwrap_or_else(|error| panic!("{error:#}"));
        let before = bucket_totals(store.connection());
        // v4 ids are the seal seconds, which is exactly what the migration has to preserve.
        downgrade_bucket_to_v4(store.connection());
        store
            .connection()
            .execute_batch("UPDATE meta SET value = '4' WHERE key = 'schema_version';")
            .unwrap_or_else(|error| panic!("{error}"));
        let ids: Vec<i64> = collect_ids(store.connection());
        store.close().unwrap_or_else(|error| panic!("{error:#}"));

        let reopened =
            Store::open(&path, &keymap(), 3_000).unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(schema_version(reopened.connection()), "5");
        assert_eq!(bucket_totals(reopened.connection()), before);
        assert_eq!(collect_ids(reopened.connection()), ids);
        let drifted: i64 = reopened
            .connection()
            .query_row("SELECT COUNT(*) FROM bucket WHERE ts <> id", [], |row| {
                row.get(0)
            })
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            drifted, 0,
            "v4 ids were the seal second, so ts must equal id"
        );
    }

    #[test]
    fn child_rows_still_join_after_the_migration() {
        let (_temp, path, mut store, device_id) = open_store();
        store
            .seal_tier_a(device_id, 1, &populated_tier_a_seal(1_000))
            .unwrap_or_else(|error| panic!("{error:#}"));
        downgrade_bucket_to_v4(store.connection());
        store
            .connection()
            .execute_batch("UPDATE meta SET value = '4' WHERE key = 'schema_version';")
            .unwrap_or_else(|error| panic!("{error}"));
        store.close().unwrap_or_else(|error| panic!("{error:#}"));

        let reopened =
            Store::open(&path, &keymap(), 3_000).unwrap_or_else(|error| panic!("{error:#}"));
        for (table, column, expected) in [
            ("finger_count", "presses", 30),
            ("row_count", "presses", 30),
            ("hold_hist", "n", 30),
            ("mod_hold_hist", "n", 4),
            ("gap_hist", "n", 29),
            ("event_count", "n", 2),
        ] {
            let joined = scalar(
                reopened.connection(),
                &format!(
                    "SELECT COALESCE(SUM(c.{column}), 0) FROM {table} c
                     JOIN bucket b ON b.id = c.bucket_id"
                ),
            );
            assert_eq!(joined, expected, "{table} lost its parent");
            let orphaned = scalar(
                reopened.connection(),
                &format!(
                    "SELECT COUNT(*) FROM {table} c
                     WHERE NOT EXISTS (SELECT 1 FROM bucket b WHERE b.id = c.bucket_id)"
                ),
            );
            assert_eq!(orphaned, 0, "{table} holds orphaned rows");
        }
        // The swap runs with foreign keys suspended, so SQLite's own check is what proves the
        // references it broke are the ones the rename restored — and that they came back on.
        let violations: i64 = reopened
            .connection()
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(violations, 0);
        let enforced: i64 = reopened
            .connection()
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(enforced, 1);
    }

    #[test]
    fn an_interrupted_migration_leaves_a_readable_database() {
        let (_temp, path, mut store, device_id) = open_store();
        store
            .seal_tier_a(device_id, 1, &populated_tier_a_seal(1_000))
            .unwrap_or_else(|error| panic!("{error:#}"));
        let before = bucket_totals(store.connection());

        // An attempt that died before the swap can leave the scratch table behind.
        downgrade_bucket_to_v4(store.connection());
        store
            .connection()
            .execute_batch(
                "CREATE TABLE bucket_v5 (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL);
                 INSERT INTO bucket_v5(id, ts) VALUES (999, 999);
                 UPDATE meta SET value = '4' WHERE key = 'schema_version';",
            )
            .unwrap_or_else(|error| panic!("{error}"));
        store.close().unwrap_or_else(|error| panic!("{error:#}"));

        let reopened =
            Store::open(&path, &keymap(), 3_000).unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(schema_version(reopened.connection()), "5");
        assert_eq!(bucket_totals(reopened.connection()), before);
        reopened.close().unwrap_or_else(|error| panic!("{error:#}"));

        // An attempt that died after the swap but before the stamp leaves a v5 table stamped v4.
        let stamped_back =
            Store::open(&path, &keymap(), 4_000).unwrap_or_else(|error| panic!("{error:#}"));
        stamped_back
            .connection()
            .execute_batch("UPDATE meta SET value = '4' WHERE key = 'schema_version';")
            .unwrap_or_else(|error| panic!("{error}"));
        stamped_back
            .close()
            .unwrap_or_else(|error| panic!("{error:#}"));

        let again =
            Store::open(&path, &keymap(), 5_000).unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(schema_version(again.connection()), "5");
        assert_eq!(bucket_totals(again.connection()), before);
    }

    fn collect_ids(connection: &Connection) -> Vec<i64> {
        connection
            .prepare("SELECT id FROM bucket ORDER BY id")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get(0))?
                    .collect::<Result<Vec<i64>, _>>()
            })
            .unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn registering_a_profile_twice_reuses_the_row() {
        let (_temp, _path, mut store, _device_id) = open_store();
        let first = store
            .register_profile("gaming")
            .unwrap_or_else(|error| panic!("{error:#}"));
        let second = store
            .register_profile("gaming")
            .unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(first, second);
        let other = store
            .register_profile("training-de")
            .unwrap_or_else(|error| panic!("{error:#}"));
        assert_ne!(other, first);
    }

    #[test]
    fn the_default_profile_exists_with_id_one_after_open() {
        let (_temp, _path, store, _device_id) = open_store();
        let name: String = store
            .connection()
            .query_row("SELECT name FROM profile WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(name, crate::config::DEFAULT_PROFILE);
    }

    #[test]
    fn migrates_v1_all_the_way_to_v5() {
        let (_temp, path, mut store, device_id) = open_store();
        let profile_id = store
            .register_profile("gaming")
            .unwrap_or_else(|error| panic!("{error:#}"));
        store
            .seal_tier_a(device_id, profile_id, &sample_tier_a_seal())
            .unwrap_or_else(|error| panic!("{error:#}"));
        // Simulate a database written before any of the migrations existed.
        downgrade_bucket_to_v4(store.connection());
        store
            .connection()
            .execute_batch(
                "UPDATE bucket SET profile_id = NULL;
                 UPDATE device SET keymap_kind = NULL, keymap_hash = NULL;
                 DROP TABLE ngram;
                 DROP TABLE ngram_finger;
                 DROP TABLE ngram_window;
                 UPDATE meta SET value = '1' WHERE key = 'schema_version';",
            )
            .unwrap_or_else(|error| panic!("{error}"));
        store.close().unwrap_or_else(|error| panic!("{error:#}"));

        let reopened =
            Store::open(&path, &keymap(), 3_000).unwrap_or_else(|error| panic!("{error:#}"));
        let orphaned: i64 = reopened
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM bucket WHERE profile_id IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(orphaned, 0);
        assert_eq!(schema_version(reopened.connection()), "5");
        assert_eq!(correction_context_tables(reopened.connection()), 3);
        assert!(
            bucket_has_ts_column(reopened.connection()).unwrap_or_else(|error| panic!("{error:#}"))
        );
    }

    /// A v3 database predates Tier C entirely: the migration is pure table creation, and running it
    /// twice must be as safe as running it once.
    #[test]
    fn migrates_v3_to_v5() {
        let (_temp, path, store, _device_id) = open_store();
        downgrade_bucket_to_v4(store.connection());
        store
            .connection()
            .execute_batch(
                "DROP TABLE ngram;
                 DROP TABLE ngram_finger;
                 DROP TABLE ngram_window;
                 UPDATE meta SET value = '3' WHERE key = 'schema_version';",
            )
            .unwrap_or_else(|error| panic!("{error}"));
        store.close().unwrap_or_else(|error| panic!("{error:#}"));

        let reopened =
            Store::open(&path, &keymap(), 3_000).unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(schema_version(reopened.connection()), "5");
        assert_eq!(correction_context_tables(reopened.connection()), 3);
        reopened.close().unwrap_or_else(|error| panic!("{error:#}"));

        let again =
            Store::open(&path, &keymap(), 4_000).unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(schema_version(again.connection()), "5");
        assert_eq!(correction_context_tables(again.connection()), 3);
    }

    fn schema_version(connection: &Connection) -> String {
        connection
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|error| panic!("{error}"))
    }

    fn correction_context_tables(connection: &Connection) -> i64 {
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name IN ('ngram_window', 'ngram', 'ngram_finger')",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn a_registered_device_records_its_position_space() {
        let (_temp, _path, mut store, device_id) = open_store();
        let (kind, hash): (String, String) = store
            .connection()
            .query_row(
                "SELECT keymap_kind, keymap_hash FROM device WHERE id = ?1",
                [device_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(kind, crate::config::DEFAULT_KEYMAP_KIND);
        assert_eq!(hash, "fixture");

        let laptop = store
            .register_device(
                "AT Translated Set 2 keyboard",
                None,
                1_000,
                &DeviceKeymap {
                    kind: "qwerty-ansi",
                    hash: "qwerty",
                },
            )
            .unwrap_or_else(|error| panic!("{error:#}"));
        assert_ne!(laptop, device_id);
        let spaces: i64 = store
            .connection()
            .query_row(
                "SELECT COUNT(DISTINCT keymap_kind) FROM device",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(spaces, 2);
    }

    #[test]
    fn migrating_a_v2_database_backfills_the_default_keymap_kind() {
        let (_temp, path, store, _device_id) = open_store();
        // Simulate a database written before multi-device support existed.
        downgrade_bucket_to_v4(store.connection());
        store
            .connection()
            .execute_batch(
                "UPDATE device SET keymap_kind = NULL, keymap_hash = NULL;
                 DROP TABLE ngram;
                 DROP TABLE ngram_finger;
                 DROP TABLE ngram_window;
                 UPDATE meta SET value = '2' WHERE key = 'schema_version';",
            )
            .unwrap_or_else(|error| panic!("{error}"));
        store.close().unwrap_or_else(|error| panic!("{error:#}"));

        let reopened =
            Store::open(&path, &keymap(), 3_000).unwrap_or_else(|error| panic!("{error:#}"));
        let orphaned: i64 = reopened
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM device WHERE keymap_kind IS NULL OR keymap_hash IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(orphaned, 0);
        let kind: String = reopened
            .connection()
            .query_row("SELECT keymap_kind FROM device LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(kind, crate::config::DEFAULT_KEYMAP_KIND);
        assert_eq!(schema_version(reopened.connection()), "5");
        assert_eq!(correction_context_tables(reopened.connection()), 3);
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
        assert_eq!(schema_version, "5");
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
            .replace_live_snapshot(
                1_000,
                &counts,
                30,
                10_000,
                &LiveControl {
                    paused: false,
                    profile: "default",
                    profiles: &[],
                    layer: None,
                },
            )
            .unwrap();
        let encoded: String = store
            .connection()
            .query_row("SELECT json FROM live_snapshot WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        let snapshot: Value = serde_json::from_str(&encoded).unwrap();
        let object = snapshot.as_object().unwrap_or_else(|| unreachable!());
        assert_eq!(object.len(), 6);
        assert_eq!(snapshot["finger_count"][2], 12);
        // A board that does not signal layers reports null, which is not the same as Base.
        assert!(snapshot["layer"].is_null());
        assert_eq!(snapshot["keystrokes_per_minute"], 180.0);
        assert!(snapshot.get("pos").is_none());
        assert!(snapshot.get("keycode").is_none());
        assert!(snapshot.get("row").is_none());
    }

    #[test]
    fn live_snapshot_reports_the_control_state() {
        let (_temp, _path, mut store, _device_id) = open_store();
        store
            .replace_live_snapshot(
                1_000,
                &[0; 10],
                0,
                0,
                &LiveControl {
                    paused: true,
                    profile: "gaming",
                    profiles: &["default".to_owned(), "gaming".to_owned()],
                    layer: Some("Navigation"),
                },
            )
            .unwrap_or_else(|error| panic!("{error:#}"));
        let json: String = store
            .connection()
            .query_row("SELECT json FROM live_snapshot WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(json.contains("\"paused\":true"));
        assert!(json.contains("\"profile\":\"gaming\""));
        assert!(json.contains("\"profiles\":[\"default\",\"gaming\"]"));
        assert!(json.contains("\"layer\":\"Navigation\""));
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
        let mut aggregate = Aggregator::new(1_000, 1);
        for index in 0..24 {
            aggregate.handle_event(index, 30, 1, &keymap(), &policy());
        }
        let first = aggregate.tick(1_010, 10_000, 25);
        assert!(first.is_none());
        assert_eq!(table_count(store.connection(), "bucket"), 0);
        for index in 24..30 {
            aggregate.handle_event(index, 30, 1, &keymap(), &policy());
        }
        let second = aggregate.tick(1_020, 10_000, 25);
        assert!(second.is_some());
        let second = second.unwrap_or_else(|| unreachable!());
        store
            .seal_tier_a(device_id, 1, &second)
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
        assert!(store.seal_tier_a(device_id, 1, &tier_a).is_err());

        tier_a_data = TierAAccumulator {
            keystrokes: 25,
            ..TierAAccumulator::default()
        };
        let too_short = TierASeal {
            bucket_id: 1_000,
            span_ms: 9_999,
            data: tier_a_data,
        };
        assert!(store.seal_tier_a(device_id, 1, &too_short).is_err());

        let mut counts = [0_u32; 81];
        counts[0] = 1_999;
        let tier_b = TierBSeal {
            start_ts: 1_000,
            end_ts: 2_000,
            keystrokes: 1_999,
            pos_count: counts,
        };
        assert!(store.seal_tier_b(device_id, 1, &tier_b).is_err());

        let inconsistent_tier_b = TierBSeal {
            start_ts: 1_000,
            end_ts: 2_000,
            keystrokes: 2_000,
            pos_count: counts,
        };
        assert!(store
            .seal_tier_b(device_id, 1, &inconsistent_tier_b)
            .is_err());
        assert_eq!(table_count(store.connection(), "bucket"), 0);
        assert_eq!(table_count(store.connection(), "key_window"), 0);
    }

    #[test]
    fn two_devices_sealing_in_the_same_second_both_persist() {
        let (_temp, _path, mut store, first_device_id) = open_store();
        let second_device_id = store
            .register_device("fixture-2", None, 1_000, &fixture_keymap())
            .unwrap();
        store
            .seal_tier_a(first_device_id, 1, &populated_tier_a_seal(1_000))
            .unwrap_or_else(|error| panic!("{error:#}"));
        store
            .seal_tier_a(second_device_id, 1, &populated_tier_a_seal(1_000))
            .unwrap_or_else(|error| panic!("{error:#}"));

        assert_eq!(table_count(store.connection(), "bucket"), 2);
        assert_eq!(store.refused_tier_a_seals(), 0);
        assert_eq!(
            scalar(
                store.connection(),
                "SELECT COUNT(DISTINCT device_id) FROM bucket WHERE ts = 1000"
            ),
            2
        );
        // The whole bucket travels, not just the header: each device keeps its own child rows.
        assert_eq!(
            scalar(store.connection(), "SELECT SUM(presses) FROM finger_count"),
            60
        );
        assert_eq!(
            scalar(store.connection(), "SELECT SUM(n) FROM gap_hist"),
            58
        );
        assert_eq!(
            scalar(
                store.connection(),
                "SELECT COUNT(DISTINCT bucket_id) FROM finger_count"
            ),
            2
        );
    }

    /// One device sealing the same second twice cannot happen — the aggregator seals one bucket per
    /// device per tick — but a wall clock stepped backwards can produce it, and it must cost one
    /// bucket loudly rather than a whole daemon or a silent `Ok`.
    #[test]
    fn a_duplicate_seal_for_one_device_is_refused_and_counted() {
        let (_temp, _path, mut store, device_id) = open_store();
        store
            .seal_tier_a(device_id, 1, &populated_tier_a_seal(1_000))
            .unwrap_or_else(|error| panic!("{error:#}"));
        let error = store
            .seal_tier_a(device_id, 1, &populated_tier_a_seal(1_000))
            .expect_err("a second seal for one device, profile and second must be refused");

        assert!(error.is::<DuplicateBucketIdentity>(), "{error:#}");
        assert_eq!(store.refused_tier_a_seals(), 1);
        assert_eq!(table_count(store.connection(), "bucket"), 1);
        // The refusal rolls back whole: no half-written child rows behind the refused header.
        assert_eq!(table_count(store.connection(), "finger_count"), 2);
        assert_eq!(
            scalar(store.connection(), "SELECT SUM(presses) FROM finger_count"),
            30
        );

        // The same second under a different profile is a different bucket, not a duplicate.
        let profile_id = store
            .register_profile("gaming")
            .unwrap_or_else(|error| panic!("{error:#}"));
        store
            .seal_tier_a(device_id, profile_id, &populated_tier_a_seal(1_000))
            .unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(table_count(store.connection(), "bucket"), 2);
        assert_eq!(store.refused_tier_a_seals(), 1);
    }

    /// The floors are checked before the insert, and the insert changed. A floor that moved behind
    /// it would write a sub-floor bucket and only fail afterwards.
    #[test]
    fn sealing_still_refuses_a_bucket_below_either_privacy_floor() {
        let (_temp, _path, mut store, device_id) = open_store();
        let mut too_few = populated_tier_a_seal(1_000);
        too_few.data.keystrokes = MIN_TIER_A_SEAL_FLOOR - 1;
        assert!(store.seal_tier_a(device_id, 1, &too_few).is_err());

        let mut too_short = populated_tier_a_seal(2_000);
        too_short.span_ms = MIN_BUCKET_SECONDS * 1_000 - 1;
        assert!(store.seal_tier_a(device_id, 1, &too_short).is_err());

        assert_eq!(table_count(store.connection(), "bucket"), 0);
        assert_eq!(table_count(store.connection(), "finger_count"), 0);
        // A floor breach is not an identity collision, and must not be counted as one.
        assert_eq!(store.refused_tier_a_seals(), 0);
    }

    #[test]
    fn tier_b_floor_and_unattributed_position_are_exact() {
        let (_temp, _path, mut store, device_id) = open_store();
        let mut aggregate = Aggregator::new(0, 1);
        for index in 0..1_998 {
            let batch = aggregate.handle_event(index, 30, 1, &keymap(), &policy());
            assert!(batch.is_empty());
        }
        let batch = aggregate.handle_event(1_998, 200, 1, &keymap(), &policy());
        assert!(batch.is_empty());
        assert_eq!(table_count(store.connection(), "key_window"), 0);
        let seal = aggregate
            .handle_event(1_999, 30, 1, &keymap(), &policy())
            .tier_b
            .unwrap_or_else(|| unreachable!());
        store
            .seal_tier_b(device_id, 1, &seal)
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
        let mut tier_b_partial = Aggregator::new(0, 1);
        for index in 0..1_500 {
            tier_b_partial.handle_event(index, 30, 1, &keymap(), &policy());
        }
        tier_b_partial.discard_partials(10);
        assert_eq!(tier_b_partial.tier_b_total(), 0);

        let mut tier_a_partial = Aggregator::new(0, 1);
        for index in 0..24 {
            tier_a_partial.handle_event(index, 30, 1, &keymap(), &policy());
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
        let mut aggregate = Aggregator::new(1_000, 1);

        aggregate.handle_event(100, 30, 1, &keymap(), &policy());
        aggregate.handle_event(110, 30, 0, &keymap(), &policy());
        aggregate.handle_event(120, 29, 1, &keymap(), &policy());
        aggregate.handle_event(130, 29, 0, &keymap(), &policy());
        aggregate.handle_event(629, 14, 1, &keymap(), &policy());
        aggregate.handle_event(630, 14, 0, &keymap(), &policy());
        aggregate.handle_event(631, 30, 1, &keymap(), &policy());

        let mut tier_b = None;
        for offset in 0..1_997 {
            let mut batch = aggregate.handle_event(632 + offset, 30, 1, &keymap(), &policy());
            if let Some(seal) = batch.tier_b.take() {
                tier_b = Some(seal);
            }
        }
        let tier_b = tier_b.unwrap_or_else(|| unreachable!());
        store.seal_tier_b(device_id, 1, &tier_b).unwrap();
        let tier_a = aggregate
            .tick(1_010, 10_000, 25)
            .unwrap_or_else(|| unreachable!());
        store.seal_tier_a(device_id, 1, &tier_a).unwrap();

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

    fn sample_tier_c_seal() -> TierCSeal {
        // 500 corrections: 300 keep their positions, 150 degrade to fingers, 50 lost even that.
        TierCSeal {
            start_ts: 1_000,
            end_ts: 2_000,
            corrections: 500,
            dropped: 50,
            rows: vec![
                (pack_ngram([0, 1, 2], 0b0000_0001, 1, 2), 200),
                (pack_ngram([POS_ABSENT, POS_UNATTRIBUTED, 79], 0, 3, 0), 100),
            ],
            finger_rows: vec![
                (pack_finger([0, 5, 9], 0, 0, 1), 100),
                (pack_finger([FINGER_ABSENT, 1, 2], 0xff, 2, 6), 50),
            ],
        }
    }

    #[test]
    fn seals_a_tier_c_window() {
        let (_temp, _path, mut store, device_id) = open_store();
        let seal = sample_tier_c_seal();
        store
            .seal_tier_c(device_id, 1, &seal)
            .unwrap_or_else(|error| panic!("{error:#}"));

        assert_eq!(table_count(store.connection(), "ngram_window"), 1);
        assert_eq!(
            scalar(store.connection(), "SELECT corrections FROM ngram_window"),
            500
        );
        assert_eq!(
            scalar(store.connection(), "SELECT degraded FROM ngram_window"),
            150
        );
        assert_eq!(
            scalar(store.connection(), "SELECT dropped FROM ngram_window"),
            50
        );
        assert_eq!(table_count(store.connection(), "ngram"), 2);
        assert_eq!(scalar(store.connection(), "SELECT SUM(n) FROM ngram"), 300);
        assert_eq!(table_count(store.connection(), "ngram_finger"), 2);
        assert_eq!(
            scalar(store.connection(), "SELECT SUM(n) FROM ngram_finger"),
            150
        );

        let row: (i64, i64, i64, i64, i64, i64) = store
            .connection()
            .query_row(
                "SELECT pos_a, pos_b, pos_c, mod_mask, latency_bucket, run_bucket
                 FROM ngram WHERE n = 200",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(row, (0, 1, 2, 1, 1, 2));

        // -1 is the existing `pos_count` unattributed convention; -2 is the Tier C extension.
        let sentinels: (i64, i64) = store
            .connection()
            .query_row("SELECT pos_a, pos_b FROM ngram WHERE n = 100", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(sentinels, (-2, -1));
        assert_eq!(
            scalar(
                store.connection(),
                "SELECT finger_a FROM ngram_finger WHERE n = 50"
            ),
            -1
        );
    }

    #[test]
    fn refuses_a_tier_c_window_below_the_floor() {
        let (_temp, _path, mut store, device_id) = open_store();
        let seal = TierCSeal {
            start_ts: 1_000,
            end_ts: 2_000,
            corrections: 499,
            dropped: 0,
            rows: vec![(pack_ngram([0, 1, 2], 0, 0, 0), 499)],
            finger_rows: Vec::new(),
        };
        assert!(store.seal_tier_c(device_id, 1, &seal).is_err());
        assert_eq!(table_count(store.connection(), "ngram_window"), 0);
        assert_eq!(table_count(store.connection(), "ngram"), 0);
    }

    #[test]
    fn refuses_an_inconsistent_tier_c_window() {
        let (_temp, _path, mut store, device_id) = open_store();
        let mut seal = sample_tier_c_seal();
        seal.dropped = 49;
        assert!(
            store.seal_tier_c(device_id, 1, &seal).is_err(),
            "degradation moves counts, so the three parts must sum exactly"
        );
        assert_eq!(table_count(store.connection(), "ngram_window"), 0);
        assert_eq!(table_count(store.connection(), "ngram_finger"), 0);
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
