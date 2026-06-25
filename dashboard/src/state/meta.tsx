// Shared app state: categories, rules, settings, and the derived classifier.
// Loaded once at startup; refresh() re-reads after any Apps/Settings tab write.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { buildClassifier, type Category, type Classifier, type Rule } from "../lib/classify";
import { fetchCategories, fetchRules, fetchSettings } from "../lib/queries";
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
  defaultTopN: number;
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
      (settings.browser_processes ?? "chrome.exe,thorium.exe")
        .split(",")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean),
    );
    return {
      categories,
      rules,
      settings,
      browserSet,
      aliases: parseAliases(settings.process_aliases),
      classifier: buildClassifier(categories, rules, browserSet),
      weekStart: settings.week_start === "Monday" ? "Monday" : "Sunday",
      weeklyGoalHours: Number(settings.weekly_goal_hours) || 20,
      defaultTopN: Number(settings.default_top_n_apps) || 5,
      loaded,
      error,
      refresh,
    };
  }, [categories, rules, settings, loaded, error, refresh]);

  return <MetaContext.Provider value={value}>{children}</MetaContext.Provider>;
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
