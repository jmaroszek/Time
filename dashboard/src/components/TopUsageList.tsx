// Ranked apps or exact-host websites with quiet, direction-aware deltas vs the
// previous period. Category shows up once per row, in the dot beside the name.

import type { AppDelta, WebsiteDelta } from "../lib/metrics";
import type { BrowserDomainCoverage } from "../lib/domainCoverage";
import { fmtDuration } from "../lib/format";
import { uncategorizedMark } from "../lib/chartTheme";
import { useMeta } from "../state/meta";
import { CategoryDot, FloatingTooltip } from "./ui";
import { ExtensionLinks } from "./ExtensionLinks";

type RankedKind = "apps" | "websites";
type UsageItem = AppDelta | WebsiteDelta;

export default function TopUsageList({
  items,
  kind,
  comparisonDays,
  comparisonAvailable,
  hiddenCount,
  websiteCoverage,
}: {
  items: UsageItem[];
  kind: RankedKind;
  comparisonDays: number;
  comparisonAvailable: boolean;
  /** Rows of *this* kind held back by the minimum-time preference. */
  hiddenCount: number;
  websiteCoverage: BrowserDomainCoverage;
}) {
  const meta = useMeta();
  const { browserSet, minAppSecondsPerDay } = meta;
  const max = items[0]?.seconds ?? 1;
  const noun = kind === "apps" ? "app" : "site";
  // Both facts can be true of one website list, so the footers are a list and
  // the well gives back exactly the height they take. Fixed steps rather than a
  // computed style: the panel sits beside others of the same height, and that
  // alignment should not depend on arithmetic done at render time.
  const coverage =
    kind === "websites" && items.length > 0
      ? insightsWebsiteCoverageFooter(websiteCoverage)
      : null;
  const footers: { text: string; title?: string }[] = [];
  if (hiddenCount > 0) {
    footers.push({
      text: `${hiddenCount} ${hiddenCount === 1 ? noun : `${noun}s`} under ${fmtDuration(minAppSecondsPerDay)}/day hidden`,
    });
  }
  if (coverage) {
    footers.push({
      text: coverage,
      title: `${Math.round(websiteCoverage.missingFraction * 100)}% of browser time had no detected website`,
    });
  }
  const wellHeight = ["max-h-[250px]", "max-h-[231px]", "max-h-[212px]"][footers.length];

  if (items.length === 0) {
    return (
      <EmptyState
        kind={kind}
        websiteCoverage={websiteCoverage}
        hiddenCount={hiddenCount}
        minSecondsPerDay={minAppSecondsPerDay}
      />
    );
  }

  return (
    <div>
      <div
        className={`scroll-well flex flex-col gap-2.5 overflow-y-auto pr-2 sm:pr-4 ${wellHeight}`}
      >
        {items.map((item) => {
          const rawIdentity = "processes" in item
            ? item.processes.join(", ")
            : item.domain;
          const browserApp = "processes" in item
            && item.processes.some((process) => browserSet.has(process.toLowerCase()));
          return (
            <div
              key={item.key}
              className="top-app-row grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5 text-xs sm:flex sm:gap-y-0"
            >
              <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 truncate sm:w-36 sm:shrink-0">
                <CategoryDot
                  color={item.category?.color ?? uncategorizedMark(meta.theme)}
                  label={item.category?.name ?? "Uncategorized"}
                />
                <span className="truncate" title={rawIdentity}>
                  {item.name}
                </span>
              </span>
              <div className="col-span-3 row-start-2 h-2 min-w-0 overflow-hidden rounded-full bg-surface-2 sm:col-auto sm:row-auto sm:flex-1">
                {/* One accent fill for every bar: the dot already carries the
                    category, so length remains the bar's only encoding. */}
                <div
                  className="h-full rounded-full bg-accent-data"
                  style={{ width: `${Math.max((item.seconds / max) * 100, 1.5)}%` }}
                />
              </div>
              <span className="top-app-duration col-start-2 row-start-1 w-14 shrink-0 text-right text-ink-2">
                {fmtDuration(item.seconds)}
              </span>
              <DeltaBadge
                item={item}
                comparisonDays={comparisonDays}
                comparisonAvailable={comparisonAvailable}
                forceNeutral={browserApp}
              />
            </div>
          );
        })}
      </div>
      {footers.map((footer) => (
        <div key={footer.text} className="mt-2 flex h-[15px] items-center">
          <p className="translate-y-px truncate text-xs text-ink-3" title={footer.title}>
            {footer.text}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * How much of this range's browser time Time could name a site for.
 *
 * One fact, about coverage, shown only when coverage is worth mentioning. It
 * used to carry a second: a "· Changes unavailable" suffix reporting that the
 * per-row delta badges had no previous period to compare against. That is a
 * different subject wearing this sentence's clothes, and it read as a statement
 * about coverage to the one person who knew it was not. It also dragged this
 * footer onto screens that had not earned it — the old second clause fired even
 * at 98% coverage, so a healthy install got a line implying something was
 * missing. Missing delta badges announce themselves by being absent.
 */
export function insightsWebsiteCoverageFooter(
  coverage: BrowserDomainCoverage,
): string | null {
  if (coverage.totalSeconds < 60) return null;
  if (coverage.missingFraction < 0.1) return null;
  const identified = Math.round((1 - coverage.missingFraction) * 100);
  return `${identified}% of browser time identified`;
}

function EmptyState({
  kind,
  websiteCoverage,
  hiddenCount,
  minSecondsPerDay,
}: {
  kind: RankedKind;
  websiteCoverage: BrowserDomainCoverage;
  /** Rows the minimum-time preference held back. */
  hiddenCount: number;
  minSecondsPerDay: number;
}) {
  // Before either "nothing here" reading, because this list is not empty — it
  // was emptied, by a setting, and saying "no activity in range" about time
  // that was recorded is simply false. The websites branch got this worse than
  // the apps one: with browser time present but every site under the bar, it
  // fell through to advice about installing an extension the reader already
  // has, for a signal Time already had and was hiding on purpose.
  if (hiddenCount > 0) {
    const noun = kind === "apps" ? "app" : "site";
    return (
      <div className="flex h-[250px] flex-col items-center justify-center px-6 text-center">
        <p className="text-sm font-medium text-ink-2">
          Everything here is under the minimum
        </p>
        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-ink-3">
          {hiddenCount === 1 ? "The one " : `All ${hiddenCount} `}
          {hiddenCount === 1 ? noun : `${noun}s`} in this range
          {hiddenCount === 1 ? " averages" : " average"} less than{" "}
          {fmtDuration(minSecondsPerDay)}/day. Lower “Minimum app time” in Settings to see
          {hiddenCount === 1 ? " it" : " them"}.
        </p>
      </div>
    );
  }
  if (kind === "apps") {
    return <p className="py-8 text-center text-xs text-ink-3">No activity in range</p>;
  }
  if (websiteCoverage.totalSeconds === 0) {
    return <p className="py-8 text-center text-xs text-ink-3">No website activity in range</p>;
  }
  return (
    <div className="flex h-[250px] flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-medium text-ink-2">No website activity detected</p>
      <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-ink-3">
        Browser time in this range could not be split by website. Install the first-party
        Time Web Extension to add that signal.
      </p>
      <div className="mt-3">
        <ExtensionLinks />
      </div>
    </div>
  );
}

/** Where a percentage stops reading as a quantity and becomes a wall of digits. */
const MULTIPLE_THRESHOLD = 10;

const period = (days: number) => `the previous ${days} ${days === 1 ? "day" : "days"}`;

function DeltaBadge({
  item,
  comparisonDays,
  comparisonAvailable,
  forceNeutral,
}: {
  item: UsageItem;
  comparisonDays: number;
  comparisonAvailable: boolean;
  forceNeutral: boolean;
}) {
  if (!comparisonAvailable) return null;
  // Every badge is scoped to the comparison window, "new" included: it means
  // new to this period, not never seen before.
  const span = `${fmtDuration(item.previousSeconds)} → ${fmtDuration(item.seconds)}`;
  if (item.deltaFraction === null || item.baselineNegligible) {
    const tooltip =
      item.previousSeconds === 0
        ? `No time in ${period(comparisonDays)}`
        : `Barely used in ${period(comparisonDays)} (${span})`;
    return (
      <FloatingTooltip
        text={tooltip}
        className="top-app-change col-start-3 row-start-1 w-14 shrink-0 text-right text-xs font-normal tracking-tight text-ink-3 outline-none"
      >
        <span aria-hidden="true">new</span>
      </FloatingTooltip>
    );
  }
  const ratio = item.seconds / item.previousSeconds;
  const pct = Math.round(item.deltaFraction * 100);
  const asMultiple = ratio >= MULTIPLE_THRESHOLD;
  const text = asMultiple
    ? `${Math.round(ratio)}×`
    : `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%`;
  const cls =
    !forceNeutral && item.direction === "good"
      ? "text-good"
      : !forceNeutral && item.direction === "bad"
        ? "text-bad"
        : "text-ink-2";
  const tooltip = `${text} vs ${period(comparisonDays)}${asMultiple ? ` (${span})` : ""}${item.direction === "neutral" ? ", driven mostly by a single day" : ""}`;
  return (
    <FloatingTooltip
      text={tooltip}
      className={`top-app-change col-start-3 row-start-1 w-14 shrink-0 text-right text-xs font-normal tracking-tight tabular-nums outline-none ${cls}`}
    >
      <span aria-hidden="true">{text}</span>
    </FloatingTooltip>
  );
}
