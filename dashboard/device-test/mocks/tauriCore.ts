type InvokeArgs = Record<string, unknown> | undefined;

interface InvocationRecord {
  command: string;
  args: InvokeArgs;
}

declare global {
  interface Window {
    __TIME_DEVICE_TEST__: {
      invocations: InvocationRecord[];
      settings: Record<string, string>;
      sessionCount: () => number;
    };
  }
}

const fixtureParams = new URLSearchParams(window.location.search);
const forcedFailure = fixtureParams.get("fail");
const now = Date.now() / 1000;
const day = 86_400;
const processes = [
  {
    process: "code.exe",
    title: "Time — responsive-layout-compatibility-assessment-and-remediation-plan.tsx — Visual Studio Code",
    domain: null,
  },
  {
    process: "chrome.exe",
    title: "Device compatibility dashboard review — docs.example.com — Google Chrome",
    domain: "docs.example.com",
  },
  {
    process: "slack.exe",
    title: "Product Design — Time — Slack",
    domain: null,
  },
  {
    process: "explorer.exe",
    title: "C:\\Users\\Example\\Documents\\An intentionally very long project folder name",
    domain: null,
  },
];

const recentSessions = Array.from({ length: 21 * processes.length }, (_, index) => {
  const dayIndex = Math.floor(index / processes.length);
  const item = processes[index % processes.length];
  const start = now - dayIndex * day - (index % processes.length + 2) * 3_600;
  return {
    id: index + 1,
    start,
    end: start + 2_400 + (index % processes.length) * 420,
    ...item,
    isAfk: false,
    categoryOverrideId: null,
    isCorrected: false,
  };
});
let sessions = [
  {
    id: 10_000,
    start: now - 500 * day,
    end: now - 500 * day + 3_600,
    process: "explorer.exe",
    title: "Archived project material from an older monitor configuration",
    domain: null,
    isAfk: false,
    categoryOverrideId: null,
    isCorrected: false,
  },
  ...recentSessions,
].sort((a, b) => a.start - b.start);

const categoryRows = [
  { id: 1, name: "Focus", color: "#6ba0da", is_productive: 1, is_neutral: 0, is_ignored: 0, sort_order: 1 },
  { id: 2, name: "Communication", color: "#a78bfa", is_productive: 0, is_neutral: 1, is_ignored: 0, sort_order: 2 },
  { id: 3, name: "Utilities", color: "#94a3b8", is_productive: 0, is_neutral: 1, is_ignored: 0, sort_order: 3 },
  { id: 4, name: "Ignored", color: "#5b616b", is_productive: 0, is_neutral: 0, is_ignored: 1, sort_order: 4 },
];

const ruleRows = [
  {
    id: 1,
    match_type: "process",
    pattern: "code.exe",
    category_id: 1,
    priority: 30,
    scope_kind: "",
    scope_value: "",
    title_match_mode: "",
    title_anchor: "",
  },
  {
    id: 2,
    match_type: "domain",
    pattern: "docs.example.com",
    category_id: 1,
    priority: 10,
    scope_kind: "",
    scope_value: "",
    title_match_mode: "",
    title_anchor: "",
  },
  {
    id: 3,
    match_type: "process",
    pattern: "slack.exe",
    category_id: 2,
    priority: 30,
    scope_kind: "",
    scope_value: "",
    title_match_mode: "",
    title_anchor: "",
  },
];

/** Ids for rules written during a session, past the seeded three. */
let nextRuleId = ruleRows.length + 1;

const settings: Record<string, string> = {
  schema_version: "4",
  privacy_onboarding_complete:
    fixtureParams.get("fixture") === "onboarding" ? "0" : "1",
  starter_categories_pending: fixtureParams.get("fixture") === "onboarding" ? "1" : "0",
  recording_consent: "1",
  record_window_titles: "1",
  launch_at_login: "1",
  show_tray_icon: "1",
  tracker_health_heartbeat:
    fixtureParams.get("tracker") === "missing" ? "0" : String(now - 5),
  weekly_goal_hours: "20",
  idle_threshold_seconds: "300",
  heartbeat_seconds: "15",
  week_start: "Sunday",
  browser_processes: "chrome.exe,msedge.exe,firefox.exe",
  min_app_seconds_per_day: "0",
  activity_noise_filter: "none",
  activity_noise_max_seconds: "120",
  activity_noise_max_sessions: "1",
  color_palette: "slate",
  productivity_style: "vivid",
  focus_chain_max_gap_seconds: "300",
  day_start_hour: "0",
  day_end_hour: "24",
  tracking_paused: "0",
  tracking_paused_until: "0",
  process_aliases: JSON.stringify({
    "code.exe": "Visual Studio Code with an intentionally long friendly application name",
  }),
  tracker_version: "0.1.0-device-fixture",
};

