// Shared app state: categories, rules, settings, and the derived classifier.
// Loaded once at startup; refresh() re-reads after any Activity/Settings tab write.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { DEFAULT_BROWSER_PROCESSES, normalizeBrowserProcesses } from "../lib/browsers";
import {
  buildClassifier,
  memoizeClassifierById,
  type Category,
  type Classifier,
  type Rule,
} from "../lib/classify";
import { noisePolicyFromSettings, type NoisePolicy } from "../lib/noise";
import { checkSchemaVersion, fetchCategories, fetchRules, fetchSettings } from "../lib/queries";
import type { WeekStart } from "../lib/time";

export interface Meta {
  categories: Category[];
  rules: Rule[];
  settings: Record<string, string>;
  browserSet: Set<string>;
  aliases: Record<string, string>;
  classifier: Classifier;
  weekStart: WeekStart;
  weeklyGoalHours: number;
  /** Apps averaging less than this many seconds per active day are hidden from
   *  Insights' Top Apps. A rate, so the bar means the same thing on Today and
   *  on Year. */
  minAppSecondsPerDay: number;
  /** Max gap (s) between productive sessions that still counts as one focus streak. */
  focusChainMaxGapSeconds: number;
  /** Which one-off and system-utility rows the Activity Library folds away. */
  noisePolicy: NoisePolicy;
  /** Hour-of-day window shown on the Timeline and Hour-of-Day plots (0–24). */
  dayStartHour: number;
  dayEndHour: number;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const MetaContext = createContext<Meta | null>(null);

export function MetaProvider({ children }: { children: ReactNode }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Called for its throw, not its value: an unsupported schema must fail
      // here, before any read, so the caller shows the upgrade screen instead
      // of rendering against a database this release doesn't understand.
      await checkSchemaVersion();
      const [cats, rls, stgs] = await Promise.all([
        fetchCategories(),
        fetchRules(),
        fetchSettings(),
      ]);
      setCategories(cats);
      setRules(rls);
      setSettings(stgs);
      setError(null);
      setLoaded(true);
    } catch (e) {
      setError(String(e));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<Meta>(() => {
    const browserSet = new Set(
      normalizeBrowserProcesses(settings.browser_processes ?? DEFAULT_BROWSER_PROCESSES),
    );
    return {
      categories,
      rules,
      settings,
      browserSet,
      aliases: parseAliases(settings.process_aliases),
      classifier: memoizeClassifierById(buildClassifier(categories, rules, browserSet)),
      weekStart: resolveWeekStart(settings.week_start),
      weeklyGoalHours: finiteNonNegative(settings.weekly_goal_hours),
      minAppSecondsPerDay: Math.max(0, Number(settings.min_app_seconds_per_day) || 0),
      focusChainMaxGapSeconds: Math.max(0, Number(settings.focus_chain_max_gap_seconds) || 120),
      noisePolicy: noisePolicyFromSettings(settings),
      ...parseDayWindow(settings.day_start_hour, settings.day_end_hour),
      loaded,
      error,
      refresh,
    };
  }, [categories, rules, settings, loaded, error, refresh]);

  return <MetaContext.Provider value={value}>{children}</MetaContext.Provider>;
}

function finiteNonNegative(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function resolveWeekStart(raw: string | undefined): WeekStart {
  if (raw === "Monday" || raw === "Sunday") return raw;
  try {
    const region = new Intl.Locale(navigator.language).region ?? "";
    return new Set(["US", "CA", "PH", "JP", "TW"]).has(region) ? "Sunday" : "Monday";
  } catch {
    return "Monday";
  }
}

/** Parse the day-window hour settings, falling back to a full day (0–24) on any
 *  bad or inverted input. */
function parseDayWindow(
  startRaw: string | undefined,
  endRaw: string | undefined,
): { dayStartHour: number; dayEndHour: number } {
  const start = Number(startRaw);
  const end = Number(endRaw);
  const dayStartHour = Number.isFinite(start) ? Math.min(Math.max(Math.trunc(start), 0), 23) : 0;
  const dayEndHour = Number.isFinite(end) ? Math.min(Math.max(Math.trunc(end), 1), 24) : 24;
  if (dayEndHour <= dayStartHour) return { dayStartHour: 0, dayEndHour: 24 };
  return { dayStartHour, dayEndHour };
}

/** Parse the process_aliases setting (a JSON object) into a map, tolerating bad data. */
function parseAliases(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k.toLowerCase()] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function useMeta(): Meta {
  const ctx = useContext(MetaContext);
  if (!ctx) throw new Error("useMeta outside MetaProvider");
  return ctx;
}
