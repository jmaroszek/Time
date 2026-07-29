type InvokeArgs = Record<string, unknown> | undefined;

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
const sessions = [
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

const settings: Record<string, string> = {
  schema_version: "1",
  privacy_onboarding_complete:
    new URLSearchParams(window.location.search).get("fixture") === "onboarding" ? "0" : "1",
  starter_categories_pending: "0",
  recording_consent: "1",
  record_window_titles: "1",
  launch_at_login: "1",
  tracker_health_heartbeat: String(now - 5),
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
    return [{ last_hb: now - 5, live_n: sessions.length, total_n: sessions.length }];
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
  let result: unknown;
  switch (command) {
    case "db_path":
      result = "C:\\DeviceFixture\\time_log.db";
      break;
    case "db_select":
      result = selectFixture(args);
      break;
    case "fetch_sessions":
      result = sessionColumns(args);
      break;
    case "take_restore_notice":
      result = null;
      break;
    case "list_tracking_exclusions":
      result = [
        { kind: "app", pattern: "private-app.exe", createdTs: now - day },
        { kind: "website", pattern: "private.example", createdTs: now - day },
      ];
      break;
    case "list_database_backups":
      result = [
        {
          path: "C:\\DeviceFixture\\Backups\\time-2026-07-29.db",
          name: "time-2026-07-29.db",
          kind: "automatic",
          modifiedSec: now - 3_600,
          bytes: 2_400_000,
          schemaVersion: 1,
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
