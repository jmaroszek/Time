import { useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";

import {
  Button,
  ConfirmDialog,
  MenuSelect,
  RemoveButton,
} from "../../components/ui";
import type { ActivitySource, RuleUsageEntry } from "../../lib/activity";
import {
  categoryState,
  categoryStateFlags,
  type Category,
  type CategoryGoal,
  type Productivity,
  type Rule,
} from "../../lib/classify";
import {
  describeTitleRule,
  findDuplicateRule,
  isBuiltInIgnored,
  NEW_CATEGORY_DEFAULT_STATE,
  ruleMatchesSearch,
  sortCategoriesForRules,
  sortRulesForCategory,
  titleRuleScopeLabel,
  type CategoryListOrder,
  type RuleListOrder,
} from "../../lib/categoryRules";
import {
  findConsolidation,
  parseDismissed,
  serializeDismissed,
  type ConsolidationSuggestion,
} from "../../lib/domainConsolidation";
import { goalSummary } from "../../lib/categoryGoals";
import { fmtDuration } from "../../lib/format";
import { canonicalSwatch, previewSwatches } from "../../lib/palettes";
import {
  addCategory,
  addRule,
  deleteCategory,
  deleteRule,
  setCategoryGoal,
  updateCategory,
  updateRule,
  updateSetting,
} from "../../lib/queries";
import { useBanner } from "../../state/banner";
import { useMeta } from "../../state/meta";
import Chevron from "./Chevron";
import ClearableInput from "./ClearableInput";
import Collapsible from "./Collapsible";
import GoalEditor, { GOAL_EDITOR_WIDTH } from "./GoalEditor";
import RuleKindGlyph from "./RuleKindGlyph";
import { toggleSetValue } from "../../lib/setUpdates";
import { stateColors } from "./activityStyles";
import {
  ASSIGNABLE_STATES,
  CategoryRuleForm,
  EditRuleButton,
  RULE_LABELS,
  draftFromRule,
  ruleDraftReady,
  stateLabel,
  type CategoryRuleDraft,
  type RuleConflict,
  type RuleEditState,
} from "./ruleComposer";

const SWATCH_MENU_WIDTH = 136;


const CATEGORY_ORDER_STORAGE_KEY = "time.categories-and-rules.category-order";
const RULE_ORDER_STORAGE_KEY = "time.categories-and-rules.rule-order";

/** Menu order is the order each list reads in the Sort menu. */
const CATEGORY_ORDER_LABELS: Record<CategoryListOrder, string> = {
  productivity: "Productivity",
  name: "Name",
};
const RULE_ORDER_LABELS: Record<RuleListOrder, string> = {
  use: "Use",
  "type-name": "Type",
  name: "Name",
};

function readCategoryListOrder(): CategoryListOrder {
  if (typeof window === "undefined") return "productivity";
  try {
    const stored = window.localStorage.getItem(CATEGORY_ORDER_STORAGE_KEY);
    return stored === "name" ? stored : "productivity";
  } catch {
    return "productivity";
  }
}

function readRuleListOrder(): RuleListOrder {
  if (typeof window === "undefined") return "use";
  try {
    const stored = window.localStorage.getItem(RULE_ORDER_STORAGE_KEY);
    return stored === "name" || stored === "type-name" ? stored : "use";
  } catch {
    return "use";
  }
}

function storeListOrder(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A blocked WebView store should not make an otherwise local view control
    // unusable; the selection simply lasts for this mount.
  }
}

/**
 * An offer to replace several exact Website rules with the one parent they have
 * turned into.
 *
 * Three sentences, in the order the reader needs them: what it replaces, that
 * nothing recorded moves, and what changes from here. The last is the only real
 * consequence — new sites under the parent stop arriving in Unclassified — and
 * burying it would make this the kind of suggestion that gets accepted once and
 * regretted later.
 *
 * Absorbed sites are listed by name and never summarized as a count. They are
 * the sole change to recorded history, the check refuses to raise a suggestion
 * where they outnumber the rules behind it, and a number would ask the reader
 * to take on trust the one thing they are here to judge.
 */
