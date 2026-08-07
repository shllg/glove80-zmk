//! The device registry: what the `device` table holds, and how to put one keyboard's fragmented
//! history back together.
//!
//! Logging policy: counts, device ids and evdev names only — never keycodes or positions.
//!
//! This lives beside `store.rs` rather than inside it because `keylabctl` is a separate binary
//! target that pulls modules in with `#[path]`. Including `store.rs` there would drag `aggregate`,
//! `encode` and `keymap` along with it, and every item of those the CLI does not call is a
//! `dead_code` warning under `-D warnings`. Both files instead agree on `schema.sql`, which each
//! includes, so the schema this module's tests build cannot drift from the one the daemon writes.

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, ErrorCode, OptionalExtension, TransactionBehavior};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// The six tables that hang off `bucket(id)`: the key columns other than `bucket_id`, and the
/// column carrying the count. A collision merges them key by key and the counts add, because
/// dropping one side is the defect schema v5 exists to remove, reintroduced by the back door.
const BUCKET_CHILDREN: [(&str, &[&str], &str); 6] = [
    ("finger_count", &["finger_id"], "presses"),
    ("row_count", &["hand", "row_idx"], "presses"),
    ("hold_hist", &["finger_id", "dur_bucket"], "n"),
    ("mod_hold_hist", &["mod_class", "dur_bucket"], "n"),
    ("gap_hist", &["hand", "gap_bucket"], "n"),
    ("event_count", &["kind", "subject"], "n"),
];

/// One row of the `device` table, with everything that tells it apart from another row of the same
/// keyboard. The figures are the ones `/api/devices` shows, computed the same way: two tools that
/// count the same thing differently are worse than one tool.
pub struct DeviceRow {
    pub id: i64,
    pub name: String,
    /// `keymap_kind` — the position space. `None` only in a database that predates the v2 → v3
    /// backfill and was never opened by a daemon since.
    pub position_space: Option<String>,
    /// Local time, formatted by SQLite so the CLI needs no calendar of its own.
    pub first_seen: String,
    pub keystrokes: i64,
    pub tier_b_windows: i64,
    pub tier_c_windows: i64,
}

impl DeviceRow {
    /// Tier B is the only tier carrying position identity, so a row with no window has no heatmap
    /// to draw however many keystrokes it holds. That is what an orphan looks like from the
    /// outside: real Tier A history, and nothing that can be placed on a keyboard.
    pub fn holds_positional_data(&self) -> bool {
        self.tier_b_windows > 0
    }
}

/// Every registered device, including rows that hold nothing at all — a merge has to be able to
/// name them, and the viewer's menu deliberately hides them.
pub fn list_devices(connection: &Connection) -> Result<Vec<DeviceRow>> {
    let mut statement = connection
        .prepare(
            "SELECT d.id, d.name, d.keymap_kind,
                    strftime('%Y-%m-%d %H:%M', d.first_ts, 'unixepoch', 'localtime'),
                    (SELECT COALESCE(SUM(b.keystrokes), 0) FROM bucket b WHERE b.device_id = d.id),
                    (SELECT COUNT(*) FROM key_window kw WHERE kw.device_id = d.id),
                    (SELECT COUNT(*) FROM ngram_window nw WHERE nw.device_id = d.id)
             FROM device d
             ORDER BY d.id",
        )
        .context("failed to prepare the device listing")?;
    let rows = statement
        .query_map([], |row| {
            Ok(DeviceRow {
                id: row.get(0)?,
                name: row.get(1)?,
                position_space: row.get(2)?,
                first_seen: row.get(3)?,
                keystrokes: row.get(4)?,
                tier_b_windows: row.get(5)?,
                tier_c_windows: row.get(6)?,
            })
        })
        .context("failed to read the device listing")?
        .collect::<Result<Vec<_>, _>>()
        .context("failed to read a device row")?;
    Ok(rows)
}

