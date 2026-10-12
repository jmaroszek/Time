import { beforeEach, expect, it, vi } from "vitest";
import type { ActivityTriageItem } from "../lib/activity";
import type { EntityRuleChange } from "../lib/queries";

const mocks = vi.hoisted(() => ({
  assignEntityRule: vi.fn(), assignEntityRules: vi.fn(), undoEntityRules: vi.fn(),
  removeEntityRules: vi.fn(), refresh: vi.fn(), show: vi.fn(), report: vi.fn(),
}));
vi.mock("../lib/queries", () => mocks);
vi.mock("./meta", () => ({ useMeta: () => ({
  categories: [{ id: 1, name: "Work" }, { id: 2, name: "Play" }], refresh: mocks.refresh,
}) }));
vi.mock("./banner", () => ({ useBanner: () => ({ show: mocks.show, report: mocks.report }) }));
import { useEntityRuleWrites } from "./useEntityRuleWrites";

const item = { kind: "app", key: "editor.exe", displayName: "Editor" } as ActivityTriageItem;
const change: EntityRuleChange = { matchType: "process", pattern: "editor.exe", before: [],
  after: [{ id: 7, pattern: "editor.exe", categoryId: 1, priority: 3 }] };
const actions = () => useEntityRuleWrites({ triageCount: 2, residualSeconds: 0 });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.assignEntityRule.mockResolvedValue(change);
  mocks.assignEntityRules.mockResolvedValue([change]);
  mocks.refresh.mockResolvedValue(undefined);
});

it("Undo sends the original committed change rather than looking up current rules", async () => {
  await actions().assignFromTriage(item, 1);
  const undo = mocks.show.mock.calls[0][1].run;
  // A later edit may have committed before its completion banner rendered.
  mocks.undoEntityRules.mockRejectedValue(new Error("changed after this action"));
  undo();
  await vi.waitFor(() => expect(mocks.report).toHaveBeenCalled());
  expect(mocks.undoEntityRules).toHaveBeenCalledWith([change]);
  expect(mocks.removeEntityRules).not.toHaveBeenCalled();
});

it("submits the complete suggestion batch once and reports a failed batch without success", async () => {
  mocks.assignEntityRules.mockRejectedValue(new Error("second category was removed"));
  await actions().applySuggestions([
    { entity: item, categoryId: 1 },
    { entity: { ...item, key: "notes.exe" }, categoryId: 2 },
  ] as Parameters<ReturnType<typeof actions>["applySuggestions"]>[0]);
  expect(mocks.assignEntityRules).toHaveBeenCalledWith([
    { matchType: "process", pattern: "editor.exe", categoryId: 1 },
    { matchType: "process", pattern: "notes.exe", categoryId: 2 },
  ]);
  expect(mocks.assignEntityRule).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.show).not.toHaveBeenCalled();
  expect(mocks.report).toHaveBeenCalledOnce();
});

it("keeps writes in user order across a screen remount", async () => {
  let finish!: (value: EntityRuleChange) => void;
  mocks.assignEntityRule.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = actions().assignFromTriage(item, 1);
  await vi.waitFor(() => expect(mocks.assignEntityRule).toHaveBeenCalledOnce());
  const second = actions().assignFromTriage(item, 2);
  await Promise.resolve();
  expect(mocks.assignEntityRule).toHaveBeenCalledOnce();
  finish(change);
  await Promise.all([first, second]);
  expect(mocks.assignEntityRule.mock.calls.map((call) => call[2])).toEqual([1, 2]);
  expect(mocks.show.mock.calls[mocks.show.mock.calls.length - 1][0]).toContain("Play");
});
