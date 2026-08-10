import type {
  ActivityEntitySummary,
  ActivitySessionRow,
  ActivitySortDirection,
  ActivityTitleGroup,
} from "./activity";
import type { MatchType, TitleRuleSpec } from "./classify";
import { fmtDuration } from "./format";
import type { SessionCorrection } from "./queries";
import { containsVersion, normalizeWindowTitle, splitWindowTitle } from "./titleRules";

const RULE_LABELS: Record<MatchType, string> = {
  domain: "Website",
  title: "Window",
  process: "App",
};

/** A broad scope and substring comparison are separate decisions. */
export function showBroadMatchWarning(
  spec: Pick<TitleRuleSpec, "titleMatchMode" | "scopeKind">,
): boolean {
  return (
    spec.titleMatchMode === "contains"
    && spec.scopeKind !== "process"
    && spec.scopeKind !== "domain"
  );
}

export function formatDateTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatShortDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateSpan(startSec: number, endSec: number): string {
  const start = new Date(startSec * 1000);
  const end = new Date(endSec * 1000);
  const sameYear = start.getFullYear() === end.getFullYear();
  if (sameYear && start.getMonth() === end.getMonth() && start.getDate() === end.getDate()) {
    return formatShortDate(endSec);
  }
  const from = sameYear
    ? start.toLocaleDateString([], { month: "short", day: "numeric" })
    : formatShortDate(startSec);
  return `${from} – ${formatShortDate(endSec)}`;
}

function calendarDaysAgo(then: Date, now: Date): number {
  const thenMidnight = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((nowMidnight.getTime() - thenMidnight.getTime()) / 86_400_000);
}

