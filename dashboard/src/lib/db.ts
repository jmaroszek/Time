import Database from "@tauri-apps/plugin-sql";

// Absolute path to the shared SQLite DB, resolved at build time in
// vite.config.ts: VITE_DB_PATH env var if set, else Data/time_log.db in the
// repo layout (the tracker derives the same path in tracker/config.py).
const DB_PATH: string = import.meta.env.VITE_DB_PATH as string;

let dbPromise: Promise<Database> | null = null;

export function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load(`sqlite:${DB_PATH}`);
  return dbPromise;
}

export function getDbPath(): string {
  return DB_PATH;
}
