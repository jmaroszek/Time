import { useMemo, useState } from "react";

import { Button, Card, CategoryDot, Spinner } from "../components/ui";
import {
  categoryKind,
  categoryStateFlags,
  type Category,
  type Productivity,
  type MatchType,
} from "../lib/classify";
import { cleanDomainName, cleanProcessName, fmtDuration } from "../lib/format";
import { clipSessions, duration, type Session } from "../lib/metrics";
import { addCategory, addRule, deleteRule, updateCategory } from "../lib/queries";
import type { Range } from "../lib/time";
import { useMeta } from "../state/meta";
import { useSessions } from "../state/useSessions";

interface UsageRow {
  kind: "process" | "domain";
  key: string;
  seconds: number;
  categoryName: string | null;
  categoryColor: string | null;
}

const PRIORITY: Record<MatchType, number> = { domain: 1, title: 2, process: 3 };
const TYPE_STYLES: Record<MatchType, string> = {
  domain: "bg-accent/15 text-accent",
  title: "bg-[#7f77dd]/15 text-[#9a93ea]",
  process: "bg-[#43c88a]/15 text-[#58d69a]",
};
const STATE_COLORS: Record<Productivity, string> = {
  productive: "#4fb389",
  neutral: "#9aa0a8",
  unproductive: "#d07d7d",
};

