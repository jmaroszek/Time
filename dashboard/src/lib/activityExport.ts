import {
  buildActivityIndex,
  queryActivityIndex,
  type ActivityQuery,
  type ActivitySource,
} from "./activity";
import { buildClassificationExplainer } from "./classify";
import { cleanDomainName, cleanProcessName } from "./format";
import { clipSessions } from "./metrics";

export type ActivityExportKind = "summary" | "sessions";

export interface ActivityExport {
  suggestedName: string;
  contents: string;
}

const CSV_DANGEROUS_PREFIX = /^[=+\-@]/;

function safeCell(value: string | number | boolean | null): string {
  let text = value == null ? "" : String(value);
  if (CSV_DANGEROUS_PREFIX.test(text.trimStart())) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function encodeCsv(headers: string[], rows: Array<Array<string | number | boolean | null>>): string {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(safeCell).join(",")).join("\r\n")}\r\n`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatLocalTimestamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function dateKey(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function buildActivityExport(
  kind: ActivityExportKind,
  source: ActivitySource,
  startSec: number,
  endSec: number,
  includeTitles = false,
): ActivityExport {
  if (kind === "summary") return buildSummaryExport(source, startSec, endSec);
  return buildSessionExport(source, startSec, endSec, includeTitles);
}

function buildSummaryExport(source: ActivitySource, startSec: number, endSec: number): ActivityExport {
  const query: ActivityQuery = {
    startSec,
    endSec,
    search: "",
    typeFilter: "all",
    classificationFilter: "all",
    sort: "name",
    direction: "asc",
    includeNoise: true,
    entityOffset: 0,
    entityLimit: Number.MAX_SAFE_INTEGER,
    windowOffset: 0,
    windowLimit: 0,
  };
  const entities = queryActivityIndex(buildActivityIndex(source), query).catalog.rows;
  const rows = entities.map((entity) => [
    entity.kind,
    entity.displayName,
    entity.key,
    Math.round(entity.seconds),
    entity.sessionCount,
    formatLocalTimestamp(entity.lastSeen),
    entity.status,
    [
      ...entity.categories.map((category) => `${category.name}: ${Math.round(category.seconds)}s`),
      ...(entity.uncategorizedSeconds > 0
        ? [`Uncategorized: ${Math.round(entity.uncategorizedSeconds)}s`]
        : []),
    ].join("; "),
  ]);
  return {
    suggestedName: `time-activity-summary-${dateKey(startSec)}_to_${dateKey(endSec - 1)}.csv`,
    contents: encodeCsv(
      ["entity_type", "display_name", "exact_identity", "total_seconds", "session_count", "last_seen_local", "classification_status", "category_breakdown"],
      rows,
    ),
  };
}

function buildSessionExport(
  source: ActivitySource,
  startSec: number,
  endSec: number,
  includeTitles: boolean,
): ActivityExport {
  const browserProcesses = new Set(source.browserProcesses.map((process) => process.toLowerCase()));
  const explain = buildClassificationExplainer(source.categories, source.rules, browserProcesses);
  const headers = [
    "session_id",
    "start_local",
    "end_local",
    "duration_seconds",
    "activity_type",
    "app",
    "website",
    ...(includeTitles ? ["window_title"] : []),
    "category",
    "classification_source",
    "corrected",
  ];
  const rows = clipSessions(source.sessions, startSec, endSec).map((session) => {
    const explanation = explain(session);
    const website = browserProcesses.has(session.process.toLowerCase()) && session.domain
      ? cleanDomainName(session.domain, source.aliases)
      : "";
    return [
      session.id,
      formatLocalTimestamp(session.start),
      formatLocalTimestamp(session.end),
      Math.round(session.end - session.start),
      session.isAfk ? "afk" : "active",
      cleanProcessName(session.process, source.aliases),
      website,
      ...(includeTitles ? [session.title] : []),
      explanation.category?.name ?? "",
      explanation.source,
      session.isCorrected ?? false,
    ];
  });
  return {
    suggestedName: `time-session-details-${dateKey(startSec)}_to_${dateKey(endSec - 1)}.csv`,
    contents: encodeCsv(headers, rows),
  };
}
