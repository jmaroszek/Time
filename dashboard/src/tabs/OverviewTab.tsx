import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import ActivityCalendar from "../components/ActivityCalendar";
import HourlyActivityChart from "../components/HourlyActivityChart";
import MonthCalendarChart from "../components/MonthCalendarChart";
import RhythmChart from "../components/RhythmChart";
import TimelineChart from "../components/TimelineChart";
import TopUsageList from "../components/TopUsageList";
import ProductiveHoursChart from "../components/ProductiveHoursChart";
import { Card, MenuSelect, MetricCard, Spinner } from "../components/ui";
import { NO_HIDDEN_STACKS } from "../lib/chartTheme";
import { fmtDuration, fmtPct, fmtWholeHours } from "../lib/format";
import type { ActivityWindowTarget } from "../lib/activity";
import { TIMELINE_MAX_DAYS, type InsightsRequest } from "../lib/insights";
import {
  parentScope,
  scopeCandidates,
  scopeMatcher,
  summarizeScope,
  topScopeWindows,
  type ScopeContext,
} from "../lib/insightsScope";
import { goalProgress } from "../lib/categoryGoals";
import { productivityDataState } from "../lib/metrics";
import { hidesUtilities } from "../lib/noise";
import { allTimeRange, calendarDays, matchedPreviousRange, type Range } from "../lib/time";
import {
  MONTH_CALENDAR_MIN_DAYS,
  ACTIVITY_METRICS,
  activityComposition,
  ACTIVITY_METRIC_LABELS,
  type ActivityMetric,
  type ActivityStack,
} from "../lib/overview";
import type { PresetOrCustom } from "../components/DateRangePicker";
import { useMeta } from "../state/meta";
import { useInsightsModel } from "../state/useInsightsModel";
import { insightsFetchWindow, useInsightsWarmup } from "../state/useInsightsWarmup";
import {
  TOP_ITEMS_OPTIONS,
  type InsightsViewState,
  type RankedEntityKind,
} from "../state/useInsightsView";
import { useSessions } from "../state/useSessions";
import GoalsPopover from "./insights/GoalsPopover";
import { GoalMark } from "./insights/GoalMark";
import ScopePicker from "./insights/ScopePicker";
import {
  ScopeTiles,
  TopWindowList,
} from "./insights/ScopedInsights";

/** The Hours card's label when its split is the only one there is. */
const STACK_STATEMENTS: Record<ActivityStack, string> = {
  state: "By productivity",
  category: "By category",
  member: "By app and website",
  total: "",
};

const HOURS_CARD_TITLES = {
  daily: "Daily Hours",
  weekly: "Weekly Hours",
  monthly: "Monthly Hours",
  yearly: "Yearly Hours",
} as const;

