import { invoke } from "@tauri-apps/api/core";

// The native backend owns the one allowed database connection. This module
// exposes query ergonomics without granting the webview arbitrary file access.
let resolvedPath: string | null = null;
export interface QueryResult {
  rowsAffected: number;
  lastInsertId?: number;
}

class TimeDatabase {
  async select<T>(query: string, values: unknown[] = []): Promise<T> {
    return invoke<T>("db_select", { query, values });
  }

  async execute(query: string, values: unknown[] = []): Promise<QueryResult> {
    return invoke<QueryResult>("db_execute", { query, values });
  }
}

let dbPromise: Promise<TimeDatabase> | null = null;

async function ensurePath(): Promise<string> {
  if (resolvedPath === null) resolvedPath = await invoke<string>("db_path");
  return resolvedPath;
}

export function getDb(): Promise<TimeDatabase> {
  if (!dbPromise) {
    dbPromise = ensurePath().then(() => new TimeDatabase());
  }
  return dbPromise;
}

// Native filesystem path of the live DB, for display and the backup filename.
// Empty until getDb() has resolved it — which always happens first, because app
// startup gates rendering on the meta load, and that opens the DB.
export function getDbPath(): string {
  return resolvedPath ?? "";
}
