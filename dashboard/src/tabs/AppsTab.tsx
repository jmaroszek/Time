import { useMemo, useState } from "react";

import { Button, Card, CategoryDot, Spinner } from "../components/ui";
import {
  categoryState,
  categoryStateFlags,
  type Category,
  type CategoryState,
  type MatchType,
} from "../lib/classify";
import { UNCATEGORIZED } from "../lib/chartTheme";
import { browserDomainCoverage, shouldShowDomainCoverageHint } from "../lib/domainCoverage";
import { cleanDomainName, cleanProcessName, fmtDuration } from "../lib/format";
import { clipSessions, duration, type Session } from "../lib/metrics";
import {
  addCategory,
  addRule,
  deleteCategory,
  deleteRule,
  saveProcessAliases,
  updateCategory,
} from "../lib/queries";
import type { Range } from "../lib/time";
import { useBanner } from "../state/banner";
import { useMeta } from "../state/meta";
import { useSessions } from "../state/useSessions";

interface UsageRow {
  kind: "process" | "domain";
  key: string;
  seconds: number;
  categoryName: string | null;
  categoryColor: string | null;
  /** Ignored-category time shows here (Apps is the management surface) but is
   *  excluded from Overview stats — the row is labeled accordingly. */
  categoryIgnored: boolean;
}

const PRIORITY: Record<MatchType, number> = { domain: 1, title: 2, process: 3 };
const TYPE_STYLES: Record<MatchType, string> = {
  domain: "bg-[#8397a8]/15 text-[#9aabba]",
  title: "bg-[#a195aa]/15 text-[#b0a5b8]",
  process: "bg-[#a99e8c]/15 text-[#b8ad9a]",
};
// Annotation-tier semantic hues plus the ignored gray.
const STATE_COLORS: Record<CategoryState, string> = {
  productive: "#4fb389",
  neutral: "#9aa0a8",
  unproductive: "#d07d7d",
  ignored: "#5b616b",
};

// Swatches offered by the category color picker: hues spaced AND lightness
// varied so no pair relies on hue alone (helps red-green color blindness).
const CATEGORY_SWATCHES = [
  "#9c8ff0", // light purple
  "#2f6fc0", // deep blue
  "#56c8d8", // cyan
  "#43c88a", // green
  "#1d9e75", // deep green
  "#e0a53a", // amber
  "#e8663d", // orange
  "#e75fa0", // pink
  "#b08a5e", // tan
  "#828994", // slate
];