pub fn format_device_table(rows: &[DeviceRow]) -> String {
    if rows.is_empty() {
        return "no devices registered\n".to_owned();
    }
    let name_width = rows
        .iter()
        .map(|row| row.name.chars().count())
        .chain([6])
        .max()
        .unwrap_or(6);
    let space_width = rows
        .iter()
        .map(|row| space_label(row.position_space.as_deref()).chars().count())
        .chain([5])
        .max()
        .unwrap_or(5);
    let mut output = format!(
        "{:>4}  {:<name_width$}  {:<space_width$}  {:<16}  {:>9}  {:>6}  {:>6}\n",
        "id", "name", "space", "first seen", "tier A", "tier B", "tier C"
    );
    let mut orphans = 0;
    for row in rows {
        let marker = if row.holds_positional_data() {
            ""
        } else {
            orphans += 1;
            "  no positional data"
        };
        output.push_str(&format!(
            "{:>4}  {:<name_width$}  {:<space_width$}  {:<16}  {:>9}  {:>6}  {:>6}{}\n",
            row.id,
            row.name,
            space_label(row.position_space.as_deref()),
            row.first_seen,
            row.keystrokes,
            row.tier_b_windows,
            row.tier_c_windows,
            marker
        ));
    }
    if orphans > 0 {
        output.push_str(&format!(
            "\n{orphans} of {} rows hold no Tier B window, so nothing they hold can be drawn on a \
             keyboard.\nAn older daemon minted a device row per reconnect; `keylabctl devices \
             merge` puts them back together.\n",
            rows.len()
        ));
    }
    output
}

/// A merge that has passed every guard. Producing one writes nothing: the position-space refusal
/// has to happen before a backup is taken, let alone before a transaction is opened.
pub struct MergePlan {
    pub target: i64,
    pub sources: Vec<i64>,
    /// The one space every device in the merge belongs to, carried so the report can name it.
    pub position_space: Option<String>,
}

#[derive(Default)]
pub struct MergeReport {
    pub buckets_moved: usize,
    /// Buckets that landed on an identity the target already held and were summed into it. A
    /// non-zero count means both rows sealed in the same second under the same profile.
    pub buckets_combined: usize,
    pub key_windows_moved: usize,
    pub ngram_windows_moved: usize,
    pub devices_removed: usize,
}

/// Validates a merge and refuses it before anything at all is written.
pub fn plan_merge(connection: &Connection, sources: &[i64], target: i64) -> Result<MergePlan> {
    if sources.is_empty() {
        bail!("no source device given");
    }
    let mut unique: Vec<i64> = Vec::with_capacity(sources.len());
    for source in sources {
        if *source == target {
            bail!("device {target} is both the source and the target of this merge");
        }
        if unique.contains(source) {
            bail!("device {source} is listed twice as a source");
        }
        unique.push(*source);
    }

    let target_space = device_space(connection, target)?
        .with_context(|| format!("no device with id {target} is registered"))?;
    for source in &unique {
        let source_space = device_space(connection, *source)?
            .with_context(|| format!("no device with id {source} is registered"))?;
        // The whole point of this guard. `pos` only means something inside one keyboard's
        // geometry, so folding one space into another is the same violation as a pooled read,
        // and it fails the same way: loudly, naming both spaces, before touching anything.
        if source_space != target_space {
            bail!(
                "refusing to merge device {source} ({}) into device {target} ({}): they are in \
                 different position spaces, and a key position only means something inside one. \
                 Nothing was written.",
                space_label(source_space.as_deref()),
                space_label(target_space.as_deref())
            );
        }
    }
    Ok(MergePlan {
        target,
        sources: unique,
        position_space: target_space,
    })
}

/// Proves no other process holds the write lock, before a backup is taken or a row is touched.
pub fn require_exclusive_write_access(connection: &mut Connection) -> Result<()> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(describe_lock_failure)?;
    transaction
        .rollback()
        .context("failed to release the database write lock probe")
}

