// Typed SQL access. The dashboard reads sessions and writes only
// categories/rules/settings (the tracker owns session writes).

import { normalizeRulePattern, type Category, type CategoryState, type MatchType, type Rule } from "./classify";
import { getDb } from "./db";
import type { Session } from "./metrics";
import { assertSupportedSchemaVersion } from "./schema";

interface SessionRow {
  id: number;
  start_ts: number;
  end_ts: number;
  process: string;
  title: string;
  domain: string | null;
  is_afk: number;
}

/** No single session legitimately spans more than this (the longest real rows
 *  are multi-day AFK spans); bounding start_ts lets idx_sessions_start skip
 *  all older history instead of scanning it (PERF-001). */
const MAX_SESSION_SPAN_SEC = 7 * 86_400;

/** Sessions overlapping [startSec, endSec), ordered by start. Clip before use. */
export async function fetchSessions(startSec: number, endSec: number): Promise<Session[]> {
  const db = await getDb();
  const rows = await db.select<SessionRow[]>(
    "SELECT id, start_ts, end_ts, process, title, domain, is_afk FROM sessions" +
      " WHERE end_ts > $1 AND start_ts < $2 AND start_ts > $3 ORDER BY start_ts ASC",
    [startSec, endSec, startSec - MAX_SESSION_SPAN_SEC],
  );
  return rows.map((r) => ({
    id: r.id,
    start: r.start_ts,
    end: r.end_ts,
    process: r.process,
    title: r.title,
    domain: r.domain,
    isAfk: r.is_afk !== 0,
  }));
}

interface CategoryRow {
  id: number;
  name: string;
  color: string;
  is_productive: number;
  is_neutral: number;
  is_ignored: number;
  sort_order: number | null;
}

export async function fetchCategories(): Promise<Category[]> {
  const db = await getDb();
  const rows = await db.select<CategoryRow[]>(
    "SELECT id, name, color, is_productive, is_neutral, is_ignored, sort_order FROM categories" +
      " ORDER BY sort_order, name",
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    isProductive: r.is_productive !== 0,
    isNeutral: r.is_neutral !== 0,
    isIgnored: r.is_ignored !== 0,
    sortOrder: r.sort_order,
  }));
}

interface RuleRow {
  id: number;
  match_type: MatchType;
  pattern: string;
  category_id: number;
  priority: number;
}

export async function fetchRules(schemaVersion: number | null): Promise<Rule[]> {
  const db = await getDb();
  if (schemaVersion === null) await ensureLegacyLowWinsRulePriorities(db);
  const rows = await db.select<RuleRow[]>(
    "SELECT id, match_type, pattern, category_id, priority FROM rules ORDER BY priority ASC, id",
  );
  return rows.map((r) => ({
    id: r.id,
    matchType: r.match_type,
    pattern: r.pattern,
    categoryId: r.category_id,
    priority: r.priority,
  }));
}

export async function fetchSettings(): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = await db.select<{ key: string; value: string }[]>(
    "SELECT key, value FROM settings",
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Read-only compatibility gate. The tracker is the sole migration/DDL owner. */
export async function checkSchemaVersion(): Promise<number | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key='schema_version'",
  );
  return assertSupportedSchemaVersion(rows[0]?.value);
}

export async function updateSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2)" +
      " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

/** Persist the full process-alias map (lowercased process name -> display name). */
export async function saveProcessAliases(aliases: Record<string, string>): Promise<void> {
  await updateSetting("process_aliases", JSON.stringify(aliases));
}

// ---------------- rules / categories CRUD ----------------

const DEFAULT_PRIORITY: Record<MatchType, number> = { domain: 1, title: 2, process: 3 };

export async function addRule(
  matchType: MatchType,
  pattern: string,
  categoryId: number,
  priority?: number,
): Promise<void> {
  const db = await getDb();
  const pat = normalizeRulePattern(matchType, pattern);
  if (!pat) {
    const err = new Error(
      matchType === "domain"
        ? `"${pattern.trim()}" doesn't contain a usable domain — enter one like example.com.`
        : "The rule pattern is empty.",
    );
    err.name = "ValidationError"; // explainDbError passes the message through untouched
    throw err;
  }
  await db.execute(
    "INSERT INTO rules (match_type, pattern, category_id, priority) VALUES ($1, $2, $3, $4)" +
      " ON CONFLICT(match_type, pattern) DO UPDATE SET" +
      " category_id=excluded.category_id, priority=excluded.priority",
    [matchType, pat, categoryId, priority ?? DEFAULT_PRIORITY[matchType]],
  );
}

export async function deleteRule(ruleId: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM rules WHERE id = $1", [ruleId]);
}

export async function addCategory(
  name: string,
  color: string,
  state: CategoryState,
): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO categories (name, color, is_productive, is_neutral, is_ignored, sort_order)" +
      " VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories))",
    [
      name.trim(),
      color,
      state === "productive" ? 1 : 0,
      state === "neutral" ? 1 : 0,
      state === "ignored" ? 1 : 0,
    ],
  );
  return Number(result.lastInsertId);
}

/** Legacy-only compatibility for unversioned DBs opened before the tracker.
 * Versioned migrations live exclusively in tracker/db.py. Each SQL call may
 * use a different pooled connection, so this old state machine stays
 * restart-safe until support for unversioned databases is removed. */
