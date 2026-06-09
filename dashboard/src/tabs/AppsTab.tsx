// App/domain table with one-click categorization, the uncategorized review
// queue, and the category + rule editors.

import { useMemo, useState } from "react";

import { Button, Card, CategoryDot, Select, Spinner, TextInput } from "../components/ui";
import type { MatchType } from "../lib/classify";
import { cleanProcessName, fmtDuration } from "../lib/format";
import { clipSessions, duration, type Session } from "../lib/metrics";
import {
  addCategory,
  addRule,
  deleteCategory,
  deleteRule,
  updateCategory,
} from "../lib/queries";
import type { Range } from "../lib/time";
import { useMeta } from "../state/meta";
import { useSessions } from "../state/useSessions";

interface UsageRow {
  kind: "process" | "domain";
  key: string; // process name or domain
  seconds: number;
  categoryName: string | null;
  categoryColor: string | null;
}

export default function AppsTab({ range }: { range: Range }) {
  const meta = useMeta();
  const [bump, setBump] = useState(0);
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
        entry = { row: { kind, key, seconds: 0, categoryName: null, categoryColor: null }, sample: s };
        byKey.set(mapKey, entry);
      }
      entry.row.seconds += duration(s);
    }
    for (const entry of byKey.values()) {
      const cat = meta.classifier(entry.sample);
      entry.row.categoryName = cat?.name ?? null;
      entry.row.categoryColor = cat?.color ?? null;
    }
    return [...byKey.values()].map((e) => e.row).sort((a, b) => b.seconds - a.seconds);
  }, [sessions, startSec, endSec, meta]);

  if (loading) return <Spinner />;
  if (error) return <p className="p-8 text-sm text-bad">DB error: {error}</p>;

  const uncategorized = rows.filter((r) => r.categoryName === null);
  const refresh = async () => {
    await meta.refresh();
    setBump((b) => b + 1);
  };

  return (
    <div className="flex flex-col gap-4">
      {uncategorized.length > 0 && (
        <Card title={`Uncategorized time (${uncategorized.length})`}>
          <UsageTable rows={uncategorized.slice(0, 15)} onAssigned={refresh} />
        </Card>
      )}
      <Card title="Apps & domains in range">
        <UsageTable rows={rows} onAssigned={refresh} />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <CategoriesEditor onChanged={refresh} />
        <RulesEditor onChanged={refresh} />
      </div>
    </div>
  );
}