/// Copies the database beside itself with `VACUUM INTO`, which writes one self-contained file with
/// the write-ahead log already folded in — so the backup needs no `-wal` companion to be complete.
/// A merge is not reversible except from this file.
pub fn backup_database(connection: &Connection, db_path: &Path) -> Result<PathBuf> {
    let stamp: String = connection
        .query_row(
            "SELECT strftime('%Y%m%d-%H%M%S', 'now', 'localtime')",
            [],
            |row| row.get(0),
        )
        .context("failed to read the local time for the backup name")?;
    let file_name = db_path
        .file_name()
        .context("database path has no file name")?
        .to_str()
        .context("database path is not valid UTF-8")?
        .to_owned();
    let backup = db_path.with_file_name(format!("{file_name}.pre-merge-{stamp}"));
    if backup.exists() {
        bail!(
            "refusing to overwrite an existing backup at {}",
            backup.display()
        );
    }
    let backup_arg = backup
        .to_str()
        .context("backup path is not valid UTF-8")?
        .to_owned();
    connection
        .execute("VACUUM INTO ?1", params![backup_arg])
        .with_context(|| format!("failed to back the database up to {}", backup.display()))?;
    // The database is privacy-sensitive and `VACUUM INTO` creates the file with the process umask,
    // so the mode is set explicitly rather than inherited.
    fs::set_permissions(&backup, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("failed to restrict {} to mode 0600", backup.display()))?;
    Ok(backup)
}

/// Repoints every tier onto the target and deletes the emptied device rows, in one transaction.
/// A failure at any point leaves the database exactly as it was.
pub fn apply_merge(connection: &mut Connection, plan: &MergePlan) -> Result<MergeReport> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(describe_lock_failure)?;
    let mut report = MergeReport::default();
    for source in &plan.sources {
        // Collisions first: after schema v5 a bucket is unique on `(ts, device_id, profile_id)`,
        // so repointing can land on an identity the target already holds. `MIN(t.id)` keeps one
        // source bucket from matching two target rows, which a null profile makes possible.
        let collisions: Vec<(i64, i64)> = transaction
            .prepare(
                "SELECT s.id, MIN(t.id)
                 FROM bucket s
                 JOIN bucket t
                   ON t.device_id = ?2 AND t.ts = s.ts AND t.profile_id IS s.profile_id
                 WHERE s.device_id = ?1
                 GROUP BY s.id",
            )
            .context("failed to prepare the bucket collision scan")?
            .query_map(params![source, plan.target], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .context("failed to scan for colliding buckets")?
            .collect::<Result<Vec<_>, _>>()
            .context("failed to read a colliding bucket")?;
        for (source_bucket, target_bucket) in collisions {
            combine_buckets(&transaction, source_bucket, target_bucket)?;
            report.buckets_combined += 1;
        }

        report.buckets_moved += transaction
            .execute(
                "UPDATE bucket SET device_id = ?2 WHERE device_id = ?1",
                params![source, plan.target],
            )
            .context("failed to repoint Tier A buckets")?;
        report.key_windows_moved += transaction
            .execute(
                "UPDATE key_window SET device_id = ?2 WHERE device_id = ?1",
                params![source, plan.target],
            )
            .context("failed to repoint Tier B windows")?;
        report.ngram_windows_moved += transaction
            .execute(
                "UPDATE ngram_window SET device_id = ?2 WHERE device_id = ?1",
                params![source, plan.target],
            )
            .context("failed to repoint Tier C windows")?;

        // Deleting a device row that anything still points at must be impossible, so the delete
        // happens after the repoint and inside the same transaction. Foreign keys are enforced by
        // default in this build, which makes it impossible rather than merely unlikely.
        report.devices_removed += transaction
            .execute("DELETE FROM device WHERE id = ?1", params![source])
            .with_context(|| format!("failed to remove the merged device row {source}"))?;
    }
    transaction
        .commit()
        .context("failed to commit the device merge")?;
    Ok(report)
}