const trackingExclusions: Array<{
  kind: "app" | "website";
  pattern: string;
  createdTs: number;
}> = [
  { kind: "app", pattern: "private-app.exe", createdTs: now - day },
  { kind: "website", pattern: "private.example", createdTs: now - day },
];

const invocations: InvocationRecord[] = [];
window.__TIME_DEVICE_TEST__ = {
  invocations,
  settings,
  sessionCount: () => sessions.length,
};

function failWhenRequested(command: string): void {
  if (forcedFailure === command) {
    throw new Error(`device fixture forced ${command} failure`);
  }
}

function normalizedSql(args: InvokeArgs): string {
  return String(args?.query ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function selectFixture(args: InvokeArgs): unknown {
  const query = normalizedSql(args);
  if (query === "select value from settings where key='schema_version'") {
    return [{ value: settings.schema_version }];
  }
  if (query.includes(" from categories")) return categoryRows;
  if (query.includes(" from rules ")) return ruleRows;
  if (query === "select key, value from settings") {
    return Object.entries(settings).map(([key, value]) => ({ key, value }));
  }
  if (query.includes("as last_hb") && query.includes("as total_n")) {
    const heartbeat = Number(settings.tracker_health_heartbeat);
    return [{
      last_hb: Number.isFinite(heartbeat) ? heartbeat : null,
      live_n: sessions.length,
      total_n: sessions.length,
    }];
  }
  if (query.includes("select min(coalesce(c.corrected_start_ts,s.start_ts)) as first_ts")) {
    return [{ first_ts: sessions[0]?.start ?? null }];
  }
  if (query.includes("select count(*) as n from sessions")) return [{ n: 0 }];
  throw new Error(`Device fixture has no db_select response for: ${query}`);
}

function sessionColumns(args: InvokeArgs) {
  const startSec = Number(args?.startSec ?? Number.NEGATIVE_INFINITY);
  const endSec = Number(args?.endSec ?? Number.POSITIVE_INFINITY);
  const rows = sessions.filter((session) => session.end > startSec && session.start < endSec);
  return {
    ids: rows.map((row) => row.id),
    starts: rows.map((row) => row.start),
    ends: rows.map((row) => row.end),
    processes: rows.map((row) => row.process),
    titles: rows.map((row) => row.title),
    domains: rows.map((row) => row.domain),
    isAfk: rows.map((row) => row.isAfk),
    categoryOverrideIds: rows.map((row) => row.categoryOverrideId),
    isCorrected: rows.map((row) => row.isCorrected),
  };
}

export async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  invocations.push({ command, args: structuredClone(args) });
  failWhenRequested(command);
  let result: unknown;
  switch (command) {
    case "db_path":
      result = "C:\\DeviceFixture\\time_log.db";
      break;
    case "db_select":
      result = selectFixture(args);
      break;
    // Settings writes land in the same in-memory map db_select reads, so a
    // control that changes a setting can actually be driven here. Without it
    // every write threw and the fixture could only ever show defaults — which
    // hid the whole theme switch from this harness.
    case "db_execute": {
      const query = normalizedSql(args);
      const values = (args?.values ?? []) as unknown[];
      if (query.startsWith("insert into settings") && typeof values[0] === "string") {
        settings[values[0]] = String(values[1] ?? "");
        result = { rowsAffected: 1, lastInsertId: 0 };
        break;
      }
      // Rule writes land in the same array db_select reads, so classifying
      // something here actually reclassifies it — which is the only way to
      // drive the Unclassified section, whose whole subject is a list that
      // shrinks as you act on it. Without this the fixture could show the
      // section but never a single assignment, undo, or backfill.
      if (query.startsWith("insert into rules")) {
        const [matchType, pattern, categoryId, priority, scopeKind, scopeValue, titleMatchMode, titleAnchor] =
          values as [string, string, number, number, string, string, string, string];
        // The real table's ON CONFLICT key, so a repeated assignment moves the
        // existing rule here too rather than growing a duplicate.
        const conflict = ruleRows.find(
          (rule) =>
            rule.match_type === matchType
            && rule.pattern === pattern
            && rule.scope_kind === scopeKind
            && rule.scope_value === scopeValue
            && rule.title_match_mode === titleMatchMode
            && rule.title_anchor === titleAnchor,
        );
        if (conflict) {
          conflict.category_id = categoryId;
          conflict.priority = priority;
          result = { rowsAffected: 1, lastInsertId: conflict.id };
        } else {
          const id = nextRuleId++;
          ruleRows.push({
            id,
            match_type: matchType,
            pattern,
            category_id: categoryId,
            priority,
            scope_kind: scopeKind,
            scope_value: scopeValue,
            title_match_mode: titleMatchMode,
            title_anchor: titleAnchor,
          });
          result = { rowsAffected: 1, lastInsertId: id };
        }
        break;
      }
      if (query.startsWith("delete from rules")) {
        const at = ruleRows.findIndex((rule) => rule.id === Number(values[0]));
        if (at !== -1) ruleRows.splice(at, 1);
        result = { rowsAffected: at === -1 ? 0 : 1, lastInsertId: 0 };
        break;
      }
      throw new Error(`Device fixture has no db_execute response for: ${query}`);
    }
    case "fetch_sessions":
      result = sessionColumns(args);
      break;
    case "take_restore_notice":
      result = null;
      break;
    case "set_launch_at_login":
      result = null;
      break;
    case "start_tracker":
      settings.tracker_health_heartbeat = String(Date.now() / 1000);
      result = null;
      break;
    case "stop_tracker":
    case "restore_database":
      result = null;
      break;
    case "backup_database":
      result = "C:\\DeviceFixture\\Backups\\backup_manual_fixed.db";
      break;
    case "erase_history": {
      const count = sessions.length;
      sessions = [];
      result = count;
      break;
    }
    case "preview_activity_delete": {
      const selected = sessions.filter((session) => session.process === "explorer.exe");
      result = {
        count: selected.length,
        seconds: selected.reduce((total, session) => total + session.end - session.start, 0),
        earliestStart: selected[0]?.start ?? null,
        latestEnd: selected.at(-1)?.end ?? null,
        protectedCount: 0,
        snapshotMaxId: Math.max(0, ...sessions.map((session) => session.id)),
        protectedSessionId: null,
      };
      break;
    }
    case "delete_activity": {
      const before = sessions.length;
      sessions = sessions.filter((session) => session.process !== "explorer.exe");
      result = { deletedCount: before - sessions.length, protectedCount: 0 };
      break;
    }
    case "list_tracking_exclusions":
      result = trackingExclusions;
      break;
    case "preview_tracking_exclusion": {
      const kind = String(args?.kind ?? "");
      const pattern = String(args?.pattern ?? "").trim().toLowerCase();
      const matches = sessions.filter((session) =>
        kind === "app" ? session.process.toLowerCase() === pattern : session.domain === pattern
      );
      result = {
        count: matches.length,
        seconds: matches.reduce((total, session) => total + session.end - session.start, 0),
        normalizedPattern: pattern,
      };
      break;
    }
    case "add_tracking_exclusion": {
      const kind = String(args?.kind ?? "") as "app" | "website";
      const pattern = String(args?.pattern ?? "").trim().toLowerCase();
      const deleteHistory = args?.deleteHistory === true;
      const before = sessions.length;
      if (deleteHistory) {
        sessions = sessions.filter((session) =>
          kind === "app" ? session.process.toLowerCase() !== pattern : session.domain !== pattern
        );
      }
      if (!trackingExclusions.some((item) => item.kind === kind && item.pattern === pattern)) {
        trackingExclusions.push({ kind, pattern, createdTs: now });
      }
      result = { normalizedPattern: pattern, deletedCount: before - sessions.length };
      break;
    }
    case "remove_tracking_exclusion": {
      const kind = String(args?.kind ?? "");
      const pattern = String(args?.pattern ?? "").trim().toLowerCase();
      const index = trackingExclusions.findIndex(
        (item) => item.kind === kind && item.pattern === pattern,
      );
      if (index >= 0) trackingExclusions.splice(index, 1);
      result = index >= 0 ? 1 : 0;
      break;
    }
    case "list_database_backups":
      result = [
        {
          path: "C:\\DeviceFixture\\Backups\\time-2026-07-29.db",
          name: "time-2026-07-29.db",
          kind: "automatic",
          modifiedSec: now - 3_600,
          bytes: 2_400_000,
          schemaVersion: 4,
          compatible: true,
          issue: null,
          legacyLocation: false,
        },
      ];
      break;
    default:
      throw new Error(`Device fixture has no invoke response for command: ${command}`);
  }
  return result as T;
}