export function formatLastSeen(seconds: number, now = new Date()): string {
  const seen = new Date(seconds * 1000);
  const days = calendarDaysAgo(seen, now);
  if (days <= 0) {
    return `Today, ${seen.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  if (days === 1) return "Yesterday";
  return formatShortDate(seconds);
}

export function groupVisitsByDay<T extends { start: number }>(
  visits: T[],
): { key: number; visits: T[] }[] {
  const days: { key: number; visits: T[] }[] = [];
  for (const visit of visits) {
    const at = new Date(visit.start * 1000);
    const key = at.getFullYear() * 10000 + (at.getMonth() + 1) * 100 + at.getDate();
    const open = days[days.length - 1];
    if (open && open.key === key) open.visits.push(visit);
    else days.push({ key, visits: [visit] });
  }
  return days;
}

export function formatVisitDay(seconds: number, now = new Date()): string {
  const days = calendarDaysAgo(new Date(seconds * 1000), now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return formatShortDate(seconds);
}

export function visitEditLabel(
  session: Pick<ActivitySessionRow, "isCorrected" | "classificationSource">,
): string | null {
  if (session.classificationSource === "session_override") return "Reclassified";
  return session.isCorrected ? "Time edited" : null;
}

const MATCH_LEAD = 30;

export function titleMatchParts(title: string, search: string): {
  elided: boolean;
  head: string;
  hit: string;
  tail: string;
} | null {
  if (!title || !search) return null;
  const at = title.toLowerCase().indexOf(search.toLowerCase());
  if (at < 0) return null;
  const from = Math.max(0, at - MATCH_LEAD);
  return {
    elided: from > 0,
    head: title.slice(from, at),
    hit: title.slice(at, at + search.length),
    tail: title.slice(at + search.length),
  };
}

export function windowRowCategory(
  group: Pick<ActivityTitleGroup, "mixed" | "categoryId" | "categoryName">,
  baselineCategoryId: number | null,
): string | null {
  if (group.mixed) return "Mixed";
  if (baselineCategoryId !== null && group.categoryId === baselineCategoryId) return null;
  return group.categoryName ?? "Uncategorized";
}

export function describeRuleSource(matchType: MatchType, pattern: string, entityKey: string): string {
  const kind = `${RULE_LABELS[matchType]} rule`;
  return pattern.toLowerCase() === entityKey.toLowerCase() ? kind : `${kind} · ${pattern}`;
}

export function entityClassification(entity: ActivityEntitySummary): {
  label: string;
  detail: string;
} {
  const kind = entity.kind === "website" ? "website" : "app";
  if (entity.status === "uncategorized") {
    return { label: "Uncategorized", detail: `No rule matches this ${kind}.` };
  }
  if (entity.status === "ignored") {
    return { label: "Ignored", detail: "Recorded, but left out of every Insights total." };
  }
  if (entity.status === "partial") {
    return {
      label: "Mixed",
      detail: `${fmtDuration(entity.uncategorizedSeconds)} of this is still uncategorized.`,
    };
  }
  if (entity.status === "mixed") {
    return {
      label: `Mixed · ${entity.categories.length} categories`,
      detail: entity.rules.length > 1
        ? `${entity.rules.length} rules decide it across its visits.`
        : "Its visits resolve to different categories.",
    };
  }
  const label = entity.categories[0]?.name ?? "Uncategorized";
  const ruleSeconds = entity.rules.reduce((total, rule) => total + rule.seconds, 0);
  const corrected = entity.seconds - ruleSeconds > 1;
  if (entity.rules.length === 0) {
    return { label, detail: "Set by manual corrections — no rule matches." };
  }
  const source = entity.rules.length === 1
    ? describeRuleSource(entity.rules[0].matchType, entity.rules[0].pattern, entity.key)
    : `${entity.rules.length} rules, led by ${entity.rules[0].pattern}`;
  return { label, detail: corrected ? `${source}, plus manual corrections` : source };
}

export function describeCorrectionWindow(
  session: Pick<SessionCorrection, "start" | "end" | "earliestStart" | "latestEnd">,
): string {
  const { earliestStart, latestEnd } = session;
  const clock = (seconds: number) =>
    new Date(seconds * 1000).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  if (earliestStart == null && latestEnd == null) {
    return "Nothing else is recorded around this visit, so its times can move freely.";
  }
  if (earliestStart === session.start && latestEnd === session.end) {
    return "You can shorten this visit but not extend it — the visits before and after leave no gap.";
  }
  if (earliestStart == null) {
    return `Nothing is recorded before this visit, and it can end as late as ${clock(latestEnd!)}.`;
  }
  if (latestEnd == null) {
    return `This visit can start as early as ${clock(earliestStart)}, and nothing is recorded after it.`;
  }
  return `This visit can run from ${clock(earliestStart)} to ${clock(latestEnd)} at most, before it would overlap another.`;
}

export function localInputValue(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function countNoun(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function formatSharePercent(seconds: number, totalSeconds: number): string {
  const share = totalSeconds > 0 ? seconds / totalSeconds : 0;
  return `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
}

export function updateSortState<T>(
  next: T,
  current: T,
  direction: ActivitySortDirection,
  ascendingField: T,
  setSort: (sort: T) => void,
  setDirection: (direction: ActivitySortDirection) => void,
): void {
  if (next === current) setDirection(direction === "asc" ? "desc" : "asc");
  else {
    setSort(next);
    setDirection(next === ascendingField ? "asc" : "desc");
  }
}

export function entityRowDomId(entityId: string): string {
  return `activity-row-${entityId}`;
}

export function entityRowTriggerDomId(entityId: string): string {
  return `${entityRowDomId(entityId)}-trigger`;
}

export function windowGroupClassification(
  group: ActivityTitleGroup,
): { label: string; detail: string } {
  if (group.allIgnored) {
    return {
      label: "Ignored",
      detail: group.mixed
        ? "Visits use different ignored categories"
        : group.categoryName ?? "Ignored",
    };
  }
  if (group.mixed) return { label: "Mixed", detail: "Visits use different classifications" };
  const label = group.categoryName ?? "Uncategorized";
  if (group.provenanceMixed) return { label, detail: "Varies across visits" };
  if (group.classificationSource === "session_override") {
    return { label, detail: "Manual correction" };
  }
  if (group.winningRuleType && group.winningRulePattern) {
    return {
      label,
      detail: describeRuleSource(
        group.winningRuleType,
        group.winningRulePattern,
        group.entityKey,
      ),
    };
  }
  return { label, detail: "No matching rule" };
}

export function defaultRulePattern(title: string): string {
  const durable = splitWindowTitle(title)
    .filter((part) => part.length >= 3 && !containsVersion(part));
  return durable.reduce(
    (best, part) => part.length >= best.length ? part : best,
    "",
  ) || normalizeWindowTitle(title);
}