/// Adds one bucket into another, key by key across all six child tables, then removes the source.
/// Both rows sealed in the same second under the same profile, so both counted real keystrokes.
fn combine_buckets(
    transaction: &rusqlite::Transaction<'_>,
    source_bucket: i64,
    target_bucket: i64,
) -> Result<()> {
    for (table, keys, value) in BUCKET_CHILDREN {
        // Every fragment below is a compile-time constant from `BUCKET_CHILDREN`; nothing here
        // comes from a caller, so the formatting is table plumbing rather than a query built from
        // input.
        let key_columns = keys.join(", ");
        let upsert = format!(
            "INSERT INTO {table}(bucket_id, {key_columns}, {value})
             SELECT ?1, {key_columns}, {value} FROM {table} WHERE bucket_id = ?2
             ON CONFLICT(bucket_id, {key_columns})
             DO UPDATE SET {value} = {table}.{value} + excluded.{value}"
        );
        transaction
            .execute(&upsert, params![target_bucket, source_bucket])
            .with_context(|| format!("failed to combine {table} rows"))?;
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE bucket_id = ?1"),
                params![source_bucket],
            )
            .with_context(|| format!("failed to clear the merged {table} rows"))?;
    }
    let (span_ms, active_ms, keystrokes, autorepeats): (i64, i64, i64, i64) = transaction
        .query_row(
            "SELECT span_ms, active_ms, keystrokes, autorepeats FROM bucket WHERE id = ?1",
            params![source_bucket],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .context("failed to read the colliding bucket")?;
    // The spans add along with the counts. Two devices' seconds overlapped, so the merged row
    // covers more typing time than one second of wall clock — which is what happened, and an
    // invented cap would be a guess rather than a record.
    transaction
        .execute(
            "UPDATE bucket
             SET span_ms = span_ms + ?2, active_ms = active_ms + ?3,
                 keystrokes = keystrokes + ?4, autorepeats = autorepeats + ?5
             WHERE id = ?1",
            params![target_bucket, span_ms, active_ms, keystrokes, autorepeats],
        )
        .context("failed to sum a colliding bucket into its target")?;
    transaction
        .execute("DELETE FROM bucket WHERE id = ?1", params![source_bucket])
        .context("failed to remove the merged bucket")?;
    Ok(())
}