export default function AppsTab({ range }: { range: Range }) {
  const meta = useMeta();
  const banner = useBanner();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const startSec = range.start.getTime() / 1000;
  const endSec = range.end.getTime() / 1000;
  const { sessions, loading, error } = useSessions(startSec, endSec);

  const { rows, hiddenCount, hiddenSeconds, showDomainHint } = useMemo(() => {
    const clipped = clipSessions(sessions, startSec, endSec).filter((s) => !s.isAfk);
    const domainCoverage = browserDomainCoverage(clipped, meta.browserSet);
    const byKey = new Map<string, { row: UsageRow; sample: Session }>();
    for (const s of clipped) {
      const isBrowser = meta.browserSet.has(s.process);
      const kind: UsageRow["kind"] = isBrowser && s.domain ? "domain" : "process";
      const key = kind === "domain" ? s.domain! : s.process;
      const mapKey = `${kind}:${key}`;
      let entry = byKey.get(mapKey);
      if (!entry) {
        entry = {
          row: { kind, key, seconds: 0, categoryName: null, categoryColor: null, categoryIgnored: false },
          sample: s,
        };
        byKey.set(mapKey, entry);
      }
      entry.row.seconds += duration(s);
    }
    for (const entry of byKey.values()) {
      const category = meta.classifier(entry.sample);
      entry.row.categoryName = category?.name ?? null;
      entry.row.categoryColor = category?.color ?? null;
      entry.row.categoryIgnored = category?.isIgnored ?? false;
    }
    const all = [...byKey.values()].map((entry) => entry.row).sort((a, b) => b.seconds - a.seconds);
    const visible = all.filter((row) => row.seconds >= meta.minAppSeconds);
    // What min_app_seconds hides is surfaced in the header footnote so the
    // Apps total reconciles visibly with the Overview KPI total.
    const hidden = all.length - visible.length;
    return {
      rows: visible,
      hiddenCount: hidden,
      hiddenSeconds: all.reduce((sum, row) => sum + row.seconds, 0) -
        visible.reduce((sum, row) => sum + row.seconds, 0),
      showDomainHint: shouldShowDomainCoverageHint(domainCoverage),
    };
  }, [sessions, startSec, endSec, meta]);

  if (loading) return <Spinner />;
  if (error) return <p className="p-8 text-sm text-bad">DB error: {error}</p>;

  const uncategorized = rows.filter((row) => row.categoryName === null);
  const refresh = async () => {
    await meta.refresh();
  };
  const assign = async (row: UsageRow, categoryId: number) => {
    try {
      await addRule(row.kind, row.key, categoryId);
      setOpenMenu(null);
      await refresh();
    } catch (e) {
      banner.report(e, "rule");
    }
  };
  const displayName = (row: UsageRow) =>
    row.kind === "process"
      ? cleanProcessName(row.key, meta.aliases)
      : cleanDomainName(row.key, meta.aliases);

  return (
    <div className="flex flex-col gap-4">
      {openMenu && (
        <button
          type="button"
          aria-label="Close category menu"
          className="fixed inset-0 z-40 cursor-default"
          onClick={() => setOpenMenu(null)}
        />
      )}

      {showDomainHint && (
        <section className="rounded-[12px] border border-accent/20 bg-accent/[.045] px-4 py-3 text-[11.5px] text-ink-2">
          Browser time is not being split by site. Install the third-party &quot;URL in title&quot;
          extension so Time can read domains from browser window titles.
        </section>
      )}

      {uncategorized.length > 0 && (
        <section className="rounded-[14px] border border-[#e0a53a]/30 bg-[linear-gradient(180deg,rgba(224,165,58,.06),rgba(224,165,58,.02))] px-4 py-3.5">
          <div className="mb-3 flex items-center gap-2 text-[13px]">
            <span className="h-2 w-2 rounded-full bg-[#e0a53a] shadow-[0_0_0_4px_rgba(224,165,58,.14)]" />
            <span className="font-semibold">Needs a category</span>
            <span className="text-[11px] text-ink-3">
              {uncategorized.length} {uncategorized.length === 1 ? "item" : "items"} · {fmtDuration(uncategorized.reduce((sum, row) => sum + row.seconds, 0))} uncategorized
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {uncategorized.map((row) => {
              const key = `uncat:${row.kind}:${row.key}`;
              return (
                <div key={key} className="flex items-center gap-2 rounded-[10px] border border-edge bg-surface px-3 py-2 text-xs">
                  <CategoryDot color={UNCATEGORIZED} />
                  <span>{displayName(row)}</span>
                  <span className="text-[11px] text-ink-3">{fmtDuration(row.seconds)}</span>
                  <CategoryMenu
                    menuKey={key}
                    openMenu={openMenu}
                    setOpenMenu={setOpenMenu}
                    categories={meta.categories}
                    selected={null}
                    trigger={<span>Assign ▾</span>}
                    triggerClass="rounded-lg border border-accent/30 px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent/15"
                    onSelect={(id) => void assign(row, id)}
                  />
                </div>
              );
            })}
          </div>
        </section>
      )}

      <Card
        title="Apps & Domains in Range"
        right={
          <span className="text-[11px] text-ink-3">
            {rows.length} tracked · {fmtDuration(rows.reduce((sum, row) => sum + row.seconds, 0))} total
            {hiddenCount > 0 &&
              ` · ${hiddenCount} more under ${fmtDuration(meta.minAppSeconds)} · ${fmtDuration(hiddenSeconds)}`}
          </span>
        }
      >
        <UsageTable
          rows={rows}
          displayName={displayName}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          onAssign={assign}
          onAliasesChanged={refresh}
        />
      </Card>

      <CategoriesAndRules onChanged={refresh} />
    </div>
  );
}

