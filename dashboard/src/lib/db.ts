import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";

// Build-time override: VITE_DB_PATH (used to point the dashboard at a demo DB or
// a custom dev path — see vite.config.ts). When empty, the path is resolved at
// runtime to %LOCALAPPDATA%\Time\time_log.db by the Rust `db_path` command, the
// same location the tracker derives in tracker/config.py, so the two halves
// share one database.
const OVERRIDE: string = (import.meta.env.VITE_DB_PATH as string) || "";

let resolvedPath: string | null = OVERRIDE || null;
let dbPromise: Promise<Database> | null = null;

async function ensurePath(): Promise<string> {
  if (resolvedPath === null) resolvedPath = await invoke<string>("db_path");
  return resolvedPath;
}

export function getDb(): Promise<Database> {
  if (!dbPromise) {
    // sqlx wants forward slashes in the sqlite: URL even on Windows.
    dbPromise = ensurePath().then((p) => Database.load(`sqlite:${p.replace(/\\/g, "/")}`));
  }
  return dbPromise;
}

// Native filesystem path of the live DB, for display and the backup filename.
// Empty until getDb() has resolved it — which always happens first, because app
// startup gates rendering on the meta load, and that opens the DB.
export function getDbPath(): string {
  return resolvedPath ?? "";
}