async function ensureLegacyLowWinsRulePriorities(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<void> {
  for (let pass = 0; pass < 5; pass++) {
    const marker = await db.select<{ value: string }[]>(
      "SELECT value FROM settings WHERE key='rule_priority_scheme'",
    );
    const state = marker[0]?.value;
    if (state === "low-wins-v1") return;

    if (!state) {
      const rows = await db.select<{ priority: number }[]>(
        "SELECT DISTINCT priority FROM rules ORDER BY priority",
      );
      const values = rows.map((row) => row.priority);
      const alreadyCompact = values.length === 0 || values.every((value) => value >= 1 && value <= 3);
      await db.execute(
        "INSERT OR IGNORE INTO settings (key,value) VALUES ('rule_priority_scheme',$1)",
        [alreadyCompact ? "low-wins-v1" : "ranking-v1"],
      );
      continue;
    }

    if (state === "ranking-v1") {
      // One statement atomically converts every still-positive legacy value to
      // a negative rank. Repeating it after a crash is a harmless no-op.
      await db.execute(
        "WITH ranked AS (" +
          " SELECT priority, ROW_NUMBER() OVER (ORDER BY priority DESC) AS rank" +
          " FROM (SELECT DISTINCT priority FROM rules WHERE priority > 0)" +
          ") UPDATE rules SET priority = -(SELECT rank FROM ranked" +
          " WHERE ranked.priority = rules.priority) WHERE priority > 0",
      );
      await db.execute(
        "UPDATE settings SET value='ranked-v1'" +
          " WHERE key='rule_priority_scheme' AND value='ranking-v1'",
      );
      continue;
    }

    if (state === "ranked-v1") {
      await db.execute("UPDATE rules SET priority = -priority WHERE priority < 0");
      await db.execute(
        "UPDATE settings SET value='low-wins-v1'" +
          " WHERE key='rule_priority_scheme' AND value='ranked-v1'",
      );
      continue;
    }

    // Recover safely from an unknown marker written by an interrupted preview.
    await db.execute(
      "UPDATE settings SET value='ranking-v1' WHERE key='rule_priority_scheme'",
    );
  }
  throw new Error("Rule priority migration did not converge");
}

export async function updateCategory(cat: Category): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE categories SET name = $1, color = $2, is_productive = $3, is_neutral = $4," +
      " is_ignored = $5 WHERE id = $6",
    [
      cat.name,
      cat.color,
      cat.isProductive ? 1 : 0,
      cat.isNeutral ? 1 : 0,
      cat.isIgnored ? 1 : 0,
      cat.id,
    ],
  );
}

export async function deleteCategory(categoryId: number): Promise<void> {
  const db = await getDb();
  // Schema v1's trigger removes dependent rules in this same statement.
  await db.execute("DELETE FROM categories WHERE id = $1", [categoryId]);
}

// ---------------- history deletion (PROD-003) ----------------
// The dashboard's only destructive surface. Callers confirm with the user
// (showing the count) before calling the delete variants.

const MATCH_SQL =
  " FROM sessions WHERE process LIKE $1 ESCAPE '\\'" +
  " OR title LIKE $1 ESCAPE '\\' OR IFNULL(domain,'') LIKE $1 ESCAPE '\\'";

function likePattern(text: string): string {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (m) => "\\" + m)}%`;
}

/** Sessions whose app, window title, or site contains `text` (case-insensitive). */
export async function countSessionsMatching(text: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n" + MATCH_SQL, [
    likePattern(text),
  ]);
  return rows[0].n;
}

export async function deleteSessionsMatching(text: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE" + MATCH_SQL, [likePattern(text)]);
}

/** Sessions that ended before `cutoffSec` (unix seconds). */
export async function countSessionsOlderThan(cutoffSec: number): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM sessions WHERE end_ts < $1",
    [Math.floor(cutoffSec)],
  );
  return rows[0].n;
}

export async function deleteSessionsOlderThan(cutoffSec: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM sessions WHERE end_ts < $1", [Math.floor(cutoffSec)]);
}

// ---------------- status / maintenance ----------------

export interface TrackerStatus {
  lastHeartbeat: number | null; // unix seconds of newest live session end
  liveSessionCount: number;
  totalSessionCount: number;
}

export async function fetchTrackerStatus(): Promise<TrackerStatus> {
  const db = await getDb();
  const rows = await db.select<{ last_hb: number | null; live_n: number; total_n: number }[]>(
    "SELECT (SELECT MAX(end_ts) FROM sessions WHERE source='live') AS last_hb," +
      " (SELECT COUNT(*) FROM sessions WHERE source='live') AS live_n," +
      " (SELECT COUNT(*) FROM sessions) AS total_n",
  );
  const r = rows[0];
  return { lastHeartbeat: r.last_hb, liveSessionCount: r.live_n, totalSessionCount: r.total_n };
}

/** Snapshot the DB next to the live file and return the backup's full path.
 *  Derives the directory from the DB path (works whatever the file is named)
 *  rather than assuming the production filename. */
export async function backupDatabase(): Promise<string> {
  const db = await getDb();
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  const { getDbPath } = await import("./db");
  const source = getDbPath();
  const sepIndex = Math.max(source.lastIndexOf("\\"), source.lastIndexOf("/"));
  const dir = sepIndex === -1 ? "" : source.slice(0, sepIndex + 1);
  const target = `${dir}backup_manual_${stamp}.db`;
  // VACUUM INTO can't take a bound parameter through the pool; escape quotes
  // so paths containing ' (legal in Windows usernames) don't break the SQL.
  await db.execute(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}
