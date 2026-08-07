import { Database } from "bun:sqlite";

export const SUPPORTED_SCHEMA_VERSION = 6;

interface MetaRow {
  value: string;
}

export function openKeylabDatabase(path: string): Database {
  let database: Database;
  try {
    database = new Database(path, { readonly: true });
  } catch (error) {
    throw new Error(`Unable to open keylab database read-only at ${path}`, { cause: error });
  }

  try {
    const row = database
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as MetaRow | null;
    if (!row) {
      throw new Error("keylab database has no meta.schema_version");
    }
    const version = Number(row.value);
    if (version !== SUPPORTED_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported keylab schema_version ${JSON.stringify(row.value)}; expected ${SUPPORTED_SCHEMA_VERSION}`
          + (version < SUPPORTED_SCHEMA_VERSION
            ? ". Restart keylab.service once; the daemon migrates older schemas in place."
            : ""),
      );
    }
    return database;
  } catch (error) {
    database.close();
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Unable to validate keylab database schema", { cause: error });
  }
}
