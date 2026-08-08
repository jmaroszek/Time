// Typed SQL access. The dashboard reads sessions and writes only
// categories/rules/settings (the tracker owns session writes).

import {
  DEFAULT_RULE_PRIORITY,
  normalizeRulePattern,
  type Category,
  type CategoryState,
  type MatchType,
  type Rule,
  type TitleRuleSpec,
} from "./classify";
import { DEFAULT_BROWSER_PROCESSES } from "./browsers";
import { normalizeTitleRuleSpec } from "./titleRules";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "./db";
import type { Session } from "./metrics";
import { assertSupportedSchemaVersion } from "./schema";
import { MAX_SESSION_SPAN_SEC } from "./sessionWindowCache";
import { invalidateHistory } from "./historyInvalidation";

interface SessionColumns {
  ids: number[];
  starts: number[];
  ends: number[];
  processes: string[];
  titles: string[];
  domains: Array<string | null>;
  isAfk: boolean[];
  categoryOverrideIds: Array<number | null>;
  isCorrected: boolean[];
}

/** Sessions overlapping [startSec, endSec), ordered by start. Clip before use. */
export async function fetchSessions(startSec: number, endSec: number): Promise<Session[]> {
  const columns = await invoke<SessionColumns>("fetch_sessions", {
    startSec,
    endSec,
    minStartSec: startSec - MAX_SESSION_SPAN_SEC,
  });
  const count = columns.ids.length;
  if (
    columns.starts.length !== count ||
    columns.ends.length !== count ||
    columns.processes.length !== count ||
    columns.titles.length !== count ||
    columns.domains.length !== count ||
    columns.isAfk.length !== count ||
    columns.categoryOverrideIds.length !== count ||
    columns.isCorrected.length !== count
  ) {
    throw new Error("Native session query returned mismatched column lengths");
  }
  return Array.from({ length: count }, (_, index) => ({
    id: columns.ids[index],
    start: columns.starts[index],
    end: columns.ends[index],
    process: columns.processes[index],
    title: columns.titles[index],
    domain: columns.domains[index],
    isAfk: columns.isAfk[index],
    categoryOverrideId: columns.categoryOverrideIds[index],
    isCorrected: columns.isCorrected[index],
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
  scope_kind: "" | TitleRuleSpec["scopeKind"];
  scope_value: string;
  title_match_mode: "" | TitleRuleSpec["titleMatchMode"];
  title_anchor: "" | TitleRuleSpec["titleAnchor"];
}

export async function fetchRules(): Promise<Rule[]> {
  const db = await getDb();
  const rows = await db.select<RuleRow[]>(
    "SELECT id, match_type, pattern, category_id, priority, scope_kind, scope_value," +
      " title_match_mode, title_anchor FROM rules ORDER BY priority ASC, id",
  );
  return rows.map((r) => ({
    id: r.id,
    matchType: r.match_type,
    pattern: r.pattern,
    categoryId: r.category_id,
    priority: r.priority,
    scopeKind: r.scope_kind || undefined,
    scopeValue: r.scope_value || undefined,
    titleMatchMode: r.title_match_mode || undefined,
    titleAnchor: r.title_anchor || undefined,
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

// Mirrors fresh-install values in tracker/db.py DEFAULT_SETTINGS and the Rust
// BOOTSTRAP_SQL. This intentionally selects only settings the global restore
// action owns; runtime and onboarding metadata must survive it.
export const DEFAULT_USER_SETTINGS: Readonly<Record<string, string>> = {
  weekly_goal_hours: "0",
  idle_threshold_seconds: "300",
  heartbeat_seconds: "15",
  week_start: "auto",
  browser_processes: DEFAULT_BROWSER_PROCESSES,
  min_app_seconds_per_day: "0",
  activity_noise_filter: "utilities",
  activity_noise_max_seconds: "120",
  activity_noise_max_sessions: "1",
  color_palette: "slate",
  productivity_style: "vivid",
  focus_chain_max_gap_seconds: "300",
  day_start_hour: "0",
  day_end_hour: "24",
  tracking_paused: "0",
  tracking_paused_until: "0",
  recording_consent: "0",
  record_window_titles: "0",
  launch_at_login: "0",
  show_tray_icon: "1",
  check_updates_automatically: "1",
};

/** Restore only settings represented on the Settings tab. Runtime metadata,
 *  onboarding completion, aliases, exclusions, categories, rules, and history
 *  are intentionally outside this single atomic upsert. */
export async function restoreDefaultSettings(): Promise<void> {
  const db = await getDb();
  const entries = Object.entries(DEFAULT_USER_SETTINGS);
  const placeholders = entries.map((_, index) => `($${index * 2 + 1},$${index * 2 + 2})`);
  await db.execute(
    `INSERT INTO settings (key,value) VALUES ${placeholders.join(",")}` +
      " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    entries.flat(),
  );
}

/** Persist the full process-alias map (lowercased process name -> display name). */
export async function saveProcessAliases(aliases: Record<string, string>): Promise<void> {
  await updateSetting("process_aliases", JSON.stringify(aliases));
}

// ---------------- rules / categories CRUD ----------------

export type AddRuleOptions = Partial<Omit<TitleRuleSpec, "pattern">> & {
  priority?: number;
};

function normalizedRuleWrite(
  matchType: MatchType,
  pattern: string,
  options: AddRuleOptions = {},
): {
  pattern: string;
  priority: number;
  windowFields: string[];
} {
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
  const titleSpec = normalizeTitleRuleSpec({
    pattern: pat,
    scopeKind: options.scopeKind ?? "any",
    scopeValue: options.scopeValue ?? "",
    titleMatchMode: options.titleMatchMode ?? "phrase",
    titleAnchor: options.titleAnchor ?? "any",
  });
  if (
    matchType === "title" &&
    (titleSpec.scopeKind === "process" || titleSpec.scopeKind === "domain") &&
    !titleSpec.scopeValue
  ) {
    const err = new Error(
      titleSpec.scopeKind === "process"
        ? "Choose the app this Window rule should match."
        : "Choose the website this Window rule should match.",
    );
    err.name = "ValidationError";
    throw err;
  }
  const windowFields = matchType === "title"
    ? [
        titleSpec.scopeKind,
        titleSpec.scopeValue,
        titleSpec.titleMatchMode,
        titleSpec.titleAnchor,
      ]
    : ["", "", "", ""];
  const priority = options.priority ??
    (matchType === "title" && titleSpec.scopeKind === "domain"
      ? 0
      : DEFAULT_RULE_PRIORITY[matchType]);
  return { pattern: pat, priority, windowFields };
}

export async function addRule(
  matchType: MatchType,
  pattern: string,
  categoryId: number,
  options: AddRuleOptions = {},
): Promise<void> {
  const db = await getDb();
  const normalized = normalizedRuleWrite(matchType, pattern, options);
  await db.execute(
    "INSERT INTO rules (match_type,pattern,category_id,priority,scope_kind,scope_value," +
      "title_match_mode,title_anchor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)" +
      " ON CONFLICT(match_type,pattern,scope_kind,scope_value,title_match_mode,title_anchor)" +
      " DO UPDATE SET" +
      " category_id=excluded.category_id, priority=excluded.priority",
    [
      matchType,
      normalized.pattern,
      categoryId,
      normalized.priority,
      ...normalized.windowFields,
    ],
  );
}

export async function updateRule(
  ruleId: number,
  matchType: MatchType,
  pattern: string,
  categoryId: number,
  options: AddRuleOptions = {},
): Promise<void> {
  const db = await getDb();
  const normalized = normalizedRuleWrite(matchType, pattern, options);
  await db.execute(
    "UPDATE rules SET match_type=$1, pattern=$2, category_id=$3, priority=$4," +
      " scope_kind=$5, scope_value=$6, title_match_mode=$7, title_anchor=$8" +
      " WHERE id=$9",
    [
      matchType,
      normalized.pattern,
      categoryId,
      normalized.priority,
      ...normalized.windowFields,
      ruleId,
    ],
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
  try {
    // The schema removes dependent rules and category-only session overrides
    // in this same statement.
    await db.execute("DELETE FROM categories WHERE id = $1", [categoryId]);
  } finally {
    invalidateHistory();
  }
}

// ---------------- history deletion ----------------
// The renderer describes a fixed scope; native commands own the SQL, live-edge
// protection, snapshot boundary, and secure compaction.

export type ActivityDeleteRequest =
  | {
      mode: "sessions";
      sessionIds: number[];
      snapshotMaxId?: number;
      previewProtectedSessionId?: number | null;
    }
  | {
      mode: "entity";
      entityKind: "app" | "website";
      entityKey: string;
      startSec: number;
      endSec: number;
      browserProcesses: string[];
      snapshotMaxId?: number;
      previewProtectedSessionId?: number | null;
    };

export interface ActivityDeletePreview {
  count: number;
  seconds: number;
  earliestStart: number | null;
  latestEnd: number | null;
  protectedCount: number;
  snapshotMaxId: number;
  protectedSessionId: number | null;
}

export interface ActivityDeleteResult {
  deletedCount: number;
  protectedCount: number;
}

export async function previewActivityDelete(
  request: ActivityDeleteRequest,
): Promise<ActivityDeletePreview> {
  return invoke<ActivityDeletePreview>("preview_activity_delete", { request });
}

export async function deleteActivity(
  request: ActivityDeleteRequest & { snapshotMaxId: number },
): Promise<ActivityDeleteResult> {
  try {
    return await invoke<ActivityDeleteResult>("delete_activity", { request });
  } finally {
    invalidateHistory();
  }
}

// ---------------- pre-capture exclusions ----------------

export type TrackingExclusionKind = "app" | "website";

export interface TrackingExclusion {
  kind: TrackingExclusionKind;
  pattern: string;
  createdTs: number;
}

export interface TrackingExclusionPreview {
  count: number;
  seconds: number;
  normalizedPattern: string;
}

export interface TrackingExclusionResult {
  normalizedPattern: string;
  deletedCount: number;
}

export async function listTrackingExclusions(): Promise<TrackingExclusion[]> {
  return invoke<TrackingExclusion[]>("list_tracking_exclusions");
}

export async function previewTrackingExclusion(
  kind: TrackingExclusionKind,
  pattern: string,
): Promise<TrackingExclusionPreview> {
  return invoke<TrackingExclusionPreview>("preview_tracking_exclusion", { kind, pattern });
}

export async function addTrackingExclusion(
  kind: TrackingExclusionKind,
  pattern: string,
  deleteHistory: boolean,
): Promise<TrackingExclusionResult> {
  try {
    return await invoke<TrackingExclusionResult>("add_tracking_exclusion", {
      kind,
      pattern,
      deleteHistory,
    });
  } finally {
    if (deleteHistory) invalidateHistory();
  }
}

export async function removeTrackingExclusion(
  kind: TrackingExclusionKind,
  pattern: string,
): Promise<number> {
  return invoke<number>("remove_tracking_exclusion", { kind, pattern });
}

// ---------------- session correction ----------------

export interface SessionCorrection {
  sessionId: number;
  originalStart: number;
  originalEnd: number;
  start: number;
  end: number;
  process: string;
  title: string;
  domain: string | null;
  categoryId: number | null;
  isAfk: boolean;
  isLive: boolean;
  isCorrected: boolean;
  /** The free gap around this session — the nearest neighbouring session's end
   *  before it and start after it. Corrected times may not overlap another
   *  recording, and a continuously-recording tracker leaves little slack, so
   *  the dialog states the limit instead of discovering it by rejection.
   *  Null means nothing is recorded on that side. */
  earliestStart: number | null;
  latestEnd: number | null;
}

export interface SessionCorrectionRequest {
  sessionId: number;
  startSec: number;
  endSec: number;
  categoryId: number | null;
}

export async function fetchSessionCorrection(sessionId: number): Promise<SessionCorrection> {
  return invoke<SessionCorrection>("fetch_session_correction", { sessionId });
}

export async function correctSession(
  request: SessionCorrectionRequest,
): Promise<SessionCorrection> {
  try {
    return await invoke<SessionCorrection>("correct_session", { request });
  } finally {
    invalidateHistory();
  }
}

/** One session's override as it stood before a batch replaced it. */
export interface SessionClassification {
  sessionId: number;
  categoryId: number | null;
}

export interface SessionClassificationResult {
  changedCount: number;
  /** AFK rows and the live session, which cannot be edited. */
  skippedCount: number;
  previous: SessionClassification[];
}

/**
 * Applies one category to many sessions, or clears theirs, without touching
 * their recorded times.
 *
 * A loop over correctSession would be one round trip and a full overlap scan
 * per visit, and would leave a failure part-way through as a half-applied
 * batch. This is one statement per five hundred, in one transaction.
 */
export async function classifySessions(
  sessionIds: number[],
  categoryId: number | null,
): Promise<SessionClassificationResult> {
  try {
    return await invoke<SessionClassificationResult>("classify_sessions", {
      request: { sessionIds, categoryId },
    });
  } finally {
    invalidateHistory();
  }
}

/** Puts back what a batch replaced. Sessions rarely came from more than one or
 *  two categories, so grouping them is a handful of calls rather than one per
 *  visit — and each session lands back on its own previous value. */
export async function restoreSessionClassifications(
  previous: SessionClassification[],
): Promise<void> {
  const byCategory = new Map<number | null, number[]>();
  for (const entry of previous) {
    const ids = byCategory.get(entry.categoryId);
    if (ids) ids.push(entry.sessionId);
    else byCategory.set(entry.categoryId, [entry.sessionId]);
  }
  for (const [categoryId, sessionIds] of byCategory) {
    await classifySessions(sessionIds, categoryId);
  }
}

export async function resetSessionCorrection(sessionId: number): Promise<number> {
  try {
    return await invoke<number>("reset_session_correction", { sessionId });
  } finally {
    invalidateHistory();
  }
}

export async function saveActivityExport(
  suggestedName: string,
  contents: string,
): Promise<string | null> {
  return invoke<string | null>("save_activity_export", { suggestedName, contents });
}

/** Sessions that ended before `cutoffSec` (unix seconds). */
export async function countSessionsOlderThan(cutoffSec: number): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM sessions s LEFT JOIN session_corrections c ON c.session_id=s.id" +
      " WHERE COALESCE(c.corrected_end_ts,s.end_ts) < $1",
    [Math.floor(cutoffSec)],
  );
  return rows[0].n;
}

export async function deleteHistoryBefore(cutoffSec: number): Promise<number> {
  try {
    return await invoke<number>("delete_history_before", { cutoffSec });
  } finally {
    invalidateHistory();
  }
}

// ---------------- status / maintenance ----------------

export interface TrackerStatus {
  lastHeartbeat: number | null; // unix seconds from the tracker's health signal
  liveSessionCount: number;
  totalSessionCount: number;
}

export async function fetchTrackerStatus(): Promise<TrackerStatus> {
  const db = await getDb();
  const rows = await db.select<{ last_hb: number | null; live_n: number; total_n: number }[]>(
    "SELECT CAST((SELECT value FROM settings WHERE key='tracker_health_heartbeat') AS REAL) AS last_hb," +
      " (SELECT COUNT(*) FROM sessions WHERE source='live') AS live_n," +
      " (SELECT COUNT(*) FROM sessions) AS total_n",
  );
  const r = rows[0];
  return { lastHeartbeat: r.last_hb, liveSessionCount: r.live_n, totalSessionCount: r.total_n };
}

/** Unix seconds of the earliest session start, or null when the DB is empty.
 *  Backs the "All time" range preset. */
export async function fetchEarliestSessionStart(): Promise<number | null> {
  const db = await getDb();
  const rows = await db.select<{ first_ts: number | null }[]>(
    "SELECT MIN(COALESCE(c.corrected_start_ts,s.start_ts)) AS first_ts FROM sessions s" +
      " LEFT JOIN session_corrections c ON c.session_id=s.id",
  );
  return rows[0]?.first_ts ?? null;
}

/** Snapshot the DB into its Backups folder and return the full path. */
export async function backupDatabase(): Promise<string> {
  return invoke<string>("backup_database");
}

export interface DatabaseBackup {
  path: string;
  name: string;
  kind: string;
  modifiedSec: number;
  bytes: number;
  schemaVersion: number | null;
  compatible: boolean;
  issue: string | null;
  legacyLocation: boolean;
}

export interface RestoreNotice {
  ok: boolean;
  message: string;
}

export async function listDatabaseBackups(): Promise<DatabaseBackup[]> {
  return invoke<DatabaseBackup[]>("list_database_backups");
}

export async function inspectDatabaseBackup(backupPath: string): Promise<DatabaseBackup> {
  return invoke<DatabaseBackup>("inspect_database_backup", { backupPath });
}

export async function chooseDatabaseBackupFile(): Promise<string | null> {
  return invoke<string | null>("choose_database_backup_file");
}

export async function restoreDatabase(backupPath: string): Promise<void> {
  await invoke("restore_database", { backupPath });
}

export async function takeRestoreNotice(): Promise<RestoreNotice | null> {
  return invoke<RestoreNotice | null>("take_restore_notice");
}

/** Securely erase all recorded sessions, checkpoint the WAL, and compact. */
export async function eraseAllHistory(): Promise<number> {
  try {
    return await invoke<number>("erase_history");
  } finally {
    // The native command deletes before checkpoint/compaction. Even if that
    // cleanup step fails, no renderer cache may keep showing erased rows.
    invalidateHistory();
  }
}