export default function OverviewTab({
  range,
  preset,
  firstSessionSec,
  view,
  historyRevision,
  liveTick,
  onOpenSettings,
  onOpenWindow,
  scopePickerSlot,
}: {
  range: Range;
  preset: PresetOrCustom;
  firstSessionSec: number | null;
  view: InsightsViewState;
  /** Bumped when history changes underneath a mounted tab. Insights is normally
   *  unmounted when that happens — every mutation lives on Activity or
   *  Settings — but the first session of a fresh install arrives while this tab
   *  is the one on screen, and without this it would keep rendering the empty
   *  snapshot it fetched before the tracker had written anything. */
  historyRevision: number;
  /** Advances when the app returns to the foreground, so a tab left open picks
   *  up sessions recorded while the reader was elsewhere. Unlike historyRevision
   *  this keeps the cached rows and refetches only the live edge. */
  liveTick: number;
  /** Opens Settings with the named section flashed. */
  onOpenSettings: (section: string) => void;
  /** Opens one of a narrowed app's top windows in Activity. */
  onOpenWindow: (target: ActivityWindowTarget) => void;
  /** Where the header lends this tab room for its scope picker, beside the tabs. */
  scopePickerSlot: HTMLElement | null;
}) {
  const meta = useMeta();
  // The view controls (ranked identity/count, timeline resolution, aggregate view,
  // calendar metric, hours stacking) live in App so an in-session change to any
  // of them survives switching to another tab and back — this component unmounts
  // on a tab switch, App does not. `aggregateView` starts null so its default is
  // pinned the first time a long-enough range appears (see the effect below).
  const {
    topN,
    setTopN,
    rankedEntityKind,
    setRankedEntityKind,
    blockMinutes,
    setBlockMinutes,
    aggregateView,
    setAggregateView,
    metric,
    setMetric,
    stackBy,
    setStackBy,
    scope,
    setScope,
  } = view;
  // Hours-chart legend entries the reader switched off, tagged with the stacking
  // they were hidden under: another stacking has other names, so its legend
  // starts with everything shown.
  const [hiddenLegend, setHiddenLegend] = useState<{ stack: ActivityStack; names: ReadonlySet<string> }>(
    { stack: stackBy, names: NO_HIDDEN_STACKS },
  );
  const [goalsOpen, setGoalsOpen] = useState(false);
  const goalTileRef = useRef<HTMLDivElement>(null);

  const { startSec: fetchStart, endSec: fetchEnd } = insightsFetchWindow(range);
  const sessionData = useSessions(fetchStart, fetchEnd, historyRevision, liveTick);
  const analysisCutoffSec = useMemo(
    () => Math.min(Date.now() / 1000, range.end.getTime() / 1000),
    [range, historyRevision, liveTick, sessionData.sessions],
  );
  // A scope narrows the sessions before the model sees them, so every chart
  // below is the ordinary one, drawn from one subject's history. Nothing about
  // the model changes; only its input does.
  const scopeContext = useMemo<ScopeContext>(
    () => ({
      classifier: meta.classifier,
      aliases: meta.aliases,
      browserProcesses: meta.browserSet,
    }),
    [meta.classifier, meta.aliases, meta.browserSet],
  );
  const inScope = useMemo(
    () => (scope ? scopeMatcher(scope, scopeContext) : null),
    [scope, scopeContext],
  );
  const scopedSessions = useMemo(
    () => (inScope ? sessionData.sessions.filter(inScope) : sessionData.sessions),
    [inScope, sessionData.sessions],
  );
  // A category's time is all one category and one productivity state, and so
  // is an app's inside one, so neither stacking splits it. What does is the
  // apps and websites it was spent in.
  const memberBreakdown = scope !== null && (scope.kind === "category" || scope.within !== undefined);
  const request = useMemo<InsightsRequest | null>(() => {
    if (!sessionData.ready) return null;
    return {
      sessions: scopedSessions,
      range,
      categories: meta.categories,
      rules: meta.rules,
      browserProcesses: [...meta.browserSet].sort(),
      weekStart: meta.weekStart,
      weeklyGoalHours: meta.weeklyGoalHours,
      minAppSecondsPerDay: meta.minAppSecondsPerDay,
      aliases: meta.aliases,
      focusChainMaxGapSeconds: meta.focusChainMaxGapSeconds,
      hideUtilityApps: hidesUtilities(meta.noisePolicy.mode),
      dayStartHour: meta.dayStartHour,
      dayEndHour: meta.dayEndHour,
      labelMode: preset === "last7" ? "weekday" : "date",
      firstObservedSec: firstSessionSec,
      analysisCutoffSec,
      memberBreakdown,
    };
  }, [sessionData.ready, scopedSessions, range, meta, preset, firstSessionSec, analysisCutoffSec, memberBreakdown]);
  const analyzed = useInsightsModel(request);
  const model = analyzed.model;
  // Warming is for the unscoped presets a reader is likely to try next; a
  // scoped request would only spend the cache on one subject's variants.
  useInsightsWarmup(scope ? null : request, analyzed.current, firstSessionSec);

  // The scope's own figures read the *whole* session stream, not the filtered
  // one: whether a run continues depends on what happened between two of its
  // sessions, and the filtered list has had exactly that removed.
  const scopeSpans = useMemo(() => {
    const previous = matchedPreviousRange(range, new Date(analysisCutoffSec * 1000));
    const previousStartSec = previous.start.getTime() / 1000;
    const comparable = preset !== "alltime"
      && firstSessionSec !== null
      && previous.end > previous.start
      && previousStartSec >= firstSessionSec;
    return {
      range: {
        startSec: range.start.getTime() / 1000,
        endSec: Math.min(range.end.getTime() / 1000, analysisCutoffSec),
      },
      previous: comparable
        ? { startSec: previousStartSec, endSec: previous.end.getTime() / 1000 }
        : null,
      previousDays: calendarDays(previous),
    };
  }, [range, analysisCutoffSec, preset, firstSessionSec]);
  const scopeSummary = useMemo(() => {
    if (!scope || !inScope || !sessionData.ready) return null;
    const parent = parentScope(scope);
    return summarizeScope(
      sessionData.sessions,
      inScope,
      meta.classifier,
      scopeSpans.range,
      scopeSpans.previous,
      parent ? scopeMatcher(parent, scopeContext) : null,
    );
  }, [scope, inScope, sessionData.ready, sessionData.sessions, meta.classifier, scopeSpans, scopeContext]);
  const scopeWindows = useMemo(
    () => (inScope && scope?.kind !== "category" && sessionData.ready
      ? topScopeWindows(sessionData.sessions, inScope, scopeContext, scopeSpans.range, topN)
      : null),
    [inScope, scope, sessionData.ready, sessionData.sessions, scopeContext, scopeSpans, topN],
  );

  // Pin the aggregate view the first time the range is long enough to show one.
  // The calendar default is a starting point, not a rule: without this, any
  // change to the range's length (toggling Rolling on the same preset, say)
  // would silently move the picker off the view that's already on screen.
  const aggregateRangeDays = model && model.rangeDays > TIMELINE_MAX_DAYS ? model.rangeDays : null;
  useEffect(() => {
    if (aggregateRangeDays === null) return;
    setAggregateView((current) => current ?? "calendar");
  }, [aggregateRangeDays]);

  // A new subject is a new page: it starts at its heading, not wherever the row
  // that opened it happened to sit.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.closest(".app-viewport")?.scrollTo({ top: 0 });
  }, [scope]);

  if (!model) {
    const error = sessionData.error ?? analyzed.error;
    if (error) return <p className="copyable p-8 text-sm text-bad">DB error: {error}</p>;
    return <Spinner />;
  }

  const displayRange = model.range;
  const prev = model.previous;
  const granularity = model.granularity;
  const rangeDays = model.rangeDays;
  const isSingleDay = rangeDays === 1;
  const currentDays = model.historyDays.filter(
    (day) => day.date >= displayRange.start && day.date < displayRange.end,
  );
  // The timeline stops being readable past ~two weeks of rows. Beyond that the
  // rhythm grid (collapsed into a typical week) and the calendar (every date
  // laid out) are both useful; the calendar is the pinned default (set above)
  // and the card header lets you override it from then on.
  const middleView =
    rangeDays <= TIMELINE_MAX_DAYS ? "timeline" : (aggregateView ?? "calendar");
  // What the narrowed subject's time is made of in this range. Most apps and
  // sites sit wholly in one category, and a split of one part is no split.
  const composition = scope
    ? activityComposition(isSingleDay ? model.hourly ?? [] : currentDays)
    : null;
  // A scoped grid always measures the subject's time — filtering to
  // "productive" would draw an empty grid for anything that is not — and it is
  // always the blue "amount" ramp. The subject's productivity state is on the
  // scope chip; coloring every cell by it would repeat one fact per cell and
  // leave neutral subjects a hard-to-read gray.
  const shownMetric: ActivityMetric = composition ? "tracked" : metric;
  // Past ~14 months, day cells slice too thin; the calendar shows month cells
  // (years as rows) instead. Rhythm needs no such switch — it is always 7×24.
  const calendarByMonth = rangeDays >= MONTH_CALENDAR_MIN_DAYS;
  // A range can't reach back past the first recorded session, so until the
  // whole history is longer than the timeline's limit, every range — even All
  // time — lands on the timeline. Without saying so, picking "Last 30 days"
  // looked like the calendar and rhythm views did not exist.
  const historyIsShort = firstSessionSec !== null
    && calendarDays(allTimeRange(firstSessionSec)) <= TIMELINE_MAX_DAYS;

  const rankedItems = (rankedEntityKind === "apps" ? model.apps : model.websites).slice(0, topN);
  const updateError = sessionData.error ?? analyzed.error;
  const refreshing =
    !updateError &&
    (sessionData.refreshing || sessionData.loading || analyzed.refreshing || !analyzed.current);
  const { kpis, pace, hiddenAppCount, hiddenWebsiteCount } = model;
  // A bare "0s" is an assertion: it says the reader was productive for no time
  // at all. On a fresh install that is not what happened — nothing has been
  // measured yet, or nothing has been classified — and three confident zeros in
  // a row is what a broken app looks like. An em dash reports the absence
  // instead of measuring it. A genuine zero, where activity exists and is
  // classified but none of it is productive, is a real measurement and keeps
  // its number.
  const dataState = productivityDataState(kpis);
  const emptyReason = dataState === "ready" ? null : "—";
  const emptyNote = dataState === "nothing-recorded"
    ? "Nothing recorded yet"
    : "Nothing classified yet";
  const goalConfigured = meta.weeklyGoalHours > 0;
  // In the reader's themed colours, so the swatches match every other list.
  const categoryGoals = model.categoryGoals.flatMap(({ categoryId, progress }) => {
    const category = meta.categories.find((item) => item.id === categoryId);
    return category ? [{ category, progress }] : [];
  });
  const onTrackCount = categoryGoals.filter(({ progress }) => progress.onTrack).length;

  // The row's own identity, so the scope it opens totals exactly what the row
  // showed. Website keys are already the lowercased host. Inside a category the
  // rows were measured inside it, so the scope stays inside it too.
  const within = scope?.kind === "category"
    ? { categoryId: scope.categoryId, name: scope.name }
    : undefined;
  const selectRanked = (item: (typeof rankedItems)[number]) =>
    setScope("processes" in item
      ? { kind: "app", key: item.key, name: item.name, within }
      : { kind: "website", key: item.key, name: item.name, within });
  const heldIn = scope ? parentScope(scope) : null;
  // The ranked card is where a narrowed view was entered from, so it is where
  // the way back belongs — the chip beside the tabs reads as a filter, not as
  // the exit. One step at a time: an app opened inside a category returns to it.
  const scopeCategory = scope?.kind === "category"
    ? meta.categories.find((category) => category.id === scope.categoryId) ?? null
    : heldIn?.kind === "category"
      ? meta.categories.find((category) => category.id === heldIn.categoryId) ?? null
      : scopeSummary?.category ?? null;
  // Narrowed to a category with a goal: the scope's own total against it, the
  // same figure Time in range shows, prorated over the same range.
  const scopeGoalSpec = scope?.kind === "category" && !scopeCategory?.isIgnored
    ? scopeCategory?.goal
    : undefined;
  const scopeGoal = scopeGoalSpec && scopeSummary
    ? goalProgress(scopeSummary.seconds, range, scopeGoalSpec)
    : null;
  const pickerCandidates = () => scopeCandidates(sessionData.sessions, scopeContext, scopeSpans.range);
  const hoursTitle = isSingleDay ? "Hourly Activity" : HOURS_CARD_TITLES[granularity];
  // Narrowed, the Hours menu offers only the splits this subject's time has:
  // both, one (stated, not offered), or neither — plain gray bars. A category
  // splits by its apps and websites instead, unless it only has the one.
  const stackChoices: ActivityStack[] = composition && !memberBreakdown
    ? [
        ...(composition.states > 1 ? ["state" as const] : []),
        ...(composition.categories > 1 ? ["category" as const] : []),
      ]
    : ["state", "category"];
  const splitsByMember = memberBreakdown
    && (model.members ?? []).filter((member) => member.seconds > 0).length > 1;
  const shownStack: ActivityStack = splitsByMember
    ? "member"
    : memberBreakdown || stackChoices.length === 0
      ? "total"
      : stackChoices.includes(stackBy) ? stackBy : stackChoices[0];
  const hiddenStacks = hiddenLegend.stack === shownStack ? hiddenLegend.names : NO_HIDDEN_STACKS;
  const toggleStack = (name: string, visible: boolean) => {
    const names = new Set(hiddenStacks);
    if (visible) names.delete(name);
    else names.add(name);
    setHiddenLegend({ stack: shownStack, names });
  };
  const showAllStacks = () => setHiddenLegend({ stack: shownStack, names: NO_HIDDEN_STACKS });

  return (
    <div ref={rootRef} className="relative flex flex-col gap-4" aria-busy={refreshing}>
      {updateError && (
        <span
          className="pointer-events-none absolute right-1 -top-3 text-xs text-bad"
          title={updateError}
        >
          Update failed
        </span>
      )}
      {scopePickerSlot && createPortal(
        <ScopePicker
          scope={scope}
          category={scopeCategory}
          states={composition?.classifiedStates ?? []}
          getCandidates={pickerCandidates}
          onSelect={setScope}
        />,
        scopePickerSlot,
      )}
      {/* Four across at every width the window can actually take. The break to
          two rows used to sit at 1024px, twenty-four pixels above the 1000px
          minimum in tauri.conf — so the only way to see it was to drag the
          window to the very end of its travel, and the reward was a layout
          nobody had designed for. The stacked fallback is kept below a width
          the window cannot reach, so that lowering that minimum degrades the
          page instead of crushing it. Same reasoning on the pair below. */}
      {scope && scopeSummary ? (
        <ScopeTiles
          scope={scope}
          summary={scopeSummary}
          rangeDays={rangeDays}
          previousDays={scopeSpans.previousDays}
          goal={scopeGoal ?? undefined}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricCard
            label="Daily productive time"
            value={emptyReason ?? fmtDuration(kpis.prodSec / calendarDays(displayRange))}
            sub={emptyReason ? emptyNote : undefined}
            hint="Total productive time in this range divided by the number of days it spans."
          />
          <MetricCard
            label="Productive share"
            value={emptyReason ?? fmtPct(kpis.prodFraction)}
            sub={emptyReason ? emptyNote : undefined}
            hint="Share of tracked time spent in apps and sites you've marked productive."
          />
          <MetricCard
            label="Longest focus"
            value={emptyReason ?? fmtDuration(kpis.longestFocusSec)}
            sub={emptyReason ? emptyNote : undefined}
            hint="Longest continuous run of productive time. Short gaps don't break the chain."
          />
          {/* The target is not part of the figure. "40h / 35h" reads as a
              fraction — one number over another — when only the first is the
              measurement; the second is the bar it is being held to. Two
              typographic ranks say that, and a slash does not. */}
          <MetricCard
            label="Goal pace"
            cardRef={goalTileRef}
            open={categoryGoals.length > 0
              ? {
                  label: "Show every goal in this range",
                  expanded: goalsOpen,
                  onClick: () => setGoalsOpen((current) => !current),
                }
              : undefined}
            value={goalConfigured ? (emptyReason ?? (
              <span className="flex items-baseline gap-1.5 tabular-nums">
                {fmtWholeHours(pace.doneHours)}
                {/* tracking-normal resets the tile's -.02em, which is drawn for
                    24px and too tight at 12. */}
                <span className="flex items-center gap-1.5 text-xs font-normal tracking-normal text-ink-3">
                  {`of ${fmtWholeHours(pace.targetHours)}`}
                  {(pace.met || pace.missed) && <GoalMark missed={pace.missed} />}
                </span>
              </span>
            )) : categoryGoals.length > 0 ? (emptyReason ?? (
              /* Category goals alone: how many stand where they should, in the
                 tile's own two ranks. On track is a target reached or a limit
                 not passed. */
              <span className="flex items-baseline gap-1.5 tabular-nums">
                {onTrackCount}
                <span className="text-xs font-normal tracking-normal text-ink-3">
                  {`of ${categoryGoals.length} on track`}
                </span>
              </span>
            )) : (
              /* "Not set" named the state and left the reader to hunt for the
                 control. The tile is where the absence is noticed, so it is also
                 where the way out belongs. */
              <button
                type="button"
                onClick={() => onOpenSettings("Goals & time")}
                className="text-accent transition-colors hover:underline hover:decoration-accent/50 hover:underline-offset-4"
              >
                Set a goal
              </button>
            )}
            sub={(goalConfigured || categoryGoals.length > 0) && emptyReason
              ? emptyNote
              : goalConfigured && pace.roundedTieWhileBehind
                ? "<1h left"
                : undefined}
            hint={goalConfigured
              ? "Productive time in this range vs your weekly goal, prorated to the range's length."
              : categoryGoals.length > 0
                ? "Your weekly category goals in this range: targets reached and limits not passed."
                : "An optional weekly goal. Opens Settings, where you can set one."}
          />
        </div>
      )}

      {goalsOpen && !scope && categoryGoals.length > 0 && (
        <GoalsPopover
          anchorRef={goalTileRef}
          overall={goalConfigured && !emptyReason ? pace : null}
          goals={categoryGoals}
          onSelectCategory={(category) => {
            setGoalsOpen(false);
            setScope({ kind: "category", categoryId: category.id, name: category.name });
          }}
          onClose={() => setGoalsOpen(false)}
        />
      )}

      <Card
        surface="chart"
        // No subtitles: the metric and view menus beside the title already say
        // what the grid shows, and the Rhythm tooltip says its cells are averages.
        title={middleView === "timeline"
          ? "Timeline"
          : middleView === "rhythm"
            ? "Activity Rhythm"
            : "Activity Calendar"}
        right={middleView === "timeline" ? (
          <MenuSelect
            variant="quiet"
            label="Timeline resolution"
            value={String(blockMinutes)}
            onChange={(v) => setBlockMinutes(Number(v))}
            options={[
              // Everything below the rule is a bucket width; exact sessions
              // are the ungrouped truth the buckets approximate.
              { value: "0", label: "Exact sessions" },
              { value: "5", label: "5 min blocks", divider: true },
              { value: "10", label: "10 min blocks" },
              { value: "15", label: "15 min blocks" },
              { value: "30", label: "30 min blocks" },
            ]}
          />
        ) : (
          <span className="flex items-center gap-2">
            {!scope && (
              <MenuSelect
                variant="quiet"
                label="Metric"
                value={metric}
                onChange={(v) => setMetric(v as ActivityMetric)}
                options={ACTIVITY_METRICS.map((m) => ({
                  value: m,
                  label: ACTIVITY_METRIC_LABELS[m],
                }))}
              />
            )}
            <MenuSelect
              variant="quiet"
              label="Aggregate view"
              value={middleView}
              onChange={(v) => setAggregateView(v as "rhythm" | "calendar")}
              options={[
                { value: "calendar", label: "Calendar" },
                { value: "rhythm", label: "Rhythm" },
              ]}
            />
          </span>
        )}
      >
        {middleView === "timeline" ? (
          <>
            <TimelineChart
              sessions={model.timelineSessions ?? []}
              range={displayRange}
              classifier={meta.classifier}
              blockMinutes={blockMinutes}
            />
            {historyIsShort && (
              <p className="mt-3 text-xs text-ink-3">
                More views appear here after two weeks of tracking.
              </p>
            )}
          </>
        ) : middleView === "rhythm" ? (
          <RhythmChart
            summary={model.rhythm!}
            metric={shownMetric}
          />
        ) : calendarByMonth ? (
          <MonthCalendarChart
            summaries={model.monthly!}
            metric={shownMetric}
          />
        ) : (
          <ActivityCalendar
            summaries={currentDays}
            range={displayRange}
            metric={shownMetric}
          />
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {scope && scope.kind !== "category" && scopeWindows ? (
          <Card
            title="Top Windows"
            className="h-[345px]"
            right={
              <MenuSelect
                variant="quiet"
                label="How many windows to list"
                value={String(topN)}
                onChange={(v) => setTopN(Number(v))}
                options={TOP_ITEMS_OPTIONS.map((x) => ({ value: String(x), label: `Top ${x}` }))}
              />
            }
          >
            <div className="pt-2">
              <TopWindowList
                list={scopeWindows}
                scopeName={scope.name}
                scopeKey={scope.key}
                noun={scope.kind}
                titlesStored={meta.settings.record_window_titles === "1"}
                onStoreTitles={() => onOpenSettings("Privacy & recording")}
                onOpen={(window) => onOpenWindow({
                  entityId: window.entityId,
                  windowKey: window.activityKey,
                })}
              />
            </div>
          </Card>
        ) : (
          <Card
            title={rankedEntityKind === "apps" ? "Top Apps" : "Top Websites"}
            className="h-[345px]"
            right={
              <span className="flex items-center gap-2">
                <MenuSelect
                  variant="quiet"
                  label={`How many ${rankedEntityKind} to list`}
                  value={String(topN)}
                  onChange={(v) => setTopN(Number(v))}
                  options={TOP_ITEMS_OPTIONS.map((x) => ({ value: String(x), label: `Top ${x}` }))}
                />
                <MenuSelect
                  variant="quiet"
                  label="Ranked activity type"
                  value={rankedEntityKind}
                  onChange={(v) => setRankedEntityKind(v as RankedEntityKind)}
                  options={[
                    { value: "apps", label: "Apps" },
                    { value: "websites", label: "Websites" },
                  ]}
                />
              </span>
            }
          >
            <div className="pt-2">
              <TopUsageList
                items={rankedItems}
                kind={rankedEntityKind}
                comparisonDays={calendarDays(prev)}
                comparisonAvailable={preset !== "alltime" && (
                  rankedEntityKind === "apps"
                    ? model.appComparisonAvailable
                    : model.websiteComparisonAvailable
                )}
                hiddenCount={
                  rankedItems.length < topN
                    ? (rankedEntityKind === "apps" ? hiddenAppCount : hiddenWebsiteCount)
                    : 0
                }
                websiteCoverage={model.websiteCoverage}
                onSelect={selectRanked}
              />
            </div>
          </Card>
        )}
        <Card
          title={hoursTitle}
          className="h-[345px]"
          right={
            <span className="flex items-center gap-3">
              {hiddenStacks.size > 0 && (
                <button
                  type="button"
                  onClick={showAllStacks}
                  className="text-xs text-accent transition-colors hover:underline hover:decoration-accent/50 hover:underline-offset-4"
                >
                  Show all
                </button>
              )}
              {shownStack === "member" || shownStack === "total" || stackChoices.length === 1 ? (
                // Fixed, so stated rather than offered: the menu's other view
                // would not split this subject at all. Sized as the menu is, so
                // the title stays level with the neighbouring card's, and held
                // open even when there is nothing to state.
                <span className="flex min-h-[calc(1rem+0.75rem+2px)] items-center border border-transparent text-xs text-ink-3">
                  {STACK_STATEMENTS[shownStack]}
                </span>
              ) : (
                <MenuSelect
                  variant="quiet"
                  label="Stack bars by"
                  value={shownStack}
                  onChange={(v) => setStackBy(v as ActivityStack)}
                  options={[
                    { value: "state", label: "Productivity" },
                    { value: "category", label: "Categories" },
                  ]}
                />
              )}
            </span>
          }
        >
          <div className="pt-2">
            {isSingleDay ? (
              <HourlyActivityChart
                hours={model.hourly!}
                stackBy={shownStack}
                categories={meta.categories}
                members={model.members}
                hiddenStacks={hiddenStacks}
                onToggleStack={toggleStack}
              />
            ) : (
              <ProductiveHoursChart
                historyDays={model.historyDays}
                range={displayRange}
                labelMode={model.labelMode}
                granularity={granularity}
                weekStart={meta.weekStart}
                stackBy={shownStack}
                categories={meta.categories}
                members={model.members}
                averageMeasure={scope ? "tracked" : "productive"}
                goal={scopeGoalSpec}
                hiddenStacks={hiddenStacks}
                onToggleStack={toggleStack}
              />
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
