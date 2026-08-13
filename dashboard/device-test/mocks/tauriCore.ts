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
/** A dev build and an installed build of one app, aliased to the same name so
 *  Insights lists them as a single row. Behind a fixture flag because the
 *  merged row changes every app total the default fixture's layout tests read. */
const mergedApps = fixtureParams.get("fixture") === "merged";
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
  ...(mergedApps
    ? [
        { process: "time.exe", title: "Time", domain: null },
        { process: "time-tracker.exe", title: "Time", domain: null },
      ]
    : []),
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
/**
 * A consolidatable set for the rule-combining notice: three subdomains under
 * one parent that all carry the same rule, plus one sibling with no rule for
 * the notice to name as absorbed.
 *
 * Deliberately not added to `processes`. Both the length and the start offset
 * of every session there are derived from that array's length, so appending to
 * it silently restates every app total the layout tests read. These carry small
 * totals for the same reason — the first row of the Activity table has to stay
 * Explorer, which two workflows depend on.
 */
const consolidationDomains = [
  "mail.corp.example",
  "docs.corp.example",
  "files.corp.example",
  "metrics.corp.example",
];
const consolidationSessions = consolidationDomains.flatMap((domain, domainIndex) =>
  Array.from({ length: 3 }, (_, visit) => {
    const start = now - (visit + 1) * day - (domainIndex + 1) * 900;
    return {
      id: 20_000 + domainIndex * 10 + visit,
      start,
      end: start + 700,
      process: "chrome.exe",
      title: `Weekly review — ${domain} — Google Chrome`,
      domain,
      isAfk: false,
      categoryOverrideId: null,
      isCorrected: false,
    };
  }),
);

/** The welcome panel exists only while the database holds no sessions at all,
 *  so seeing it at all requires a fixture that has none. Pair with
 *  `tracker=missing` for the variant that offers to start tracking. */
const firstRun = fixtureParams.get("fixture") === "firstrun";

let sessions = firstRun
  ? []
  : [
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
      ...consolidationSessions,
    ].sort((a, b) => a.start - b.start);

const categoryRows = [
  { id: 1, name: "Focus", color: "#6ba0da", is_productive: 1, is_neutral: 0, is_ignored: 0, sort_order: 1 },
  { id: 2, name: "Communication", color: "#a78bfa", is_productive: 0, is_neutral: 1, is_ignored: 0, sort_order: 2 },
  { id: 3, name: "System", color: "#94a3b8", is_productive: 0, is_neutral: 1, is_ignored: 0, sort_order: 3 },
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
  // The consolidatable set. Priority 1 is what addRule actually writes for a
  // Website rule — the three above predate that and keep their own numbers,
  // which still order correctly against each other.
  ...["mail.corp.example", "docs.corp.example", "files.corp.example"].map((pattern, index) => ({
    id: 4 + index,
    match_type: "domain",
    pattern,
    category_id: 1,
    priority: 1,
    scope_kind: "",
    scope_value: "",
    title_match_mode: "",
    title_anchor: "",
  })),
];

// "?browser=classified" models the reader the website-rule hint is written for:
// websites are being recorded, the browser itself has a category, and no
// website rule has ever been written. Dropping the seeded domain rules is the
// point rather than a convenience — a reader who has written one already knows
// websites classify separately, which is exactly when the hint should retire.
if (fixtureParams.get("browser") === "classified") {
  for (let index = ruleRows.length - 1; index >= 0; index--) {
    if (ruleRows[index].match_type === "domain") ruleRows.splice(index, 1);
  }
  ruleRows.push({
    id: ruleRows.length + 1,
    match_type: "process",
    pattern: "chrome.exe",
    category_id: 3,
    priority: 30,
    scope_kind: "",
    scope_value: "",
    title_match_mode: "",
    title_anchor: "",
  });
}

/** Ids for rules written during a session, past the seeded three. */
let nextRuleId = ruleRows.length + 1;