export default function AppsTab({ range }: { range: Range }) {
  const meta = useMeta();
  const [bump, setBump] = useState(0);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const startSec = range.start.getTime() / 1000;
  const endSec = range.end.getTime() / 1000;
  const { sessions, loading, error } = useSessions(startSec, endSec, bump);

  const rows = useMemo(() => {
    const clipped = clipSessions(sessions, startSec, endSec).filter((s) => !s.isAfk);
    const byKey = new Map<string, { row: UsageRow; sample: Session }>();
    for (const s of clipped) {
      const isBrowser = meta.browserSet.has(s.process);
      const kind: UsageRow["kind"] = isBrowser && s.domain ? "domain" : "process";
      const key = kind === "domain" ? s.domain! : s.process;
      const mapKey = `${kind}:${key}`;
      let entry = byKey.get(mapKey);
      if (!entry) {
        entry = {
          row: { kind, key, seconds: 0, categoryName: null, categoryColor: null },
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
    }
    return [...byKey.values()]
      .map((entry) => entry.row)
      .filter((row) => row.seconds >= meta.minAppSeconds)
      .sort((a, b) => b.seconds - a.seconds);
  }, [sessions, startSec, endSec, meta]);

  if (loading) return <Spinner />;
  if (error) return <p className="p-8 text-sm text-bad">DB error: {error}</p>;

  const uncategorized = rows.filter((row) => row.categoryName === null);
  const refresh = async () => {
    await meta.refresh();
    setBump((value) => value + 1);
  };
  const assign = async (row: UsageRow, categoryId: number) => {
    await addRule(row.kind, row.key, categoryId);
    setOpenMenu(null);
    await refresh();
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

      {uncategorized.length > 0 && (
        <section className="rounded-[14px] border border-[#e0a53a]/30 bg-[linear-gradient(180deg,rgba(224,165,58,.06),rgba(224,165,58,.02))] px-4 py-3.5">
          <div className="mb-3 flex items-center gap-2 text-[13px]">
            <span className="h-2 w-2 rounded-full bg-[#e0a53a] shadow-[0_0_0_4px_rgba(224,165,58,.14)]" />
            <span className="font-semibold">Needs a category</span>
            <span className="text-[11px] text-ink-3">
              {uncategorized.length} {uncategorized.length === 1 ? "item" : "items"} · {fmtDuration(uncategorized.reduce((sum, row) => sum + row.seconds, 0))} untracked
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {uncategorized.map((row) => {
              const key = `uncat:${row.kind}:${row.key}`;
              return (
                <div key={key} className="flex items-center gap-2 rounded-[10px] border border-edge bg-surface px-3 py-2 text-xs">
                  <CategoryDot color="#5b616b" />
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
          </span>
        }
      >
        <UsageTable
          rows={rows}
          displayName={displayName}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          onAssign={assign}
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
}: {
  rows: UsageRow[];
  displayName: (row: UsageRow) => string;
  openMenu: string | null;
  setOpenMenu: (key: string | null) => void;
  onAssign: (row: UsageRow, categoryId: number) => Promise<void>;
}) {
  const meta = useMeta();
  const total = rows.reduce((sum, row) => sum + row.seconds, 0);
  const max = rows[0]?.seconds ?? 1;
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed text-xs">
        <thead>
          <tr className="border-b border-edge text-left text-[10.5px] uppercase tracking-[.04em] text-ink-3">
            <th className="pb-2 font-medium">Name</th>
            <th className="w-16 pb-2 font-medium">Type</th>
            <th className="w-16 pb-2 text-right font-medium">Time</th>
            <th className="w-[120px] pb-2 pl-3 font-medium">Share</th>
            <th className="w-[150px] pb-2 pl-4 font-medium">Category</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = `row:${row.kind}:${row.key}`;
            const color = row.categoryColor ?? "#5b616b";
            const pct = total ? Math.round((row.seconds / total) * 100) : 0;
            return (
              <tr key={key} className="border-b border-edge/40 transition-colors hover:bg-white/[.018]">
                <td className="py-2.5 pr-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <CategoryDot color={color} />
                    <span className="truncate" title={row.key}>{displayName(row)}</span>
                  </span>
                </td>
                <td className="py-2.5 text-[11px] text-ink-3">{row.kind}</td>
                <td className="py-2.5 text-right tabular-nums text-ink-2">{fmtDuration(row.seconds)}</td>
                <td className="py-2.5 pl-3">
                  <span className="flex items-center gap-2">
                    <span className="h-[5px] flex-1 overflow-hidden rounded-full bg-surface-2">
                      <span className="block h-full rounded-full" style={{ width: `${Math.max((row.seconds / max) * 100, 2)}%`, backgroundColor: color }} />
                    </span>
                    <span className="w-7 text-right text-[10.5px] tabular-nums text-ink-3">{pct}%</span>
                  </span>
                </td>
                <td className="py-2.5 pl-4">
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
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(meta.categories.slice(0, 1).map((c) => c.id)));
  const [stateMenu, setStateMenu] = useState<number | null>(null);
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
    await addRule(draft.type, draft.pattern, categoryId);
    setDraft(categoryId, { pattern: "" });
    await onChanged();
  };

  return (
    <Card
      title="Categories & Rules"
      right={<span className="text-[11px] text-ink-3">{meta.categories.length} categories · {meta.rules.length} rules</span>}
    >
      {stateMenu !== null && <button type="button" aria-label="Close state menu" className="fixed inset-0 z-40 cursor-default" onClick={() => setStateMenu(null)} />}
      <p className="mb-4 text-[11px] leading-relaxed text-ink-3">
        Each category holds its own matching rules. Priority runs 1 (highest) → 3: <span className="font-semibold text-ink-2">domain 1</span> › title 2 › process 3.
      </p>
      <div className="flex flex-col gap-2">
        {meta.categories.map((category) => {
          const open = expanded.has(category.id);
          const state = categoryKind(category);
          const menuOpen = stateMenu === category.id;
          const rules = meta.rules.filter((rule) => rule.categoryId === category.id);
          const draft = draftFor(category.id);
          return (
            <div key={category.id} className={`rounded-[11px] border border-edge bg-surface-2 ${menuOpen ? "overflow-visible" : "overflow-hidden"}`}>
              <button type="button" className="flex w-full items-center gap-2.5 px-3 py-3 text-left text-xs" onClick={() => toggle(category.id)}>
                <span className={`text-[10px] text-ink-3 transition-transform duration-200 ${open ? "rotate-90" : ""}`}>▶</span>
                <span className="h-3 w-3 rounded" style={{ backgroundColor: category.color }} />
                <span className="font-semibold">{category.name}</span>
                <span className="flex-1" />
                <span className="relative">
                  <span
                    role="button"
                    tabIndex={0}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] capitalize text-ink-3 hover:bg-surface-3"
                    onClick={(event) => { event.stopPropagation(); setStateMenu(menuOpen ? null : category.id); }}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setStateMenu(menuOpen ? null : category.id); } }}
                  >
                    <CategoryDot color={STATE_COLORS[state]} /> {state}
                  </span>
                  {menuOpen && (
                    <span className="menu-pop absolute right-0 top-[calc(100%+5px)] z-50 min-w-[155px] rounded-[11px] border border-edge-2 bg-surface-2 p-1 shadow-[0_12px_34px_rgba(0,0,0,.5)]">
                      {(["productive", "neutral", "unproductive"] as Productivity[]).map((option) => (
                        <span
                          role="button"
                          tabIndex={0}
                          key={option}
                          className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] capitalize hover:bg-surface-3 ${option === state ? "bg-surface-3" : ""}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setStateMenu(null);
                            void updateCategory({ ...category, ...categoryStateFlags(option) }).then(onChanged);
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
              </button>

              {open && (
                <div className="ml-[42px] border-t border-edge/50 px-3 py-3">
                  <div className="flex flex-col gap-1.5">
                    {rules.map((rule) => (
                      <div key={rule.id} className="flex items-center gap-2 text-[11.5px]">
                        <span className={`w-14 shrink-0 rounded-md px-1.5 py-1 text-center text-[9.5px] uppercase ${TYPE_STYLES[rule.matchType]}`}>{rule.matchType}</span>
                        <span className="min-w-0 flex-1 truncate font-mono" title={rule.pattern}>{rule.pattern}</span>
                        <span className="shrink-0 text-[10.5px] text-ink-3">pri {rule.priority}</span>
                        <button type="button" title="Delete rule" className="rounded-md px-1.5 py-1 text-ink-3 transition-colors hover:bg-bad/15 hover:text-bad" onClick={() => void deleteRule(rule.id).then(onChanged)}>✕</button>
                      </div>
                    ))}
                    {rules.length === 0 && <p className="py-1 text-[11px] italic text-ink-3">No rules yet — add one below.</p>}
                  </div>
                  <div className="mt-3 flex items-center gap-2 border-t border-edge/40 pt-3">
                    <span className="flex rounded-lg border border-edge bg-surface p-0.5">
                      {(["domain", "title", "process"] as MatchType[]).map((type) => (
                        <button key={type} type="button" className={`rounded-md px-2 py-1 text-[10.5px] transition-colors ${draft.type === type ? "bg-accent/15 text-accent" : "text-ink-3 hover:text-ink-2"}`} onClick={() => setDraft(category.id, { type })}>{type}</button>
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
            if (event.key === "Enter" && newName.trim()) {
              void addCategory(newName, "#6ba0da", "unproductive").then(async (id) => {
                setNewName("");
                setExpanded((current) => new Set(current).add(id));
                await onChanged();
              });
            }
          }}
          placeholder="New category name"
          className="w-56 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-xs outline-none placeholder:text-ink-3 focus:border-accent/60"
        />
        <Button
          variant="primary"
          disabled={!newName.trim()}
          onClick={() => void addCategory(newName, "#6ba0da", "unproductive").then(async (id) => {
            setNewName("");
            setExpanded((current) => new Set(current).add(id));
            await onChanged();
          })}
        >
          + Add category
        </Button>
      </div>
    </Card>
  );
}
