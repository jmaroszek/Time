// Shared app state: categories, rules, settings, and the derived classifier.
// Loaded once at startup; refresh() re-reads after any Activity/Settings tab write.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
import {
  applyProductivity,
  paletteForTheme,
  resolvePalette,
  themedSwatch,
  type Palette,
} from "../lib/palettes";
import { checkSchemaVersion, fetchCategories, fetchRules, fetchSettings } from "../lib/queries";
import {
  resolveTheme,
  resolveThemePreference,
  SYSTEM_DARK_QUERY,
  type ThemeName,
  type ThemePreference,
} from "../lib/theme";
import type { WeekStart } from "../lib/time";

export interface Meta {
  /** Categories with their colours mapped for the active theme. Everything that
   *  *draws* a category should use these — the classifier below is built from
   *  them, so the charts and the activity worker get themed colours for free. */
  categories: Category[];
  /** The same categories with their colours exactly as stored. Anything that
   *  *writes* a category must start from these: `updateCategory` takes a whole
   *  row, so spreading a themed copy would persist the display value and the
   *  colour would stop round-tripping between themes. */
  storedCategories: Category[];
  rules: Rule[];
  settings: Record<string, string>;
  /** The selected colour palette (category swatches + productivity colours),
   *  resolved from the `color_palette` setting; defaults to Slate. */
  palette: Palette;
  /** The stored appearance preference, which may be "system". */
  themePreference: ThemePreference;
  /** Which theme is actually on screen. The CSS reads it off the <html> element
   *  (see the effect below); the canvas charts cannot, so they take it from here
   *  and pass it to chartChrome()/tooltipStyle() — ECharts has no access to CSS
   *  custom properties, which is the whole reason chartTheme.ts exists. */
  theme: ThemeName;
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
  /** Which rare-item and utility rows the Activity Library hides. */
  noisePolicy: NoisePolicy;
  /** Hour-of-day window shown on the Timeline and Hour-of-Day plots (0–24). */
  dayStartHour: number;
  dayEndHour: number;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const MetaContext = createContext<Meta | null>(null);

/** Identifies the refresh whose result is still allowed to commit. */
export interface MetaRefreshGeneration {
  begin: () => number;
  isCurrent: (generation: number) => boolean;
}

export function createMetaRefreshGeneration(): MetaRefreshGeneration {
  let newest = 0;
  return {
    begin: () => ++newest,
    isCurrent: (generation) => generation === newest,
  };
}

export function MetaProvider({ children }: { children: ReactNode }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef<MetaRefreshGeneration | null>(null);
  if (!refreshGeneration.current) refreshGeneration.current = createMetaRefreshGeneration();

  const refresh = useCallback(async () => {
    const generation = refreshGeneration.current!.begin();
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
      if (!refreshGeneration.current!.isCurrent(generation)) return;
      setCategories(cats);
      setRules(rls);
      setSettings(stgs);
      setError(null);
      setLoaded(true);
    } catch (e) {
      if (!refreshGeneration.current!.isCurrent(generation)) return;
      setError(String(e));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const systemPrefersDark = useSystemPrefersDark();
  const themePreference = resolveThemePreference(settings.theme);
  const theme = resolveTheme(themePreference, systemPrefersDark);

  // The CSS theme is selected by this attribute, so it has to be on the element
  // before anything paints in the new theme. Set on <html> rather than a wrapper
  // so the portalled menus, dialogs and tooltips are inside it too.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const value = useMemo<Meta>(() => {
    const browserSet = new Set(
      normalizeBrowserProcesses(settings.browser_processes ?? DEFAULT_BROWSER_PROCESSES),
    );
    const palette = paletteForTheme(
      applyProductivity(resolvePalette(settings.color_palette), settings.productivity_style),
      theme,
    );
    // Mapped once here rather than at each of the dozen places that draw a
    // category colour. The classifier is built from the mapped list, which is
    // what carries the theme into the charts and both workers.
    const themedCategories =
      theme === "light"
        ? categories.map((category) => ({
            ...category,
            color: themedSwatch(palette, theme, category.color),
          }))
        : categories;
    return {
      categories: themedCategories,
      storedCategories: categories,
      rules,
      settings,
      palette,
      themePreference,
      theme,
      browserSet,
      aliases: parseAliases(settings.process_aliases),
      classifier: memoizeClassifierById(buildClassifier(themedCategories, rules, browserSet)),
      weekStart: resolveWeekStart(settings.week_start),
      weeklyGoalHours: finiteNonNegative(settings.weekly_goal_hours),
      minAppSecondsPerDay: Math.max(0, Number(settings.min_app_seconds_per_day) || 0),
      focusChainMaxGapSeconds: Math.max(0, Number(settings.focus_chain_max_gap_seconds) || 300),
      noisePolicy: noisePolicyFromSettings(settings),
      ...parseDayWindow(settings.day_start_hour, settings.day_end_hour),
      loaded,
      error,
      refresh,
    };
  }, [categories, rules, settings, loaded, error, refresh, themePreference, theme]);

  return <MetaContext.Provider value={value}>{children}</MetaContext.Provider>;
}

/** Tracks the OS appearance, for the "Follow system" preference. Subscribed
 *  rather than read once: Windows can flip this while the app is open, on a
 *  schedule the app never sees. */
function useSystemPrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia?.(SYSTEM_DARK_QUERY).matches ?? true,
  );
  useEffect(() => {
    const query = window.matchMedia?.(SYSTEM_DARK_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener("change", onChange);
    setPrefersDark(query.matches);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return prefersDark;
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