const settings: Record<string, string> = {
  schema_version: "4",
  privacy_onboarding_complete:
    fixtureParams.get("fixture") === "onboarding" ? "0" : "1",
  starter_categories_pending: fixtureParams.get("fixture") === "onboarding" ? "1" : "0",
  // The first-run fixture models the state "Not now" leaves behind: onboarding
  // is complete, but nothing was consented to and no startup entry was written.
  // That is the only state in which the welcome panel offers to start tracking.
  recording_consent: firstRun ? "0" : "1",
  record_window_titles: "1",
  launch_at_login: firstRun ? "0" : "1",
  show_tray_icon: "1",
  tracker_health_heartbeat:
    fixtureParams.get("tracker") === "missing" ? "0" : String(now - 5),
  // Fresh installs ship no goal (DEFAULT_USER_SETTINGS), which is the only
  // state where the Goal pace tile offers its own way into Settings.
  weekly_goal_hours: firstRun ? "0" : "20",
  idle_threshold_seconds: "300",
  heartbeat_seconds: "15",
  week_start: "Sunday",
  browser_processes: "chrome.exe,msedge.exe,firefox.exe",
  min_app_seconds_per_day: "0",
  activity_noise_filter: "none",
  activity_noise_max_seconds: "120",
  activity_noise_max_sessions: "1",
  // The default fixture is a long-lived database whose website rows predate
  // this run, so its one-time confirmation has already been seen. The signal
  // fixture alone models domains arriving for the first time. The classified
  // fixture also stays past the confirmation so it opens directly on the next
  // piece of guidance: how to classify those website rows.
  website_signal_seen: fixtureParams.get("browser") === "signal" ? "0" : "1",
  color_palette: "slate",
  productivity_style: "vivid",
  focus_chain_max_gap_seconds: "300",
  day_start_hour: "0",
  day_end_hour: "24",
  tracking_paused: "0",
  tracking_paused_until: "0",
  tracking_schedule_enabled: "0",
  tracking_schedule_days: "0,1,2,3,4",
  tracking_schedule_start_minute: "540",
  tracking_schedule_end_minute: "1020",
  process_aliases: JSON.stringify({
    "code.exe": "Visual Studio Code with an intentionally long friendly application name",
    ...(mergedApps ? { "time.exe": "Time", "time-tracker.exe": "Time" } : {}),
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
      result = "C:\\DeviceFixture\\Data\\database.db";
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
    // The single-visit editor, whose dialog could not be opened here at all
    // before: without these it reported a missing command and closed itself.
    case "fetch_session_correction": {
      const id = Number(args?.sessionId);
      const at = sessions.findIndex((session) => session.id === id);
      if (at === -1) throw new Error(`device fixture has no session ${id}`);
      const session = sessions[at];
      result = {
        sessionId: id,
        originalStart: session.start,
        originalEnd: session.end,
        start: session.start,
        end: session.end,
        process: session.process,
        title: session.title,
        domain: session.domain,
        categoryId: session.categoryOverrideId,
        isAfk: session.isAfk,
        isLive: false,
        isCorrected: session.isCorrected,
        // The real gap either side, so the dialog's bounds line is exercised
        // rather than always taking its "nothing recorded around this" branch.
        earliestStart: sessions[at - 1]?.end ?? null,
        latestEnd: sessions[at + 1]?.start ?? null,
      };
      break;
    }
    case "correct_session": {
      const request = (args?.request ?? {}) as {
        sessionId?: number;
        startSec?: number;
        endSec?: number;
        categoryId?: number | null;
      };
      const session = sessions.find((row) => row.id === Number(request.sessionId));
      if (!session) throw new Error("Session no longer exists");
      const movedTimes =
        (Number.isFinite(request.startSec) && Number(request.startSec) !== session.start)
        || (Number.isFinite(request.endSec) && Number(request.endSec) !== session.end);
      if (Number.isFinite(request.startSec)) session.start = Number(request.startSec);
      if (Number.isFinite(request.endSec)) session.end = Number(request.endSec);
      session.categoryOverrideId = request.categoryId ?? null;
      // Matches the real rule: a row with neither a category nor moved times is
      // deleted rather than stored, so the visit stops reporting as edited.
      session.isCorrected = session.categoryOverrideId !== null || movedTimes;
      result = { sessionId: session.id };
      break;
    }
    case "reset_session_correction": {
      const session = sessions.find((row) => row.id === Number(args?.sessionId));
      if (session) {
        session.categoryOverrideId = null;
        session.isCorrected = false;
      }
      result = 1;
      break;
    }
    // Overrides land on the same rows fetch_sessions reads, so a bulk
    // reclassification here actually reclassifies — which is the only way to
    // drive a control whose subject is a list that changes as you act on it.
    case "classify_sessions": {
      const request = (args?.request ?? {}) as {
        sessionIds?: number[];
        categoryId?: number | null;
      };
      const wanted = new Set(request.sessionIds ?? []);
      const categoryId = request.categoryId ?? null;
      const previous: { sessionId: number; categoryId: number | null }[] = [];
      let skippedCount = 0;
      for (const session of sessions) {
        if (!wanted.has(session.id)) continue;
        if (session.isAfk) {
          skippedCount += 1;
          continue;
        }
        if (session.categoryOverrideId === categoryId) continue;
        previous.push({ sessionId: session.id, categoryId: session.categoryOverrideId });
        session.categoryOverrideId = categoryId;
        session.isCorrected = categoryId !== null;
      }
      result = { changedCount: previous.length, skippedCount, previous };
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
    case "plugin:opener|open_url":
      result = undefined;
      break;
    // Chrome by default so the onboarding extension row renders its published
    // state. "?browser=firefox" exercises the not-yet-published branch,
    // "?browser=unknown" the fallback for a ProgId Time does not recognize, and
    // "?browser=edge" the store-gate branch — the only browsers that carry a
    // gate are Edge and Opera, so without one of them the extension row's last
    // sentence cannot be seen at all.
    case "default_browser_prog_id":
      result =
        fixtureParams.get("browser") === "firefox"
          ? "FirefoxURL-308046B0AF4A39CB"
          : fixtureParams.get("browser") === "unknown"
            ? "SomeOtherBrowserURL"
            : fixtureParams.get("browser") === "edge"
              ? "MSEdgeHTM"
              : "ChromeHTML";
      break;
    // Null is the ordinary answer and also the answer a failed check gives, so
    // the header control is absent in every fixture but the one that asks for
    // it. Installing resolves nowhere on purpose: the real command exits the
    // process, and a spec that clicks it wants the downloading state to hold.
    case "check_for_update":
      result =
        fixtureParams.get("update") === "available"
          ? { version: "0.2.0", notes: "Fixture release notes." }
          : null;
      break;
    case "install_update":
      return new Promise<T>(() => {});
    default:
      throw new Error(`Device fixture has no invoke response for command: ${command}`);
  }
  return result as T;
}
