// Typed SQL access. The dashboard reads sessions and writes only
// categories/rules/settings (the tracker owns session writes).

import type { Category, MatchType, Productivity, Rule } from "./classify";
import { getDb } from "./db";
import type { Session } from "./metrics";

interface SessionRow {
  id: number;
  start_ts: number;
  end_ts: number;
  process: string;
  title: string;
  domain: string | null;
  is_afk: number;
}

/** Sessions overlapping [startSec, endSec), ordered by start. Clip before use. */
export async function fetchSessions(startSec: number, endSec: number): Promise<Session[]> {
  const db = await getDb();
  const rows = await db.select<SessionRow[]>(
    "SELECT id, start_ts, end_ts, process, title, domain, is_afk FROM sessions" +
      " WHERE end_ts > $1 AND start_ts < $2 ORDER BY start_ts ASC",
    [startSec, endSec],
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

export async function fetchRules(): Promise<Rule[]> {
  const db = await getDb();
  const rows = await db.select<RuleRow[]>(
    "SELECT id, match_type, pattern, category_id, priority FROM rules ORDER BY priority DESC, id",
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

const DEFAULT_PRIORITY: Record<MatchType, number> = { domain: 300, title: 200, process: 100 };

export async function addRule(
  matchType: MatchType,
  pattern: string,
  categoryId: number,
  priority?: number,
): Promise<void> {
  const db = await getDb();
  const pat = pattern.toLowerCase().trim();
  await db.execute(
    "DELETE FROM rules WHERE match_type = $1 AND pattern = $2",
    [matchType, pat]
  );
  await db.execute(
    "INSERT INTO rules (match_type, pattern, category_id, priority) VALUES ($1, $2, $3, $4)",
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
  kind: Productivity,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO categories (name, color, is_productive, is_neutral, sort_order)" +
      " VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories))",
    [name.trim(), color, kind === "productive" ? 1 : 0, kind === "neutral" ? 1 : 0],
  );
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
  await db.execute("DELETE FROM rules WHERE category_id = $1", [categoryId]);
  await db.execute("DELETE FROM categories WHERE id = $1", [categoryId]);
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

export async function backupDatabase(): Promise<string> {
  const db = await getDb();
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  const { getDbPath } = await import("./db");
  const target = getDbPath().replace(/time_log\.db$/, `backup_manual_${stamp}.db`);
  await db.execute(`VACUUM INTO '${target}'`);
  return target;
}