function CategoryMenu({
  menuKey,
  openMenu,
  setOpenMenu,
  categories,
  selected,
  trigger,
  triggerClass,
  onSelect,
}: {
  menuKey: string;
  openMenu: string | null;
  setOpenMenu: (key: string | null) => void;
  categories: Category[];
  selected: string | null;
  trigger: React.ReactNode;
  triggerClass: string;
  onSelect: (categoryId: number) => void;
}) {
  const open = openMenu === menuKey;
  return (
    <span className={`relative ${open ? "z-50" : ""}`}>
      <button
        type="button"
        className={triggerClass}
        onClick={(event) => {
          event.stopPropagation();
          setOpenMenu(open ? null : menuKey);
        }}
      >
        {trigger}
      </button>
      {open && (
        <span className="menu-pop absolute right-0 top-[calc(100%+6px)] z-50 min-w-[170px] rounded-[11px] border border-edge-2 bg-surface-2 p-1 shadow-[0_12px_34px_rgba(0,0,0,.5)]">
          {categories.map((category) => (
            <button
              type="button"
              key={category.id}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-3 ${selected === category.name ? "bg-surface-3" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(category.id);
              }}
            >
              <CategoryDot color={category.color} />
              <span className="flex-1">{category.name}</span>
              {selected === category.name && <span className="text-accent">✓</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function UsageTable({
  rows,
  displayName,
  openMenu,
  setOpenMenu,
  onAssign,
  onAliasesChanged,
}: {
  rows: UsageRow[];
  displayName: (row: UsageRow) => string;
  openMenu: string | null;
  setOpenMenu: (key: string | null) => void;
  onAssign: (row: UsageRow, categoryId: number) => Promise<void>;
  onAliasesChanged: () => Promise<void>;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const [editing, setEditing] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const total = rows.reduce((sum, row) => sum + row.seconds, 0);
  const max = rows[0]?.seconds ?? 1;
  const rowId = (row: UsageRow) => `${row.kind}:${row.key}`;
  const defaultName = (row: UsageRow) =>
    row.kind === "process" ? cleanProcessName(row.key) : cleanDomainName(row.key);
  const startAliasEdit = (row: UsageRow) => {
    setEditing(rowId(row));
    setAliasDraft(meta.aliases[row.key.toLowerCase()] ?? "");
  };
  const saveAliasEdit = async (row: UsageRow) => {
    const aliasKey = row.key.toLowerCase();
    const alias = aliasDraft.trim();
    const currentAlias = meta.aliases[aliasKey] ?? "";
    setEditing(null);
    if (alias === currentAlias) return;
    const nextAliases = { ...meta.aliases };
    if (alias) nextAliases[aliasKey] = alias;
    else delete nextAliases[aliasKey];
    try {
      await saveProcessAliases(nextAliases);
      await onAliasesChanged();
    } catch (e) {
      banner.report(e, "name");
    }
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] table-fixed text-xs">
        <thead>
          <tr className="border-b border-edge text-left text-[10.5px] uppercase tracking-[.04em] text-ink-3">
            <th className="w-[28%] pb-2 font-medium">Name</th>
            <th className="w-[38%] pb-2 pl-4 font-medium">Share of time</th>
            <th className="w-20 pb-2 pl-4 text-right font-medium">Time</th>
            <th className="pb-2 pl-4 font-medium">
              <span className="ml-auto block w-[150px] max-w-full">Category</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = `row:${row.kind}:${row.key}`;
            const color = row.categoryColor ?? UNCATEGORIZED;
            const pct = total ? Math.round((row.seconds / total) * 100) : 0;
            return (
              <tr key={key} className="border-b border-edge/40 transition-colors hover:bg-white/[.018]">
                <td className="py-2.5 pr-4">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    {editing === rowId(row) ? (
                      <input
                        autoFocus
                        value={aliasDraft}
                        aria-label={`Rename ${defaultName(row)}`}
                        placeholder={defaultName(row)}
                        onChange={(event) => setAliasDraft(event.target.value)}
                        onBlur={() => void saveAliasEdit(row)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void saveAliasEdit(row);
                          else if (event.key === "Escape") setEditing(null);
                        }}
                        className="w-full min-w-0 max-w-56 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-xs text-ink outline-none focus:border-accent/60"
                      />
                    ) : (
                      <span
                        className="truncate cursor-text"
                        title={`${row.key} — double-click to rename`}
                        onDoubleClick={() => startAliasEdit(row)}
                      >
                        {displayName(row)}
                      </span>
                    )}
                    <span className="text-[10px] leading-none text-ink-3">
                      {row.kind}
                      {row.categoryIgnored && " · excluded from stats"}
                    </span>
                  </span>
                </td>
                <td className="py-2.5 pl-4">
                  <span className="flex items-center gap-2">
                    <span className="h-[5px] flex-1 overflow-hidden rounded-full bg-surface-2">
                      <span className="block h-full rounded-full bg-ink-2" style={{ width: `${Math.max((row.seconds / max) * 100, 2)}%` }} />
                    </span>
                    <span className="w-7 text-right text-[10.5px] tabular-nums text-ink-3">{pct}%</span>
                  </span>
                </td>
                <td className="py-2.5 pl-4 text-right tabular-nums text-ink-2">{fmtDuration(row.seconds)}</td>
                <td className="py-2.5 pl-4">
                  <div className="ml-auto w-[150px] max-w-full">
                    <CategoryMenu
                      menuKey={key}
                      openMenu={openMenu}
                      setOpenMenu={setOpenMenu}
                      categories={meta.categories}
                      selected={row.categoryName}
                      trigger={
                        <span className="flex w-full items-center gap-2">
                          {row.categoryName ? <CategoryDot color={color} /> : <span className="h-2 w-2 rounded-full border border-dashed border-edge-2" />}
                          <span className="flex-1 truncate text-left">{row.categoryName ?? "Assign…"}</span>
                          <span className="text-ink-3">▾</span>
                        </span>
                      }
                      triggerClass={`w-full rounded-lg border px-2.5 py-1.5 text-[11px] transition-colors hover:bg-surface-3 ${row.categoryName ? "border-edge bg-surface-2 text-ink" : "border-dashed border-edge-2 bg-transparent text-ink-2"}`}
                      onSelect={(id) => void onAssign(row, id)}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CategoriesAndRules({ onChanged }: { onChanged: () => Promise<void> }) {
  const meta = useMeta();
  const banner = useBanner();
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set<number>());
  const [stateMenu, setStateMenu] = useState<number | null>(null);
  const [colorMenu, setColorMenu] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [newName, setNewName] = useState("");
  const [drafts, setDrafts] = useState<Record<number, { type: MatchType; pattern: string }>>({});

  const draftFor = (id: number) => drafts[id] ?? { type: "domain" as const, pattern: "" };
  const setDraft = (id: number, patch: Partial<{ type: MatchType; pattern: string }>) =>
    setDrafts((current) => ({ ...current, [id]: { ...draftFor(id), ...patch } }));
  const toggle = (id: number) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const submitRule = async (categoryId: number) => {
    const draft = draftFor(categoryId);
    if (!draft.pattern.trim()) return;
    try {
      await addRule(draft.type, draft.pattern, categoryId);
      setDraft(categoryId, { pattern: "" });
      await onChanged();
    } catch (e) {
      banner.report(e, "rule");
    }
  };
  const submitCategory = async () => {
    if (!newName.trim()) return;
    // First unused curated swatch, so new categories are distinguishable
    // instead of all accent-blue.
    const used = new Set(meta.categories.map((c) => c.color.toLowerCase()));
    const color =
      CATEGORY_SWATCHES.find((c) => !used.has(c)) ??
      CATEGORY_SWATCHES[meta.categories.length % CATEGORY_SWATCHES.length];
    try {
      const id = await addCategory(newName, color, "unproductive");
      setNewName("");
      setExpanded((current) => new Set(current).add(id));
      await onChanged();
    } catch (e) {
      banner.report(e, "category");
    }
  };
  const setCategoryState = async (category: Category, option: CategoryState) => {
    try {
      await updateCategory({ ...category, ...categoryStateFlags(option) });
      await onChanged();
    } catch (e) {
      banner.report(e, "category");
    }
  };
  const setCategoryColor = async (category: Category, color: string) => {
    try {
      await updateCategory({ ...category, color });
      await onChanged();
    } catch (e) {
      banner.report(e, "category");
    }
  };
  const saveRename = async (category: Category) => {
    const name = renameDraft.trim();
    setRenaming(null);
    if (!name || name === category.name) return;
    try {
      await updateCategory({ ...category, name });
      await onChanged();
    } catch (e) {
      banner.report(e, "category");
    }
  };
  const removeRule = async (ruleId: number) => {
    try {
      await deleteRule(ruleId);
      await onChanged();
    } catch (e) {
      banner.report(e, "rule");
    }
  };
  const removeCategory = async (category: Category, ruleCount: number) => {
    const rulesWarning = ruleCount === 0
      ? ""
      : ` and ${ruleCount} ${ruleCount === 1 ? "rule" : "rules"}`;
    if (!window.confirm(`Delete “${category.name}”${rulesWarning}? This cannot be undone.`)) return;
    try {
      await deleteCategory(category.id);
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(category.id);
        return next;
      });
      await onChanged();
    } catch (e) {
      banner.report(e, "category");
    }
  };

  return (
    <Card
      title="Categories & Rules"
      right={<span className="text-[11px] text-ink-3">{meta.categories.length} categories · {meta.rules.length} rules</span>}
    >
      {(stateMenu !== null || colorMenu !== null) && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-40 cursor-default"
          onClick={() => {
            setStateMenu(null);
            setColorMenu(null);
          }}
        />
      )}
      <div className="mb-4 text-[11px] text-ink-3">
        Rules live inside their category. If several rules match, the highest priority wins: domain, then title, then process.
      </div>
      <div className="flex flex-col gap-2">
        {meta.categories.map((category) => {
          const open = expanded.has(category.id);
          const state = categoryState(category);
          const menuOpen = stateMenu === category.id;
          const colorOpen = colorMenu === category.id;
          const rules = meta.rules.filter((rule) => rule.categoryId === category.id);
          const draft = draftFor(category.id);
          return (
            <div key={category.id} className={`rounded-[11px] border border-edge bg-surface-2 ${menuOpen || colorOpen ? "overflow-visible" : "overflow-hidden"}`}>
              <div
                role="button"
                tabIndex={0}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-3 text-left text-xs"
                onClick={() => toggle(category.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggle(category.id);
                  }
                }}
              >
                <span className={`text-[10px] text-ink-3 transition-transform duration-200 ${open ? "rotate-90" : ""}`}>▶</span>
                <span className="relative">
                  <button
                    type="button"
                    title="Change color"
                    aria-label={`Change color of ${category.name}`}
                    className="block h-3 w-3 rounded transition-shadow hover:shadow-[0_0_0_2px_var(--color-edge-2)]"
                    style={{ backgroundColor: category.color }}
                    onClick={(event) => {
                      event.stopPropagation();
                      setColorMenu(colorOpen ? null : category.id);
                      setStateMenu(null);
                    }}
                  />
                  {colorOpen && (
                    <span className="menu-pop absolute left-0 top-[calc(100%+6px)] z-50 grid w-[136px] grid-cols-5 gap-2 rounded-[11px] border border-edge-2 bg-surface-2 p-2.5 shadow-[0_12px_34px_rgba(0,0,0,.5)]">
                      {CATEGORY_SWATCHES.map((swatch) => (
                        <button
                          key={swatch}
                          type="button"
                          aria-label={`Use color ${swatch}`}
                          className={`h-4 w-4 rounded transition-shadow hover:shadow-[0_0_0_2px_var(--color-ink-3)] ${swatch === category.color.toLowerCase() ? "shadow-[0_0_0_2px_var(--color-ink-2)]" : ""}`}
                          style={{ backgroundColor: swatch }}
                          onClick={(event) => {
                            event.stopPropagation();
                            setColorMenu(null);
                            void setCategoryColor(category, swatch);
                          }}
                        />
                      ))}
                    </span>
                  )}
                </span>
                {renaming === category.id ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    aria-label={`Rename ${category.name}`}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onBlur={() => void saveRename(category)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveRename(category);
                      else if (event.key === "Escape") setRenaming(null);
                    }}
                    className="w-40 rounded-md border border-edge bg-surface px-1.5 py-0.5 text-xs font-semibold outline-none focus:border-accent/60"
                  />
                ) : (
                  <span
                    className="font-semibold"
                    title={category.isIgnored ? "The built-in Ignored category cannot be renamed" : "Double-click to rename"}
                    onDoubleClick={(event) => {
                      if (category.isIgnored) return;
                      event.stopPropagation();
                      setRenaming(category.id);
                      setRenameDraft(category.name);
                    }}
                  >
                    {category.name}
                  </span>
                )}
                <span className="flex-1" />
                <span className="relative w-[112px] shrink-0">
                  <span
                    role="button"
                    tabIndex={0}
                    className="flex w-full items-center justify-start gap-1.5 rounded-md px-2 py-1 text-[10.5px] capitalize text-ink-3 hover:bg-surface-3"
                    onClick={(event) => { event.stopPropagation(); setStateMenu(menuOpen ? null : category.id); setColorMenu(null); }}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setStateMenu(menuOpen ? null : category.id); } }}
                  >
                    <CategoryDot color={STATE_COLORS[state]} /> {state}
                  </span>
                  {menuOpen && (
                    <span className="menu-pop absolute right-0 top-[calc(100%+5px)] z-50 min-w-[155px] rounded-[11px] border border-edge-2 bg-surface-2 p-1 shadow-[0_12px_34px_rgba(0,0,0,.5)]">
                      {(["productive", "neutral", "unproductive", "ignored"] as CategoryState[]).map((option) => (
                        <span
                          role="button"
                          tabIndex={0}
                          key={option}
                          className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] capitalize hover:bg-surface-3 ${option === state ? "bg-surface-3" : ""}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setStateMenu(null);
                            void setCategoryState(category, option);
                          }}
                        >
                          <CategoryDot color={STATE_COLORS[option]} />
                          <span className="flex-1">{option}</span>
                          {option === state && <span className="text-accent">✓</span>}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span className="w-[66px] text-right text-[10.5px] text-ink-3">{rules.length} {rules.length === 1 ? "rule" : "rules"}</span>
              </div>

              {open && (
                <div className="ml-[42px] border-t border-edge/50 px-3 py-3">
                  <div className="flex flex-col gap-1.5">
                    {rules.map((rule) => (
                      <div key={rule.id} className="-mx-2 flex items-center gap-2 rounded-lg px-2 py-1 text-[11.5px] transition-colors hover:bg-white/[.028]">
                        <span className={`w-14 shrink-0 rounded-md px-1.5 py-1 text-center text-[9.5px] uppercase ${TYPE_STYLES[rule.matchType]}`}>{rule.matchType}</span>
                        <span className="min-w-0 flex-1 truncate font-mono" title={rule.pattern}>{rule.pattern}</span>
                        <span className="shrink-0 text-[10.5px] text-ink-3">Priority {rule.priority}</span>
                        <button type="button" title="Delete rule" className="rounded-md px-1.5 py-1 text-ink-3 transition-colors hover:bg-bad/15 hover:text-bad" onClick={() => void removeRule(rule.id)}>✕</button>
                      </div>
                    ))}
                    {rules.length === 0 && <p className="py-1 text-[11px] italic text-ink-3">No rules yet — add one below.</p>}
                  </div>
                  <div className="mt-3 flex items-center gap-2 border-t border-edge/40 pt-3">
                    <span className="flex rounded-lg border border-edge bg-surface p-0.5">
                      {(["domain", "title", "process"] as MatchType[]).map((type) => (
                        <button key={type} type="button" className={`rounded-md px-2 py-1 text-[10.5px] transition-colors ${draft.type === type ? TYPE_STYLES[type] : "text-ink-3 hover:text-ink-2"}`} onClick={() => setDraft(category.id, { type })}>{type}</button>
                      ))}
                    </span>
                    <input
                      value={draft.pattern}
                      onChange={(event) => setDraft(category.id, { pattern: event.target.value })}
                      onKeyDown={(event) => { if (event.key === "Enter") void submitRule(category.id); }}
                      placeholder={draft.type === "title" ? "substring to match…" : "exact match…"}
                      className="min-w-0 flex-1 rounded-lg border border-edge bg-surface px-2.5 py-1.5 font-mono text-[11.5px] outline-none placeholder:text-ink-3 focus:border-accent/60"
                    />
                    <Button variant="primary" disabled={!draft.pattern.trim()} onClick={() => void submitRule(category.id)}>Add rule</Button>
                    <span className="sr-only">Priority {PRIORITY[draft.type]}</span>
                  </div>
                  <div className="mt-3 flex justify-end border-t border-edge/40 pt-3">
                    <Button
                      variant="danger"
                      disabled={category.isIgnored}
                      title={category.isIgnored ? "The built-in Ignored category cannot be deleted" : `Delete ${category.name}`}
                      onClick={() => void removeCategory(category, rules.length)}
                    >
                      Delete category
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-2 border-t border-edge/50 pt-4">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submitCategory();
          }}
          placeholder="New category name"
          className="w-56 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-xs outline-none placeholder:text-ink-3 focus:border-accent/60"
        />
        <Button variant="primary" disabled={!newName.trim()} onClick={() => void submitCategory()}>
          + Add category
        </Button>
      </div>
    </Card>
  );
}