fn device_space(connection: &Connection, id: i64) -> Result<Option<Option<String>>> {
    connection
        .query_row(
            "SELECT keymap_kind FROM device WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .with_context(|| format!("failed to look up device {id}"))
}

fn space_label(space: Option<&str>) -> &str {
    space.unwrap_or("(none)")
}

fn describe_lock_failure(error: rusqlite::Error) -> anyhow::Error {
    let busy = matches!(
        &error,
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.code == ErrorCode::DatabaseBusy || failure.code == ErrorCode::DatabaseLocked
    );
    if busy {
        anyhow::Error::new(error).context(
            "another process holds the database write lock; stop the daemon first with \
             `sudo systemctl stop keylab.service`",
        )
    } else {
        anyhow::Error::new(error).context("failed to take the database write lock")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// The daemon's own schema, so a merge is always tested against the tables it will meet.
    const SCHEMA: &str = include_str!("schema.sql");

    struct Fixture {
        _temp: TempDir,
        path: PathBuf,
        connection: Connection,
    }

    fn fixture() -> Fixture {
        let temp = TempDir::new().unwrap_or_else(|error| panic!("{error}"));
        let path = temp.path().join("keylab.db");
        let connection = Connection::open(&path).unwrap_or_else(|error| panic!("{error}"));
        connection
            .execute_batch(SCHEMA)
            .unwrap_or_else(|error| panic!("{error}"));
        connection
            .execute_batch("INSERT INTO profile(id, name) VALUES (1, 'default');")
            .unwrap_or_else(|error| panic!("{error}"));
        Fixture {
            _temp: temp,
            path,
            connection,
        }
    }

    fn add_device(fixture: &Fixture, id: i64, first_ts: i64, space: &str) {
        fixture
            .connection
            .execute(
                "INSERT INTO device(id, name, uniq, first_ts, keymap_kind, keymap_hash)
                 VALUES (?1, 'Evsieve Virtual Device', NULL, ?2, ?3, 'sha256:fixture')",
                params![id, first_ts, space],
            )
            .unwrap_or_else(|error| panic!("{error}"));
    }

    /// A bucket with one row in every child table, so a merge that forgets a table is visible as a
    /// missing count rather than as nothing at all.
    fn add_bucket(fixture: &Fixture, id: i64, ts: i64, device_id: i64, keystrokes: i64) {
        let connection = &fixture.connection;
        connection
            .execute(
                "INSERT INTO bucket(id, ts, device_id, profile_id, span_ms, active_ms, keystrokes,
                                    autorepeats)
                 VALUES (?1, ?2, ?3, 1, 10000, 5000, ?4, 2)",
                params![id, ts, device_id, keystrokes],
            )
            .unwrap_or_else(|error| panic!("{error}"));
        for (statement, value) in [
            ("INSERT INTO finger_count(bucket_id, finger_id, presses) VALUES (?1, 3, ?2)", keystrokes),
            ("INSERT INTO row_count(bucket_id, hand, row_idx, presses) VALUES (?1, 0, 4, ?2)", keystrokes),
            ("INSERT INTO hold_hist(bucket_id, finger_id, dur_bucket, n) VALUES (?1, 3, 2, ?2)", keystrokes),
            ("INSERT INTO mod_hold_hist(bucket_id, mod_class, dur_bucket, n) VALUES (?1, 0, 1, ?2)", 4),
            ("INSERT INTO gap_hist(bucket_id, hand, gap_bucket, n) VALUES (?1, 0, 5, ?2)", keystrokes),
            ("INSERT INTO event_count(bucket_id, kind, subject, n) VALUES (?1, 1, 0, ?2)", 7),
        ] {
            connection
                .execute(statement, params![id, value])
                .unwrap_or_else(|error| panic!("{error}"));
        }
    }

    fn add_key_window(fixture: &Fixture, id: i64, device_id: i64, keystrokes: i64) {
        fixture
            .connection
            .execute(
                "INSERT INTO key_window(id, device_id, profile_id, start_ts, end_ts, keystrokes)
                 VALUES (?1, ?2, 1, 100, 200, ?3)",
                params![id, device_id, keystrokes],
            )
            .unwrap_or_else(|error| panic!("{error}"));
        fixture
            .connection
            .execute(
                "INSERT INTO pos_count(window_id, pos, presses) VALUES (?1, 12, ?2)",
                params![id, keystrokes],
            )
            .unwrap_or_else(|error| panic!("{error}"));
    }

    fn add_ngram_window(fixture: &Fixture, id: i64, device_id: i64) {
        fixture
            .connection
            .execute(
                "INSERT INTO ngram_window(id, device_id, profile_id, start_ts, end_ts, corrections,
                                          degraded, dropped)
                 VALUES (?1, ?2, 1, 100, 200, 500, 0, 0)",
                params![id, device_id],
            )
            .unwrap_or_else(|error| panic!("{error}"));
    }

    fn scalar(fixture: &Fixture, sql: &str) -> i64 {
        fixture
            .connection
            .query_row(sql, [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{sql}: {error}"))
    }

    #[test]
    fn devices_list_reports_every_row_that_holds_data() {
        let fixture = fixture();
        add_device(&fixture, 1, 1_700_000_000, "glove80");
        add_device(&fixture, 2, 1_700_000_100, "glove80");
        add_device(&fixture, 3, 1_700_000_200, "qwerty-ansi");
        add_bucket(&fixture, 10, 1_700_000_010, 1, 300);
        add_bucket(&fixture, 11, 1_700_000_020, 1, 200);
        add_bucket(&fixture, 12, 1_700_000_030, 2, 50);
        add_key_window(&fixture, 1, 1, 2_000);
        add_ngram_window(&fixture, 1, 1);

        let rows = list_devices(&fixture.connection).unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(
            rows.len(),
            3,
            "every registered row is listed, empty or not"
        );

        assert_eq!(rows[0].id, 1);
        assert_eq!(rows[0].name, "Evsieve Virtual Device");
        assert_eq!(rows[0].position_space.as_deref(), Some("glove80"));
        assert_eq!(rows[0].keystrokes, 500);
        assert_eq!(rows[0].tier_b_windows, 1);
        assert_eq!(rows[0].tier_c_windows, 1);
        assert!(!rows[0].first_seen.is_empty());

        assert_eq!(rows[1].id, 2);
        assert_eq!(rows[1].keystrokes, 50);
        assert_eq!(rows[1].tier_b_windows, 0);

        assert_eq!(rows[2].id, 3);
        assert_eq!(rows[2].position_space.as_deref(), Some("qwerty-ansi"));
        assert_eq!(rows[2].keystrokes, 0);
    }

    #[test]
    fn devices_list_marks_a_row_with_no_positional_data() {
        let fixture = fixture();
        add_device(&fixture, 1, 1_700_000_000, "glove80");
        add_device(&fixture, 2, 1_700_000_100, "glove80");
        add_bucket(&fixture, 10, 1_700_000_010, 1, 300);
        add_bucket(&fixture, 11, 1_700_000_020, 2, 90);
        add_key_window(&fixture, 1, 1, 2_000);

        let rows = list_devices(&fixture.connection).unwrap_or_else(|error| panic!("{error:#}"));
        assert!(rows[0].holds_positional_data());
        assert!(
            !rows[1].holds_positional_data(),
            "Tier A keystrokes with no Tier B window is exactly what an orphan holds"
        );

        let table = format_device_table(&rows);
        let lines: Vec<&str> = table.lines().collect();
        assert!(!lines[1].contains("no positional data"), "{table}");
        assert!(lines[2].contains("no positional data"), "{table}");
        assert!(
            table.contains("1 of 2 rows hold no Tier B window"),
            "{table}"
        );
    }

    #[test]
    fn merging_across_position_spaces_is_refused_before_anything_is_written() {
        let fixture = fixture();
        add_device(&fixture, 1, 1_700_000_000, "glove80");
        add_device(&fixture, 2, 1_700_000_100, "qwerty-ansi");
        add_bucket(&fixture, 10, 1_700_000_010, 1, 300);
        add_bucket(&fixture, 11, 1_700_000_020, 2, 90);

        let error = plan_merge(&fixture.connection, &[2], 1)
            .err()
            .unwrap_or_else(|| panic!("a merge across position spaces must be refused"));
        let message = format!("{error:#}");
        assert!(message.contains("qwerty-ansi"), "{message}");
        assert!(message.contains("glove80"), "{message}");
        assert!(message.contains("Nothing was written"), "{message}");

        assert_eq!(scalar(&fixture, "SELECT COUNT(*) FROM device"), 2);
        assert_eq!(
            scalar(&fixture, "SELECT device_id FROM bucket WHERE id = 11"),
            2,
            "the refusal happens before a transaction is opened"
        );
    }

    #[test]
    fn a_merge_moves_every_tier_and_leaves_no_orphan_rows() {
        let mut fixture = fixture();
        add_device(&fixture, 1, 1_700_000_000, "glove80");
        add_device(&fixture, 2, 1_700_000_100, "glove80");
        add_device(&fixture, 3, 1_700_000_200, "glove80");
        add_bucket(&fixture, 10, 1_700_000_010, 1, 300);
        add_bucket(&fixture, 11, 1_700_000_020, 2, 90);
        add_bucket(&fixture, 12, 1_700_000_030, 3, 40);
        add_key_window(&fixture, 1, 1, 2_000);
        add_key_window(&fixture, 2, 2, 2_500);
        add_ngram_window(&fixture, 1, 3);

        let plan =
            plan_merge(&fixture.connection, &[2, 3], 1).unwrap_or_else(|error| panic!("{error:#}"));
        assert_eq!(plan.position_space.as_deref(), Some("glove80"));
        let report =
            apply_merge(&mut fixture.connection, &plan).unwrap_or_else(|error| panic!("{error:#}"));

        assert_eq!(report.buckets_moved, 2);
        assert_eq!(report.buckets_combined, 0);
        assert_eq!(report.key_windows_moved, 1);
        assert_eq!(report.ngram_windows_moved, 1);
        assert_eq!(report.devices_removed, 2);

        assert_eq!(scalar(&fixture, "SELECT COUNT(*) FROM device"), 1);
        assert_eq!(
            scalar(
                &fixture,
                "SELECT SUM(keystrokes) FROM bucket WHERE device_id = 1"
            ),
            430,
            "no keystroke is lost or duplicated by the repoint"
        );
        assert_eq!(scalar(&fixture, "SELECT COUNT(*) FROM bucket"), 3);
        assert_eq!(
            scalar(&fixture, "SELECT COUNT(*) FROM finger_count"),
            3,
            "child rows follow their bucket id, which the merge never rewrites"
        );
        assert_eq!(
            scalar(&fixture, "SELECT COUNT(*) FROM pos_count"),
            2,
            "Tier B position histograms hang off the window, not the device"
        );
        for (table, column) in [
            ("bucket", "device_id"),
            ("key_window", "device_id"),
            ("ngram_window", "device_id"),
        ] {
            assert_eq!(
                scalar(
                    &fixture,
                    &format!(
                        "SELECT COUNT(*) FROM {table} c
                         WHERE NOT EXISTS (SELECT 1 FROM device d WHERE d.id = c.{column})"
                    )
                ),
                0,
                "{table} holds a row pointing at a device that no longer exists"
            );
        }
        assert_eq!(
            scalar(&fixture, "SELECT COUNT(*) FROM pragma_foreign_key_check"),
            0
        );
    }

    #[test]
    fn colliding_buckets_are_summed_and_the_count_is_reported() {
        let mut fixture = fixture();
        add_device(&fixture, 1, 1_700_000_000, "glove80");
        add_device(&fixture, 2, 1_700_000_100, "glove80");
        // The same second, the same profile, two device rows: after schema v5 these are two
        // buckets, and repointing one onto the other is the only way they can ever collide.
        add_bucket(&fixture, 10, 1_700_000_010, 1, 300);
        add_bucket(&fixture, 11, 1_700_000_010, 2, 90);
        add_bucket(&fixture, 12, 1_700_000_099, 2, 40);

        let plan =
            plan_merge(&fixture.connection, &[2], 1).unwrap_or_else(|error| panic!("{error:#}"));
        let report =
            apply_merge(&mut fixture.connection, &plan).unwrap_or_else(|error| panic!("{error:#}"));

        assert_eq!(report.buckets_combined, 1);
        assert_eq!(
            report.buckets_moved, 1,
            "the non-colliding bucket is repointed"
        );
        assert_eq!(
            scalar(&fixture, "SELECT SUM(keystrokes) FROM bucket"),
            430,
            "the colliding counts are summed, never dropped"
        );
        assert_eq!(
            scalar(&fixture, "SELECT keystrokes FROM bucket WHERE id = 10"),
            390
        );
        assert_eq!(
            scalar(&fixture, "SELECT span_ms FROM bucket WHERE id = 10"),
            20_000
        );
        assert_eq!(
            scalar(&fixture, "SELECT autorepeats FROM bucket WHERE id = 10"),
            4
        );
        assert_eq!(
            scalar(&fixture, "SELECT COUNT(*) FROM bucket WHERE id = 11"),
            0
        );
        // The child rows of both buckets shared every key, so each table must hold one summed row
        // rather than two rows or one overwritten one.
        assert_eq!(
            scalar(
                &fixture,
                "SELECT presses FROM finger_count WHERE bucket_id = 10"
            ),
            390
        );
        assert_eq!(
            scalar(
                &fixture,
                "SELECT COUNT(*) FROM finger_count WHERE bucket_id = 10"
            ),
            1
        );
        assert_eq!(
            scalar(&fixture, "SELECT n FROM hold_hist WHERE bucket_id = 10"),
            390
        );
        assert_eq!(
            scalar(&fixture, "SELECT n FROM event_count WHERE bucket_id = 10"),
            14
        );
        assert_eq!(
            scalar(
                &fixture,
                "SELECT COUNT(*) FROM finger_count WHERE bucket_id = 11"
            ),
            0,
            "the merged bucket's child rows are cleared, not orphaned"
        );
        assert_eq!(
            scalar(&fixture, "SELECT COUNT(*) FROM pragma_foreign_key_check"),
            0
        );
    }

    #[test]
    fn a_failed_merge_leaves_the_database_exactly_as_it_was() {
        let mut fixture = fixture();
        add_device(&fixture, 1, 1_700_000_000, "glove80");
        add_device(&fixture, 2, 1_700_000_100, "glove80");
        add_bucket(&fixture, 10, 1_700_000_010, 2, 300);
        add_bucket(&fixture, 11, 1_700_000_020, 2, 90);
        add_key_window(&fixture, 1, 2, 2_000);

        let plan =
            plan_merge(&fixture.connection, &[2], 1).unwrap_or_else(|error| panic!("{error:#}"));
        // The target disappears between the plan and the write, which is what a merge racing
        // another writer looks like from inside the transaction.
        fixture
            .connection
            .execute("DELETE FROM device WHERE id = 1", [])
            .unwrap_or_else(|error| panic!("{error}"));

        let error = apply_merge(&mut fixture.connection, &plan)
            .err()
            .unwrap_or_else(|| panic!("repointing onto a device that no longer exists must fail"));
        assert!(format!("{error:#}").contains("repoint"), "{error:#}");

        assert_eq!(
            scalar(&fixture, "SELECT COUNT(*) FROM device WHERE id = 2"),
            1
        );
        assert_eq!(
            scalar(&fixture, "SELECT COUNT(*) FROM bucket WHERE device_id = 2"),
            2
        );
        assert_eq!(
            scalar(
                &fixture,
                "SELECT COUNT(*) FROM key_window WHERE device_id = 2"
            ),
            1
        );
        assert_eq!(scalar(&fixture, "SELECT SUM(keystrokes) FROM bucket"), 390);
        assert_eq!(
            scalar(&fixture, "SELECT COUNT(*) FROM pragma_foreign_key_check"),
            0
        );
    }

    #[test]
    fn a_merge_refuses_a_device_that_is_not_registered_or_is_its_own_target() {
        let fixture = fixture();
        add_device(&fixture, 1, 1_700_000_000, "glove80");
        add_device(&fixture, 2, 1_700_000_100, "glove80");

        assert!(plan_merge(&fixture.connection, &[2], 2).is_err());
        assert!(plan_merge(&fixture.connection, &[2, 2], 1).is_err());
        assert!(plan_merge(&fixture.connection, &[], 1).is_err());
        assert!(plan_merge(&fixture.connection, &[9], 1).is_err());
        assert!(plan_merge(&fixture.connection, &[2], 9).is_err());
    }

    #[test]
    fn a_backup_is_a_complete_database_the_merge_cannot_touch() {
        let mut fixture = fixture();
        add_device(&fixture, 1, 1_700_000_000, "glove80");
        add_device(&fixture, 2, 1_700_000_100, "glove80");
        add_bucket(&fixture, 10, 1_700_000_010, 2, 300);

        let backup = backup_database(&fixture.connection, &fixture.path)
            .unwrap_or_else(|error| panic!("{error:#}"));
        let mode = fs::metadata(&backup)
            .unwrap_or_else(|error| panic!("{error}"))
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o600,
            "a backup of a privacy-sensitive database is not world-readable"
        );

        let plan =
            plan_merge(&fixture.connection, &[2], 1).unwrap_or_else(|error| panic!("{error:#}"));
        apply_merge(&mut fixture.connection, &plan).unwrap_or_else(|error| panic!("{error:#}"));

        let restored = Connection::open(&backup).unwrap_or_else(|error| panic!("{error}"));
        let devices: i64 = restored
            .query_row("SELECT COUNT(*) FROM device", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("{error}"));
        let owner: i64 = restored
            .query_row("SELECT device_id FROM bucket WHERE id = 10", [], |row| {
                row.get(0)
            })
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(devices, 2, "the backup still holds the pre-merge registry");
        assert_eq!(owner, 2, "a merge is reversible only from this file");

        match backup_database(&fixture.connection, &fixture.path) {
            Ok(second) => assert_ne!(second, backup, "a second backup never overwrites the first"),
            Err(error) => assert!(
                format!("{error:#}").contains("refusing to overwrite"),
                "{error:#}"
            ),
        }
    }

    #[test]
    fn a_merge_refuses_to_start_while_another_process_holds_the_write_lock() {
        let mut fixture = fixture();
        add_device(&fixture, 1, 1_700_000_000, "glove80");
        let daemon = Connection::open(&fixture.path).unwrap_or_else(|error| panic!("{error}"));
        daemon
            .execute_batch("BEGIN IMMEDIATE;")
            .unwrap_or_else(|error| panic!("{error}"));

        let error = require_exclusive_write_access(&mut fixture.connection)
            .err()
            .unwrap_or_else(|| panic!("a held write lock must be refused, not waited on"));
        assert!(
            format!("{error:#}").contains("systemctl stop keylab.service"),
            "{error:#}"
        );

        daemon
            .execute_batch("ROLLBACK;")
            .unwrap_or_else(|error| panic!("{error}"));
        require_exclusive_write_access(&mut fixture.connection)
            .unwrap_or_else(|error| panic!("{error:#}"));
    }
}