function UsageTable({ rows, onAssigned }: { rows: UsageRow[]; onAssigned: () => Promise<void> }) {
  const meta = useMeta();
  const total = rows.reduce((a, r) => a + r.seconds, 0);

  const assign = async (row: UsageRow, categoryIdStr: string) => {
    const categoryId = Number(categoryIdStr);
    if (!categoryId) return;
    await addRule(row.kind === "domain" ? "domain" : "process", row.key, categoryId);
    await onAssigned();
  };

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-ink-3">
          <th className="pb-2 font-medium">Name</th>
          <th className="pb-2 font-medium">Type</th>
          <th className="pb-2 text-right font-medium">Time</th>
          <th className="pb-2 text-right font-medium">Share</th>
          <th className="pb-2 pl-6 font-medium">Category</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.kind}:${r.key}`} className="border-t border-edge/60">
            <td className="py-1.5 pr-2">
              <span className="flex items-center gap-2">
                <CategoryDot color={r.categoryColor ?? "#5b616b"} />
                <span className="max-w-72 truncate" title={r.key}>
                  {r.kind === "process" ? cleanProcessName(r.key) : r.key}
                </span>
              </span>
            </td>
            <td className="py-1.5 text-ink-3">{r.kind}</td>
            <td className="py-1.5 text-right text-ink-2">{fmtDuration(r.seconds)}</td>
            <td className="py-1.5 text-right text-ink-3">
              {total > 0 ? `${Math.round((r.seconds / total) * 100)}%` : "–"}
            </td>
            <td className="py-1.5 pl-6">
              <Select
                value=""
                onChange={(v) => void assign(r, v)}
                options={[
                  { value: "", label: r.categoryName ?? "assign..." },
                  ...meta.categories.map((c) => ({ value: String(c.id), label: c.name })),
                ]}
                className="w-36"
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CategoriesEditor({ onChanged }: { onChanged: () => Promise<void> }) {
  const meta = useMeta();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#7F77DD");
  const [productive, setProductive] = useState(false);

  return (
    <Card title="Categories">
      <div className="flex flex-col gap-2">
        {meta.categories.map((c) => (
          <div key={c.id} className="flex items-center gap-3 text-xs">
            <input
              type="color"
              value={c.color}
              onChange={(e) => void updateCategory({ ...c, color: e.target.value }).then(onChanged)}
              className="h-6 w-8 cursor-pointer rounded border border-edge bg-transparent"
              title="Category color"
            />
            <span className="w-28 truncate">{c.name}</span>
            <label className="flex items-center gap-1.5 text-ink-2">
              <input
                type="checkbox"
                checked={c.isProductive}
                onChange={(e) =>
                  void updateCategory({ ...c, isProductive: e.target.checked }).then(onChanged)
                }
              />
              productive
            </label>
            <label
              className="flex items-center gap-1.5 text-ink-2"
              title="Hide this category from all visualizations"
            >
              <input
                type="checkbox"
                checked={c.isIgnored}
                onChange={(e) =>
                  void updateCategory({ ...c, isIgnored: e.target.checked }).then(onChanged)
                }
              />
              ignored
            </label>
            <span className="flex-1" />
            <Button
              variant="danger"
              title="Delete category and its rules"
              onClick={() => {
                if (confirm(`Delete category "${c.name}" and all its rules?`))
                  void deleteCategory(c.id).then(onChanged);
              }}
            >
              delete
            </Button>
          </div>
        ))}
        <div className="mt-2 flex items-center gap-2 border-t border-edge pt-3">
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-6 w-8 cursor-pointer rounded border border-edge bg-transparent"
            title="New category color"
          />
          <TextInput value={name} onChange={setName} placeholder="New category" className="w-36" />
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={productive}
              onChange={(e) => setProductive(e.target.checked)}
            />
            productive
          </label>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={() =>
              void addCategory(name, color, productive).then(async () => {
                setName("");
                await onChanged();
              })
            }
          >
            add
          </Button>
        </div>
      </div>
    </Card>
  );
}

function RulesEditor({ onChanged }: { onChanged: () => Promise<void> }) {
  const meta = useMeta();
  const [matchType, setMatchType] = useState<MatchType>("process");
  const [pattern, setPattern] = useState("");
  const [categoryId, setCategoryId] = useState("");

  const catName = (id: number) => meta.categories.find((c) => c.id === id)?.name ?? "?";

  return (
    <Card title={`Rules (${meta.rules.length})`}>
      <div className="flex max-h-80 flex-col gap-1 overflow-y-auto pr-1">
        {meta.rules.map((r) => (
          <div key={r.id} className="flex items-center gap-2 text-xs">
            <span className="w-14 shrink-0 text-ink-3">{r.matchType}</span>
            <span className="flex-1 truncate" title={r.pattern}>
              {r.pattern}
            </span>
            <span className="w-24 truncate text-ink-2">{catName(r.categoryId)}</span>
            <span className="w-8 text-right text-ink-3">{r.priority}</span>
            <button
              type="button"
              className="px-1 text-ink-3 hover:text-bad"
              title="Delete rule"
              onClick={() => void deleteRule(r.id).then(onChanged)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-edge pt-3">
        <Select
          value={matchType}
          onChange={(v) => setMatchType(v as MatchType)}
          options={[
            { value: "process", label: "process" },
            { value: "domain", label: "domain" },
            { value: "title", label: "title" },
          ]}
        />
        <TextInput
          value={pattern}
          onChange={setPattern}
          placeholder={matchType === "title" ? "substring" : "exact match"}
          className="flex-1"
        />
        <Select
          value={categoryId}
          onChange={setCategoryId}
          options={[
            { value: "", label: "category..." },
            ...meta.categories.map((c) => ({ value: String(c.id), label: c.name })),
          ]}
        />
        <Button
          variant="primary"
          disabled={!pattern.trim() || !categoryId}
          onClick={() =>
            void addRule(matchType, pattern, Number(categoryId)).then(async () => {
              setPattern("");
              await onChanged();
            })
          }
        >
          add
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-ink-3">
        Priority: domain (300) &gt; title (200) &gt; process (100). Domain/title rules apply to
        browser sessions only.
      </p>
    </Card>
  );
}