function ConsolidationNotice({
  suggestion,
  categoryName,
  busy,
  onApply,
  onDismiss,
}: {
  suggestion: ConsolidationSuggestion;
  categoryName: string | null;
  busy: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const count = suggestion.childRules.length;
  const absorbed = suggestion.absorbedDomains;
  return (
    <section
      aria-labelledby="consolidation-heading"
      className="mb-3 rounded-lg border border-edge bg-surface-dim px-3 py-2.5 text-xs leading-relaxed text-ink-2"
    >
      <h3 id="consolidation-heading" className="font-semibold text-ink">
        {count} Website rules under {suggestion.parent} all say{" "}
        {categoryName ?? "the same thing"}
      </h3>
      <p className="mt-1">
        Replacing them with one rule for <span className="text-ink">{suggestion.parent}</span>{" "}
        changes nothing already recorded.
        {absorbed.length > 0 && (
          <>
            {" "}
            {absorbed.length === 1 ? "One site has" : `${absorbed.length} sites have`} no rule yet
            and would become {categoryName ?? "that category"}:{" "}
            <span className="text-ink">{absorbed.join(", ")}</span>.
          </>
        )}{" "}
        New sites under {suggestion.parent} will be classified automatically instead of waiting
        in Unclassified.
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={onApply} disabled={busy}>
          {busy ? "Replacing…" : "Replace"}
        </Button>
        {/* Dismissal is per-parent and permanent. A suggestion that came back
            after being turned down would be the thing that makes the next one
            not worth reading. */}
        <Button onClick={onDismiss} disabled={busy} title="Never suggest this again">
          Dismiss
        </Button>
      </div>
    </section>
  );
}

export default function CategoriesAndRules({
  source,
  ruleUsageSeconds,
  onChanged,
  onViewInInsights,
  requestedCategory = null,
  onRequestedCategoryOpened,
}: {
  /** All of history, for the match preview under the rule being written. Null
   *  until the sessions have loaded. */
  source: ActivitySource | null;
  /** How much of all history each rule decided. Null while history is still
   *  being read — no rule is "unused" until we have looked, and a tag that
   *  flashes on and off is worse than none. */
  ruleUsageSeconds: RuleUsageEntry[] | null;
  onChanged: () => Promise<void>;
  /** Opens Insights narrowed to one category. */
  onViewInInsights?: (category: Category) => void;
  /** A category to open and scroll to on arrival, from Settings' goal list. */
  requestedCategory?: number | null;
  onRequestedCategoryOpened?: () => void;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set<number>());
  // Which category is awaiting confirmation, and its rule count — the blast
  // radius the dialog has to state, since deleting a category takes its rules.
  const [pendingDelete, setPendingDelete] = useState<{ category: Category; ruleCount: number } | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Anchored to the swatch's measured position and rendered through a portal:
  // the category list scrolls now, and a menu positioned inside it would be
  // clipped by that scroll container the moment a row neared the bottom.
  const [colorMenu, setColorMenu] = useState<{ id: number; left: number; top: number } | null>(null);
  // The goal editor anchors the same way, to the goal label or, when it was
  // opened from the actions menu, to the row's header.
  const [goalMenu, setGoalMenu] = useState<{ id: number; left: number; top: number } | null>(null);
  const categoryHeaderRefs = useRef(new Map<number, HTMLDivElement>());
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [newName, setNewName] = useState("");
  // The new-category field stays folded behind one line until asked for.
  const [addingCategory, setAddingCategory] = useState(false);
  // Categories whose add-rule form has been opened. Reading a category's rules
  // is far more common than adding one, so the form waits behind "+ Add rule"
  // everywhere except in a category with no rules yet.
  const [composerOpen, setComposerOpen] = useState<Set<number>>(() => new Set<number>());
  const [ruleSearch, setRuleSearch] = useState("");
  const deferredRuleSearch = useDeferredValue(ruleSearch.trim());
  const [categoryOrder, setCategoryOrder] = useState<CategoryListOrder>(
    readCategoryListOrder,
  );
  const [ruleOrder, setRuleOrder] = useState<RuleListOrder>(readRuleListOrder);
  const [drafts, setDrafts] = useState<Record<number, CategoryRuleDraft>>({});
  const [ruleConflict, setRuleConflict] = useState<RuleConflict | null>(null);
  const [editingRule, setEditingRule] = useState<RuleEditState | null>(null);
  const categoryEditorRefs = useRef(new Map<number, HTMLDivElement>());
  const usage = useMemo(
    () => (ruleUsageSeconds === null ? null : new Map(ruleUsageSeconds)),
    [ruleUsageSeconds],
  );
  useEffect(() => {
    if (requestedCategory === null) return;
    setExpanded((current) => new Set(current).add(requestedCategory));
    // After the expansion has rendered, so the header lands where it will stay.
    window.requestAnimationFrame(() => {
      categoryHeaderRefs.current.get(requestedCategory)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    });
    onRequestedCategoryOpened?.();
  }, [requestedCategory, onRequestedCategoryOpened]);

  const draftFor = (id: number): CategoryRuleDraft =>
    drafts[id] ?? {
      type: "process" as const,
      pattern: "",
      scopeKind: "process",
      scopeValue: "",
      titleMatchMode: "phrase",
      titleAnchor: "any",
    };
  const setDraft = (id: number, patch: Partial<CategoryRuleDraft>) => {
    setRuleConflict((current) => current?.categoryId === id ? null : current);
    setDrafts((current) => ({ ...current, [id]: { ...draftFor(id), ...patch } }));
  };
  const toggle = (id: number) => setExpanded((current) => {
    return toggleSetValue(current, id);
  });
  const commitRule = async (categoryId: number, draft: CategoryRuleDraft) => {
    if (!draft.pattern.trim() || !ruleDraftReady(draft)) return;
    try {
      await addRule(
        draft.type,
        draft.pattern,
        categoryId,
        draft.type === "title" ? draft : {},
      );
      setDraft(categoryId, { pattern: "" });
      setRuleConflict(null);
      await onChanged();
      banner.show(`${RULE_LABELS[draft.type]} rule “${draft.pattern.trim()}” added.`);
    } catch (error) {
      banner.report(error, "rule");
    }
  };
  const submitRule = async (categoryId: number) => {
    const draft = draftFor(categoryId);
    if (!draft.pattern.trim() || !ruleDraftReady(draft)) return;
    const existingRule = findDuplicateRule(
      meta.rules,
      draft.type,
      draft.pattern,
      draft.type === "title" ? draft : {},
    );
    if (existingRule) {
      setRuleConflict({
        categoryId,
        existingRule,
        existingCategoryName:
          meta.categories.find((category) => category.id === existingRule.categoryId)?.name
          ?? "another category",
        draft: { ...draft },
      });
      return;
    }
    await commitRule(categoryId, draft);
  };
  const beginRuleEdit = (rule: Rule) => {
    setEditingRule({
      ruleId: rule.id,
      categoryId: rule.categoryId,
      draft: draftFromRule(rule),
      conflict: null,
    });
    window.requestAnimationFrame(() => {
      categoryEditorRefs.current.get(rule.categoryId)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "nearest",
      });
    });
  };
  const changeRuleEdit = (patch: Partial<CategoryRuleDraft>) => {
    setEditingRule((current) => current
      ? {
          ...current,
          draft: { ...current.draft, ...patch },
          conflict: null,
        }
      : null);
  };
  const saveRuleEdit = async () => {
    if (
      !editingRule
      || !editingRule.draft.pattern.trim()
      || !ruleDraftReady(editingRule.draft)
    ) return;
    const { draft } = editingRule;
    const duplicate = findDuplicateRule(
      meta.rules.filter((rule) => rule.id !== editingRule.ruleId),
      draft.type,
      draft.pattern,
      draft.type === "title" ? draft : {},
    );
    if (duplicate) {
      const categoryName =
        meta.categories.find((category) => category.id === duplicate.categoryId)?.name
        ?? "another category";
      setEditingRule({
        ...editingRule,
        conflict: `This rule already exists in ${categoryName}.`,
      });
      return;
    }
    try {
      await updateRule(
        editingRule.ruleId,
        draft.type,
        draft.pattern,
        editingRule.categoryId,
        draft.type === "title" ? draft : {},
      );
      setEditingRule(null);
      await onChanged();
      banner.show(`${RULE_LABELS[draft.type]} rule “${draft.pattern.trim()}” updated.`);
    } catch (error) {
      banner.report(error, "rule");
    }
  };
  // updateCategory writes a whole row, and the category objects this component
  // renders carry theme-mapped colours. Every write therefore starts from the
  // stored row, so editing a name or a state in light mode cannot quietly
  // persist the light hex in place of the saved one.
  const stored = (category: Category): Category =>
    meta.storedCategories.find((row) => row.id === category.id) ?? category;

  const submitCategory = async () => {
    if (!newName.trim()) return;
    // Compared and stored in canonical values, both sides: `used` comes from the
    // stored rows and the swatch is mapped back before it is written.
    const used = new Set(meta.storedCategories.map((category) => category.color.toLowerCase()));
    const swatches = meta.palette.swatches.map((swatch) =>
      canonicalSwatch(meta.palette, meta.theme, swatch),
    );
    const color = swatches.find((swatch) => !used.has(swatch)) ?? swatches[meta.storedCategories.length % swatches.length];
    try {
      const id = await addCategory(newName, color, NEW_CATEGORY_DEFAULT_STATE);
      setNewName("");
      setAddingCategory(false);
      setExpanded((current) => new Set(current).add(id));
      await onChanged();
    } catch (error) {
      banner.report(error, "category");
    }
  };
  const setCategoryState = async (category: Category, option: Productivity) => {
    try { await updateCategory({ ...stored(category), ...categoryStateFlags(option) }); await onChanged(); }
    catch (error) { banner.report(error, "category"); }
  };
  const setCategoryColor = async (category: Category, color: string) => {
    try {
      await updateCategory({
        ...stored(category),
        color: canonicalSwatch(meta.palette, meta.theme, color),
      });
      await onChanged();
    } catch (error) { banner.report(error, "category"); }
  };
  const openGoalEditor = (categoryId: number, anchor: DOMRect) => {
    setGoalMenu({
      id: categoryId,
      left: Math.max(8, Math.min(anchor.right - GOAL_EDITOR_WIDTH, window.innerWidth - GOAL_EDITOR_WIDTH - 8)),
      top: Math.min(anchor.bottom + 6, window.innerHeight - 196),
    });
  };
  const saveGoal = async (category: Category, goal: CategoryGoal | null) => {
    setGoalMenu(null);
    try { await setCategoryGoal(category.id, goal); await onChanged(); }
    catch (error) { banner.report(error, "category"); }
  };
  const saveRename = async (category: Category) => {
    const name = renameDraft.trim();
    setRenaming(null);
    if (!name || name === category.name) return;
    try { await updateCategory({ ...stored(category), name }); await onChanged(); }
    catch (error) { banner.report(error, "category"); }
  };
  const removeRule = async (ruleId: number) => {
    try { await deleteRule(ruleId); await onChanged(); }
    catch (error) { banner.report(error, "rule"); }
  };
  const removeCategory = async (category: Category) => {
    setDeleting(true);
    try {
      await deleteCategory(category.id);
      setExpanded((current) => { const next = new Set(current); next.delete(category.id); return next; });
      setPendingDelete(null);
      await onChanged();
    } catch (error) {
      banner.report(error, "category");
    } finally {
      setDeleting(false);
    }
  };
  const resetCount = Number(meta.settings.window_rules_reset_v4_count ?? "0");
  const showResetNotice =
    meta.settings.window_rules_reset_v4_pending === "1" && resetCount > 0;
  const dismissResetNotice = async () => {
    try {
      await updateSetting("window_rules_reset_v4_pending", "0");
      await onChanged();
    } catch (error) {
      banner.report(error, "Window rule notice");
    }
  };
  // See undoConsolidation for why the rules are read through a ref.
  const rulesRef = useRef(meta.rules);
  rulesRef.current = meta.rules;
  // Parents already turned down. Read through the same settings map the reset
  // notice uses, so a dismissal survives a restart the way the reader expects.
  const dismissedConsolidations = useMemo(
    () => parseDismissed(meta.settings.rule_consolidation_dismissed),
    [meta.settings.rule_consolidation_dismissed],
  );
  // Only ever one suggestion, and only on this face. The check classifies every
  // session twice per candidate it examines, which is the same order of work
  // the rule composer's live preview already does on every keystroke — but it
  // is not worth repeating while the reader is typing in the search field, so
  // it hangs off the source and the rules rather than off any of this view's
  // own state.
  const consolidation = useMemo(
    () => (source ? findConsolidation(source, dismissedConsolidations) : null),
    [source, dismissedConsolidations],
  );
  const [consolidating, setConsolidating] = useState(false);

  /**
   * Parent in, children out — in that order. Between the two writes the parent
   * already covers every domain the children did, so a failure part-way leaves
   * classification intact rather than stripping it.
   */
  const applyConsolidation = async (suggestion: ConsolidationSuggestion) => {
    setConsolidating(true);
    try {
      await addRule("domain", suggestion.parent, suggestion.categoryId);
      for (const rule of suggestion.childRules) await deleteRule(rule.id);
      await onChanged();
      const category = meta.categories.find((option) => option.id === suggestion.categoryId);
      banner.show(
        `${suggestion.childRules.length} rules replaced by one for ${suggestion.parent}`
        + `${category ? `, in ${category.name}` : ""}.`,
        { label: "Undo", run: () => void undoConsolidation(suggestion) },
      );
    } catch (error) {
      banner.report(error, "rule");
    } finally {
      setConsolidating(false);
    }
  };

  /** The reverse, in the reverse order for the same reason: the children are
   *  back before the parent they replaced goes away.
   *
   *  Every child is a Website rule by construction — candidateParents only
   *  groups those — so nothing here has a Window rule's scope fields to carry.
   *  Rules come from the ref because this runs from a banner, long after the
   *  render that offered it; `meta` in that closure predates the write it has
   *  to reverse and does not contain the parent to delete. */
  const undoConsolidation = async (suggestion: ConsolidationSuggestion) => {
    try {
      for (const rule of suggestion.childRules) {
        await addRule("domain", rule.pattern, rule.categoryId, { priority: rule.priority });
      }
      const parent = findDuplicateRule(rulesRef.current, "domain", suggestion.parent);
      if (parent) await deleteRule(parent.id);
      await onChanged();
    } catch (error) {
      banner.report(error, "rule");
    }
  };

  const dismissConsolidation = async (suggestion: ConsolidationSuggestion) => {
    try {
      await updateSetting(
        "rule_consolidation_dismissed",
        serializeDismissed([...dismissedConsolidations, suggestion.parent]),
      );
      await onChanged();
    } catch (error) {
      banner.report(error, "rule suggestion");
    }
  };

  const chooseCategoryOrder = (next: CategoryListOrder) => {
    setCategoryOrder(next);
    storeListOrder(CATEGORY_ORDER_STORAGE_KEY, next);
  };
  const chooseRuleOrder = (next: RuleListOrder) => {
    setRuleOrder(next);
    storeListOrder(RULE_ORDER_STORAGE_KEY, next);
  };
  const normalizedRuleSearch = deferredRuleSearch.toLocaleLowerCase();
  const searching = normalizedRuleSearch !== "";
  const orderedCategories = sortCategoriesForRules(
    meta.categories,
    categoryOrder,
  );
  const categoryRows = orderedCategories.map((category) => {
    const allRules = sortRulesForCategory(
      meta.rules.filter((rule) => rule.categoryId === category.id),
      ruleOrder,
      usage,
    );
    const categoryMatches =
      normalizedRuleSearch !== ""
      && category.name.toLocaleLowerCase().includes(normalizedRuleSearch);
    const visibleRules = normalizedRuleSearch === "" || categoryMatches
      ? allRules
      : allRules.filter((rule) => ruleMatchesSearch(rule, normalizedRuleSearch));
    return { category, allRules, visibleRules };
  }).filter(({ visibleRules, category }) =>
    normalizedRuleSearch === ""
    || visibleRules.length > 0
    || category.name.toLocaleLowerCase().includes(normalizedRuleSearch)
  );

  return (
    // Scrolls itself rather than the page once enough categories are open. The
    // -mr-2/pr-2 keeps the scrollbar off the rows. The smaller left and top
    // pairs give outside focus outlines room inside the scroll clip — the
    // search field sits flush against the top edge; the negative margins
    // preserve the alignment of every field and row. Bottom padding keeps the
    // final input's outline inside the scrollable area at its maximum position.
    <div className="scroll-well -ml-1 -mr-2 -mt-1 flex min-h-0 flex-col overflow-y-auto pb-1 pl-1 pr-2 pt-1">
      {colorMenu !== null && <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 cursor-default" onClick={() => setColorMenu(null)} />}
      {showResetNotice && (
        <div className="mb-3 flex items-start gap-3 rounded-lg border border-accent/25 bg-accent/[.055] px-3 py-2.5 text-xs leading-relaxed text-ink-2">
          <p className="min-w-0 flex-1">
            Window matching was upgraded. {resetCount} older Window{" "}
            {resetCount === 1 ? "rule was" : "rules were"} removed because the old
            substring meaning could not be translated reliably. App and Website rules
            were preserved.
          </p>
          <button
            type="button"
            className="shrink-0 text-ink-3 hover:text-ink-2"
            onClick={() => void dismissResetNotice()}
          >
            Dismiss
          </button>
        </div>
      )}
      {consolidation && (
        <ConsolidationNotice
          suggestion={consolidation}
          categoryName={
            meta.categories.find((option) => option.id === consolidation.categoryId)?.name ?? null
          }
          busy={consolidating}
          onApply={() => void applyConsolidation(consolidation)}
          onDismiss={() => void dismissConsolidation(consolidation)}
        />
      )}
      {/* No standing explainer: precedence resolves clashes sensibly on its
          own, a classification's source can be inspected from its row, and
          the rule model is documented on the website. */}
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <ClearableInput
          value={ruleSearch}
          onChange={setRuleSearch}
          label="Search rules"
          placeholder="Search rules, types, and categories…"
          leadingIcon
          className="min-w-0 flex-1"
        />
        {/* Both orders behind one trigger. Two labelled menus took as much
            of the row as the search field did, for settings that change
            rarely; the current orders are the checked rows inside. */}
        <MenuSelect
          size="field"
          variant="resting"
          align="end"
          label="Sort categories and rules"
          className="cursor-pointer"
          value=""
          placeholder={
            <>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0">
                <path d="M4 6h10M4 12h7M4 18h4" /><path d="M18 5v14M15 16l3 3 3-3" />
              </svg>
              <span>Sort</span>
            </>
          }
          onChange={(value) => {
            const [group, order] = value.split(":");
            if (group === "category") chooseCategoryOrder(order as CategoryListOrder);
            else chooseRuleOrder(order as RuleListOrder);
          }}
          options={[
            ...(Object.keys(CATEGORY_ORDER_LABELS) as CategoryListOrder[]).map((order, i) => ({
              value: `category:${order}`,
              label: CATEGORY_ORDER_LABELS[order],
              section: i === 0 ? "Categories" : undefined,
              checked: categoryOrder === order,
            })),
            ...(Object.keys(RULE_ORDER_LABELS) as RuleListOrder[]).map((order, i) => ({
              value: `rule:${order}`,
              label: RULE_ORDER_LABELS[order],
              section: i === 0 ? "Rules" : undefined,
              checked: ruleOrder === order,
            })),
          ]}
        />
      </div>
      <div className="flex flex-col gap-2">
        {categoryRows.map(({ category, allRules, visibleRules }) => {
          const open = normalizedRuleSearch !== "" || expanded.has(category.id);
          const state = categoryState(category);
          const stateColorMap = stateColors(meta.palette, meta.theme);
          const locked = isBuiltInIgnored(category);
          const draft = draftFor(category.id);
          const activeEdit =
            editingRule?.categoryId === category.id ? editingRule : null;
          const beginRename = () => { setRenaming(category.id); setRenameDraft(category.name); };
          // The add-rule form is open while a rule is being edited, once asked
          // for, and from the start in a category that has no rules to read.
          // A search shows only what matched, so it folds the form away.
          const showComposer =
            activeEdit !== null
            || (!searching && (allRules.length === 0 || composerOpen.has(category.id)));
          const closeComposer = allRules.length > 0
            ? () => {
                setComposerOpen((current) => {
                  const next = new Set(current);
                  next.delete(category.id);
                  return next;
                });
                setDraft(category.id, { pattern: "" });
                setRuleConflict(null);
              }
            : undefined;
          // The header is a wide bar with one small chevron at the far left,
          // so the whole width acts as the hit target — but only as a mouse
          // convenience. The chevron stays the keyboard and screen-reader
          // control, and giving the bar its own role and tab stop would put a
          // second, competing announcement of the same toggle in the tab
          // order. A search forces every row open, and then the bar toggles
          // nothing and says so by not taking the pointer cursor.
          const rowToggles = normalizedRuleSearch === "";
          const toggleFromRow = (event: MouseEvent<HTMLDivElement>) => {
            // A click anywhere outside the rename field commits the rename by
            // blurring it. That click has already been spent; also toggling
            // the body on it would be a second, unasked-for outcome.
            if (renaming === category.id) return;
            const target = event.target as HTMLElement;
            // Every control in the bar already spends a click on something
            // else, and the name spends a double-click on renaming — a single
            // click there would open and shut the body under the second one.
            if (target.closest("button, input, [data-row-toggle='off']")) return;
            toggle(category.id);
          };
          return (
            <div
              key={category.id}
              className="overflow-hidden rounded-[11px] border border-edge bg-group"
            >
              <div
                ref={(node) => {
                  if (node) categoryHeaderRefs.current.set(category.id, node);
                  else categoryHeaderRefs.current.delete(category.id);
                }}
                className={`flex items-center gap-2.5 px-3 py-3 text-xs ${rowToggles ? "cursor-pointer" : ""}`}
                onClick={rowToggles ? toggleFromRow : undefined}
              >
                {normalizedRuleSearch !== "" ? (
                  <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center text-xs text-ink-3">
                    <span className="rotate-90"><Chevron open={false} bold /></span>
                  </span>
                ) : (
                  <button type="button" aria-expanded={open} aria-controls={`category-rules-${category.id}`} aria-label={`${open ? "Collapse" : "Expand"} ${category.name} rules`} onClick={() => toggle(category.id)} className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-xs text-ink-3 hover:bg-surface-3 hover:text-ink-2"><span className={`flex transition-transform duration-200 ${open ? "rotate-90" : ""}`}><Chevron open={false} bold /></span></button>
                )}
                <button
                  type="button"
                  title="Change color"
                  aria-label={`Change color of ${category.name}`}
                  className="block h-3 w-3 shrink-0 cursor-pointer rounded hover:shadow-[0_0_0_2px_var(--color-edge-2)]"
                  style={{ backgroundColor: category.color }}
                  onClick={(event) => {
                    if (colorMenu?.id === category.id) return setColorMenu(null);
                    const rect = event.currentTarget.getBoundingClientRect();
                    setColorMenu({
                      id: category.id,
                      left: Math.max(8, Math.min(rect.left, window.innerWidth - SWATCH_MENU_WIDTH - 8)),
                      top: Math.min(rect.bottom + 6, window.innerHeight - 112),
                    });
                  }}
                />
                {/* Double-click renames as a shortcut. The row's actions menu
                    carries Rename too, since a double-click is invisible to
                    anyone working from the keyboard. */}
                {renaming === category.id ? (
                  <input autoFocus value={renameDraft} aria-label={`Rename ${category.name}`} onChange={(event) => setRenameDraft(event.target.value)} onBlur={() => void saveRename(category)} onKeyDown={(event) => { if (event.key === "Enter") void saveRename(category); else if (event.key === "Escape") setRenaming(null); }} className="w-44 rounded-md border border-control-edge bg-control px-1.5 py-0.5 text-xs font-semibold outline-none focus:border-accent/60" />
                ) : (
                  <span
                    className={`min-w-0 truncate font-semibold ${locked ? "" : "cursor-text"}`}
                    // Opted out of the row toggle only where it is a rename
                    // target. The cursor draws the same line the click does:
                    // a text caret over the name, the pointer everywhere the
                    // bar opens the category — including this name on the one
                    // category that cannot be renamed.
                    data-row-toggle={locked ? undefined : "off"}
                    title={locked ? "The built-in Ignored category cannot be renamed" : "Double-click to rename"}
                    onDoubleClick={locked ? undefined : beginRename}
                  >
                    {category.name}
                  </span>
                )}
                {/* A goal is the category's own property, like its colour and
                    state, so it shows on the header where every goal can be
                    read without opening a category. Right after the name, it
                    reads as the sentence it is: "Work at least 20h/wk". No goal
                    shows nothing: new goals start from the actions menu. The
                    negative margin takes back the hover box's padding, so the
                    words sit a space from the name rather than a column away. */}
                {!locked && !category.isIgnored && category.goal && (
                  <button
                    type="button"
                    title="Edit weekly goal"
                    aria-label={`Weekly goal for ${category.name}: ${goalSummary(category.goal)}. Edit`}
                    className="-ml-2 shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 tabular-nums text-ink-3 hover:bg-hover-2 hover:text-ink-2"
                    onClick={(event) => {
                      if (goalMenu?.id === category.id) return setGoalMenu(null);
                      openGoalEditor(category.id, event.currentTarget.getBoundingClientRect());
                    }}
                  >
                    {goalSummary(category.goal)}
                  </button>
                )}
                <span className="flex-1" />
                {/* The built-in Ignored category has no state to show: its only
                    possible one is its own name, and it cannot be changed. */}
                {!locked && (
                  // As wide as "Unproductive", the longest state, and right
                  // aligned so the menu still ends beside the actions.
                  <span className="flex w-24 shrink-0 justify-end">
                    <MenuSelect
                      variant="bare"
                      size="compact"
                      align="end"
                      className="cursor-pointer capitalize"
                      value={state}
                      onChange={(option) => void setCategoryState(category, option as Productivity)}
                      title={`Set the productivity of ${category.name}`}
                      label={`Productivity of ${category.name}`}
                      // The category's own swatch is the row's colored mark;
                      // a state dot beside it competed for the same job. The
                      // menu keeps its dots.
                      triggerDot={false}
                      // A category left over from when "ignored" was a state here
                      // keeps showing it, via the placeholder, until one of the
                      // three assignable states is chosen.
                      placeholder={state}
                      header={state === "ignored" ? "Ignored is no longer a category state. Pick one to bring this category back into Insights." : undefined}
                      options={ASSIGNABLE_STATES.map((option) => ({
                        value: option,
                        label: stateLabel(option),
                        dot: stateColorMap[option],
                      }))}
                    />
                  </span>
                )}
                {/* The category's own actions, in one menu at the row's end
                    rather than under its rules, so an open category shows only
                    what it contains. Delete keeps words rather than an icon:
                    it cascades over the rules, and destructive weight should
                    scale with blast radius. The built-in Ignored category can
                    do none of these. */}
                {!locked && (
                  <span className="shrink-0">
                    <MenuSelect
                      variant="bare"
                      size="compact"
                      align="end"
                      value=""
                      className="cursor-pointer"
                      label={`Actions for ${category.name}`}
                      title="Category actions"
                      placeholder={
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="my-px">
                          <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
                        </svg>
                      }
                      onChange={(action) => {
                        if (action === "insights") onViewInInsights?.(category);
                        else if (action === "goal") {
                          const header = categoryHeaderRefs.current.get(category.id);
                          if (header) openGoalEditor(category.id, header.getBoundingClientRect());
                        }
                        else if (action === "rename") beginRename();
                        else if (action === "delete") setPendingDelete({ category, ruleCount: allRules.length });
                      }}
                      // Grouped by what each does: leave for Insights; change the
                      // category itself (its name, its goal); remove it.
                      options={[
                        // Insights does not count ignored time, so a category
                        // still carrying the old ignored state has no view.
                        ...(onViewInInsights && !category.isIgnored
                          ? [{ value: "insights", label: "View in Insights" }]
                          : []),
                        { value: "rename", label: "Rename", divider: Boolean(onViewInInsights && !category.isIgnored) },
                        // Ignored time is never counted, so a goal there could
                        // only ever read zero.
                        ...(!category.isIgnored
                          ? [{ value: "goal", label: category.goal ? "Edit weekly goal…" : "Set weekly goal…" }]
                          : []),
                        { value: "delete", label: "Delete category…", divider: true, danger: true },
                      ]}
                    />
                  </span>
                )}
              </div>
              {/* No left padding: the rules' 16px glyph column centers under
                  the header's 12px swatch (12 + 24 + 10 = 46px, less 2), and
                  the patterns start where the category name does. */}
              <Collapsible
                open={open}
                id={`category-rules-${category.id}`}
                className="ml-[44px] border-t border-edge/50 py-3 pr-3"
              >
                {/* A category with thirty rules should not push the ones
                    below it off the screen: past a few rows the list becomes
                    its own quiet scroll well. */}
                {/* A scroll container clips both axes, so the rows' -mx-2
                    hover fill lost its left corners at the well's edge. The
                    well reaches out by the same 8px and pads it back, leaving
                    the rows where they were with room to draw into. */}
                {/* The gutter is reserved whether or not the list scrolls, so
                    the figures' right edge does not shift 6px between a short
                    category and a long one. */}
                <div className="scroll-well -ml-2 flex max-h-[220px] flex-col gap-1.5 overflow-y-auto pl-2 pr-2 [scrollbar-gutter:stable]">
                  {visibleRules.map((rule) => {
                    const editingThis = activeEdit?.ruleId === rule.id;
                    const unused = usage !== null && !usage.has(rule.id);
                    const windowQualifier = rule.matchType === "title"
                      ? `${describeTitleRule({
                          titleMatchMode: rule.titleMatchMode ?? "phrase",
                          titleAnchor: rule.titleAnchor ?? "any",
                        })} · ${titleRuleScopeLabel(rule)}`
                      : null;
                    // Counted over every rule in the category, not only the
                    // ones a search left showing: a twin hidden by the search
                    // still makes this row ambiguous once the search clears.
                    const sharesPattern = windowQualifier !== null && allRules.some(
                      (other) => other.id !== rule.id
                        && other.matchType === "title"
                        && other.pattern === rule.pattern,
                    );
                    return (
                    <div
                      key={rule.id}
                      onDoubleClick={(event) => {
                        if (
                          editingThis
                          || (event.target as HTMLElement).closest("button")
                        ) return;
                        event.preventDefault();
                        beginRuleEdit(rule);
                      }}
                      className={`group/rule -mx-2 flex items-center gap-2 rounded-lg px-2 py-1 text-xs ${
                        editingThis ? "bg-accent/[.06]" : "hover:bg-hover"
                      }`}
                    >
                      {/* The kind as a glyph alone; the word is its tooltip
                          and its accessible name. */}
                      <span
                        className="flex w-4 shrink-0 items-center justify-center text-ink-3"
                        title={`${RULE_LABELS[rule.matchType]} rule`}
                      >
                        <RuleKindGlyph matchType={rule.matchType} />
                        <span className="sr-only">{RULE_LABELS[rule.matchType]}</span>
                      </span>
                      {/* A Window rule's mode and scope live in the pattern's
                          tooltip and in the editor, so a Window row weighs the
                          same as an App or Website row. They come back onto
                          the row only when another Window rule here shares the
                          pattern — then they are what tells the two apart. */}
                      <span
                        className="min-w-0 shrink cursor-text truncate font-mono"
                        title={windowQualifier ?? undefined}
                      >
                        {rule.pattern}
                      </span>
                      {sharesPattern && (
                        <span className="min-w-0 max-w-[45%] shrink-[2] truncate text-ink-3">
                          {windowQualifier}
                        </span>
                      )}
                      <span className="flex-1" />
                      {/* The figure and the row's actions share one slot at
                          the right edge: the actions fade in over it on hover
                          or focus, so the figures line up with the edge
                          instead of stopping short of two invisible buttons.
                          Opacity, not display, so nothing reflows and the
                          buttons stay reachable by keyboard.

                          The time only shows in the order that sorts by it —
                          a sort by a quantity the rows do not show is
                          unreadable. "unused" shows in every order, in the
                          same place, so no row says "0s".

                          The figure's right edge lines up with the header's
                          productivity label: the header's actions trigger
                          (32px), gap (10px) and the label's own padding (8px)
                          come to 50px, less the scroll well's padding (8px)
                          and scrollbar gutter (6px) on this side. The actions
                          take the same inset, so they end where the figure
                          does. */}
                      <span className="grid shrink-0 justify-items-end [&>*]:col-start-1 [&>*]:row-start-1">
                        {(unused || (ruleOrder === "use" && usage?.has(rule.id))) && (
                          <span
                            className={`mr-9 self-center tabular-nums text-ink-3 transition-opacity group-focus-within/rule:pointer-events-none group-focus-within/rule:opacity-0 group-hover/rule:pointer-events-none group-hover/rule:opacity-0 ${
                              editingThis ? "opacity-0" : ""
                            }`}
                            title={unused
                              ? "This rule has not been the winning rule for any stored activity."
                              : "Time this rule decided across all of your history. A rule outranked by a more specific one counts nothing here."}
                          >
                            {unused ? "unused" : fmtDuration(usage?.get(rule.id) ?? 0)}
                          </span>
                        )}
                        <span
                          className={`mr-9 flex items-center gap-0.5 transition-opacity group-focus-within/rule:opacity-100 group-hover/rule:opacity-100 ${
                            editingThis ? "opacity-100" : "opacity-0"
                          }`}
                        >
                          <EditRuleButton rule={rule} onClick={() => beginRuleEdit(rule)} />
                          <RemoveButton label={`Delete ${RULE_LABELS[rule.matchType]} rule ${rule.pattern}`} onClick={() => void removeRule(rule.id)} />
                        </span>
                      </span>
                    </div>
                    );
                  })}
                  {visibleRules.length === 0 && (
                    <p className="py-1 text-xs italic text-ink-3">
                      {normalizedRuleSearch === ""
                        ? "No rules yet — add one below."
                        : "No rules in this category match the search."}
                    </p>
                  )}
                </div>
                {showComposer ? (
                <div
                  ref={(node) => {
                    if (node) categoryEditorRefs.current.set(category.id, node);
                    else categoryEditorRefs.current.delete(category.id);
                  }}
                  className="mt-3"
                >
                  <CategoryRuleForm
                    key={activeEdit ? `edit-${activeEdit.ruleId}` : "add"}
                    draft={activeEdit?.draft ?? draft}
                    onChange={activeEdit
                      ? changeRuleEdit
                      : (patch) => setDraft(category.id, patch)}
                    onSubmit={activeEdit
                      ? () => void saveRuleEdit()
                      : () => void submitRule(category.id)}
                    submitLabel={activeEdit ? "Save" : "Add rule"}
                    onCancel={activeEdit ? () => setEditingRule(null) : closeComposer}
                    source={source}
                    windowTitleCaptureEnabled={
                      meta.settings.record_window_titles === "1"
                    }
                    autoFocus={activeEdit !== null || composerOpen.has(category.id)}
                    replacingRuleId={activeEdit?.ruleId}
                  />
                  {activeEdit?.conflict && (
                    <p className="mt-2 rounded-lg border border-edge/60 bg-surface px-3 py-2 text-xs text-ink-2">
                      {activeEdit.conflict}
                    </p>
                  )}
                  {!activeEdit && ruleConflict?.categoryId === category.id && (
                    <div className="mt-2 flex items-center gap-3 rounded-lg border border-edge/60 bg-surface/45 px-3 py-2 text-xs text-ink-2">
                      <span className="min-w-0 flex-1">
                        {ruleConflict.existingRule.categoryId === category.id
                          ? `This rule already exists in ${category.name}.`
                          : `This rule belongs to ${ruleConflict.existingCategoryName}. Move it to ${category.name}?`}
                      </span>
                      <Button onClick={() => setRuleConflict(null)}>
                        {ruleConflict.existingRule.categoryId === category.id ? "Dismiss" : "Cancel"}
                      </Button>
                      {ruleConflict.existingRule.categoryId !== category.id && (
                        <Button
                          variant="primary"
                          onClick={() => void commitRule(category.id, ruleConflict.draft)}
                        >
                          Move rule
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                ) : !searching && (
                  // A hairline separates the rules that exist from the offer
                  // to add one. The + sits in the rules' glyph column and the
                  // words where the patterns start.
                  <div className="mt-2 border-t border-edge/50 pt-1">
                  <button
                    type="button"
                    onClick={() => setComposerOpen((current) => new Set(current).add(category.id))}
                    className="-mx-2 mt-1 inline-flex items-center gap-2 rounded-lg px-2 py-1 pr-3 text-left text-xs text-ink-3 transition-colors hover:bg-hover hover:text-ink-2"
                  >
                    <span aria-hidden="true" className="flex w-4 justify-center">+</span>
                    Add rule
                  </button>
                  </div>
                )}
              </Collapsible>
            </div>
          );
        })}
        {categoryRows.length === 0 && (
          <p className="py-8 text-center text-xs text-ink-3">
            No rules or categories match “{deferredRuleSearch}”.
          </p>
        )}
      </div>
      {/* One quiet line at the end of the list until a name is wanted. */}
      {addingCategory ? (
        <div className="mt-3 flex items-center gap-2">
          <input
            autoFocus
            value={newName}
            aria-label="New category name"
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitCategory();
              else if (event.key === "Escape") { setNewName(""); setAddingCategory(false); }
            }}
            placeholder="New category name"
            className="min-w-0 w-56 max-w-full shrink rounded-lg border border-control-edge bg-control px-2.5 py-1.5 text-xs outline-none placeholder:text-ink-3 focus:border-accent/60"
          />
          {/* The rule composer's order and shapes, so the two inline forms on
              this screen read alike: Cancel first, and the submit tinted only
              once there is a name to submit. */}
          <Button onClick={() => { setNewName(""); setAddingCategory(false); }}>
            Cancel
          </Button>
          <Button
            variant={newName.trim() ? "primary" : "text"}
            disabled={!newName.trim()}
            onClick={() => void submitCategory()}
          >
            Add category
          </Button>
        </div>
      ) : !searching && (
        <button
          type="button"
          onClick={() => setAddingCategory(true)}
          className="mt-2 flex items-center gap-2.5 self-start rounded-lg py-1.5 pl-3 pr-3 text-left text-xs text-ink-3 transition-colors hover:bg-hover hover:text-ink-2"
        >
          <span aria-hidden="true" className="flex w-6 justify-center">+</span>
          New category
        </button>
      )}
      {colorMenu !== null && createPortal(
        <span
          style={{ left: colorMenu.left, top: colorMenu.top, width: SWATCH_MENU_WIDTH }}
          className="menu-pop fixed z-50 grid grid-cols-5 gap-2 rounded-[11px] border border-raised-edge bg-raised p-2.5 shadow-menu"
        >
          {previewSwatches(meta.palette).map((swatch) => {
            const category = meta.categories.find((item) => item.id === colorMenu.id);
            return (
              <button
                key={swatch}
                type="button"
                aria-label={`Use color ${swatch}`}
                className={`h-4 w-4 rounded hover:shadow-[0_0_0_2px_var(--color-ink-3)] ${swatch === category?.color.toLowerCase() ? "shadow-[0_0_0_2px_var(--color-ink-2)]" : ""}`}
                style={{ backgroundColor: swatch }}
                onClick={() => {
                  setColorMenu(null);
                  if (category) void setCategoryColor(category, swatch);
                }}
              />
            );
          })}
        </span>,
        document.body,
      )}
      {goalMenu !== null && (() => {
        const category = meta.categories.find((item) => item.id === goalMenu.id);
        return category ? (
          <GoalEditor
            categoryName={category.name}
            goal={category.goal}
            left={goalMenu.left}
            top={goalMenu.top}
            onSave={(goal) => void saveGoal(category, goal)}
            onClose={() => setGoalMenu(null)}
          />
        ) : null;
      })()}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete this category?"
          body={
            <>
              <span className="font-semibold text-ink">{pendingDelete.category.name}</span>
              {pendingDelete.ruleCount > 0
                ? " and every rule that assigns it will be removed."
                : " will be removed."}
            </>
          }
          metrics={pendingDelete.ruleCount > 0
            ? [{ label: "Rules removed", value: String(pendingDelete.ruleCount) }]
            : undefined}
          note="Recorded activity is kept — the items in this category become uncategorized. This cannot be undone."
          confirmLabel="Delete category"
          busyLabel="Deleting…"
          busy={deleting}
          onConfirm={() => void removeCategory(pendingDelete.category)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
