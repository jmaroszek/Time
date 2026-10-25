import { useDeferredValue, useEffect, useId, useMemo, useState } from "react";

import {
  Button,
  Checkbox,
  ConfirmDialog,
  DialogShell,
  MenuSelect,
  Radio,
  Spinner,
  type MenuOption,
} from "../../components/ui";
import type {
  ActivitySource,
  ActivityTitleGroup,
  ActivityTriageItem,
} from "../../lib/activity";
import {
  appSuffixNames,
  countNoun,
  describeCorrectionWindow,
  formatVisitDay,
  localInputValue,
  trimAppSuffix,
  visitEditLabel,
} from "../../lib/activityFormat";
import {
  ANY_APP,
  BROWSER_SCOPE,
  type Category,
  type TitleRuleScopeKind,
  type TitleRuleSpec,
} from "../../lib/classify";
import {
  cleanDomainName,
  cleanProcessName,
  fmtDuration,
  fmtDurationTitle,
} from "../../lib/format";
import {
  addRule,
  addTrackingExclusion,
  correctSession,
  deleteActivity,
  fetchSessionCorrection,
  previewActivityDelete,
  previewTrackingExclusion,
  resetSessionCorrection,
  type ActivityDeletePreview,
  type ActivityDeleteRequest,
  type SessionCorrection,
  type TrackingExclusionKind,
} from "../../lib/queries";
import { BackupNameDialog } from "../../components/BackupNameDialog";
import type { StarterSuggestion } from "../../lib/starterSuggestions";
import {
  suggestTitleRuleCandidates,
  titleRuleWindows,
  type TitleRuleCandidate,
  type TitleRuleWindow,
} from "../../lib/titleRuleAnalysis";
import { useBanner } from "../../state/banner";
import Chevron from "./Chevron";
import { categoryDestinationOptions } from "./menuOptions";
import { toggleSetValue } from "../../lib/setUpdates";
import SegmentedPills from "./SegmentedPills";
import {
  RULE_LABELS,
  titleSpecReady,
} from "./ruleComposer";

export type DeleteScope = {
  request: ActivityDeleteRequest;
  label: string;
  span: string | null;
  allHistory: { request: ActivityDeleteRequest; span: string } | null;
};

/**
 * The starter list, offered in one screen.
 *
 * Everything is on the surface: no disclosure, no "advanced", every row already
 * ticked and every row individually changeable or removable. That is the whole
 * bargain — Time recognized these apps, it has not decided anything, and one
 * button turns the recognition into rules the user could have written by hand.
 */
export function StarterSuggestionDialog({
  suggestions,
  categories,
  pendingTotal,
  onClose,
  onDismiss,
  onApply,
}: {
  suggestions: StarterSuggestion<ActivityTriageItem>[];
  categories: Category[];
  pendingTotal: number;
  onClose: () => void;
  onDismiss: (item: ActivityTriageItem) => void;
  onApply: (accepted: StarterSuggestion<ActivityTriageItem>[]) => void;
}) {
  // Ticked by default; unticking is the exception, so the set tracks what has
  // been turned off rather than what has been turned on.
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [moved, setMoved] = useState<Record<string, number>>({});
  const [applying, setApplying] = useState(false);
  const accepted = suggestions
    .filter((suggestion) => !excluded.has(suggestion.entity.id))
    .map((suggestion) => ({
      ...suggestion,
      categoryId: moved[suggestion.entity.id] ?? suggestion.categoryId,
    }));
  const remaining = pendingTotal - accepted.length;
  const toggle = (id: string) =>
    setExcluded((current) => toggleSetValue(current, id));
  return (
    <DialogShell
      onClose={onClose}
      busy={applying}
      labelledBy="starter-suggestions-title"
      className="max-w-lg"
    >
        <h2 id="starter-suggestions-title" className="text-sm font-semibold">
          Classify {suggestions.length} recognized app{suggestions.length === 1 ? "" : "s"}
        </h2>
        {/* Where this came from, in the one place it matters, before any of it
            is applied. "Recognizes" rather than anything about a list shipping
            with Time: the list is names Time can read, and a sentence about it
            arriving with the app reads as though the apps themselves did. */}
        <p className="mt-2 text-xs leading-relaxed text-ink-3">
          Time recognizes these common Windows apps. Each suggestion becomes an ordinary rule
          you can edit or delete afterwards.
        </p>

        <div className="mt-4 space-y-1">
          {suggestions.map((suggestion) => {
            const item = suggestion.entity;
            const categoryId = moved[item.id] ?? suggestion.categoryId;
            const on = !excluded.has(item.id);
            return (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-hover"
              >
                <Checkbox checked={on} onChange={() => toggle(item.id)} align="start">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-xs font-medium text-ink">
                      {item.displayName}
                    </span>
                    <span className="text-micro text-ink-3" title={fmtDurationTitle(item.seconds)}>
                      {fmtDuration(item.seconds)}
                    </span>
                  </span>
                </Checkbox>
                <span className="ml-auto shrink-0">
                  <MenuSelect
                    size="compact"
                    variant="resting"
                    align="end"
                    label={`Category for ${item.displayName}`}
                    value={String(categoryId)}
                    onChange={(value) =>
                      setMoved((current) => ({ ...current, [item.id]: Number(value) }))}
                    options={categoryDestinationOptions(categories)}
                  />
                </span>
                {/* Permanent, like the consolidation notice's. A suggestion that
                    returned after being turned down is what stops the next one
                    from being read. */}
                <button
                  type="button"
                  onClick={() => onDismiss(item)}
                  title={`Never suggest a category for ${item.displayName}`}
                  aria-label={`Never suggest a category for ${item.displayName}`}
                  className="shrink-0 rounded-md px-1.5 py-1 text-xs text-ink-3 hover:text-ink"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>

        {/* Space separates the groups here, not a rule, and matches the gap
            above the list so the dialog reads as evenly spaced rather than
            heavier on one side. The sentence names Unclassified because the
            count is about the section behind this dialog, not about the rows
            just above it.

            It is here at all because the starter list reaches work apps far
            better than it reaches games, and a screen that implied this
            finished the job would leave the reader with a productive share
            flattered by whatever it could not name. */}
        <div className="mt-4">
          {remaining > 0 && (
            <p className="mb-3 text-xs text-ink-3">
              Unclassified will still have {remaining} item{remaining === 1 ? "" : "s"} after this.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button disabled={applying} onClick={onClose}>Not now</Button>
            <Button
              variant="primary"
              disabled={applying || accepted.length === 0}
              onClick={() => {
                setApplying(true);
                onApply(accepted);
              }}
            >
              {applying
                ? "Classifying…"
                : `Classify ${accepted.length} app${accepted.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
    </DialogShell>
  );
}

export function TrackingExclusionDialog({
  scope,
  onClose,
  onAdded,
}: {
  scope: { kind: TrackingExclusionKind; pattern: string; label: string };
  onClose: () => void;
  onAdded: (deletedHistory: boolean) => void;
}) {
  const banner = useBanner();
  const [preview, setPreview] = useState<{ count: number; seconds: number; normalizedPattern: string } | null>(null);
  const [deleteHistory, setDeleteHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void previewTrackingExclusion(scope.kind, scope.pattern).then(
      (value) => { if (!cancelled) setPreview(value); },
      (error) => { if (!cancelled) { banner.report(error, "tracking exclusion"); onClose(); } },
    );
    return () => { cancelled = true; };
  }, [scope]);
  const save = async () => {
    setSaving(true);
    try {
      const result = await addTrackingExclusion(scope.kind, scope.pattern, deleteHistory);
      banner.show(
        deleteHistory
          ? `Future tracking stopped and ${result.deletedCount} recorded visit${result.deletedCount === 1 ? " was" : "s were"} deleted.`
          : `Time will no longer track ${scope.label}.`,
      );
      onAdded(deleteHistory);
    } catch (error) {
      banner.report(error, "tracking exclusion");
      setSaving(false);
    }
  };
  return (
    <DialogShell onClose={onClose} busy={saving} labelledBy="exclude-title">
        <h2 id="exclude-title" className="text-sm font-semibold">Do not track {scope.label}</h2>
        <p className="mt-2 text-xs leading-relaxed text-ink-3">This exact {scope.kind === "website" ? "website" : "app"} identity will be excluded whenever recording is enabled.</p>
        <p className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 font-mono text-xs text-ink-2">{preview?.normalizedPattern ?? scope.pattern}</p>
        {scope.kind === "website" && <p className="mt-2 text-xs text-ink-3">Website exclusions work only when Time can detect the browser domain.</p>}
        <Checkbox
          checked={deleteHistory}
          onChange={setDeleteHistory}
          align="start"
          className="mt-4 rounded-lg border border-bad/20 bg-bad/[.035] p-3 text-xs leading-snug text-ink-2"
        >
          <span><span className="block font-medium">Also delete existing history</span>{preview ? `${preview.count} visit${preview.count === 1 ? "" : "s"} · ${fmtDuration(preview.seconds)}. This cannot be undone without a backup.` : "Checking matching history…"}</span>
        </Checkbox>
        <div className="mt-5 flex justify-end gap-2"><Button disabled={saving} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={saving || !preview} onClick={() => void save()}>{saving ? "Saving…" : "Add exclusion"}</Button></div>
    </DialogShell>
  );
}

/**
 * Says what room a correction actually has, before anything is typed.
 *
 * A corrected span may not overlap another recording. Because the tracker
 * records continuously while the machine is on, the neighbours usually sit
 * flush against the visit, so the honest answer is normally "you can shorten
 * this, not lengthen it" — which is exactly what someone needs to know first
 * and what the old dialog only revealed by rejecting the save.
 */
/**
 * Turn a window someone just found into a standing rule.
 *
 * This is the flow that makes Window rules discoverable at all: they are the
 * only rule kind whose pattern is a fragment of something rather than a whole
 * identity, so nobody guesses them from an empty text field. Starting from a
 * concrete window means the pattern and the scope both have obvious defaults.
 *
 * Scope defaults to the exact website when one is known, otherwise the exact
 * process. "Project Atlas" in an editor is a project; in a browser it might be
 * anything. A broader reading must be a deliberate choice, so it is offered
 * only beside typed text.
 *
 * The screen holds two decisions — what to match, and the category — and
 * nothing else by default. The suggestions are worded choices rather than
 * patterns with statistics, each with the one number that tells them apart:
 * how many windows it takes, which opens into the titles themselves. The only
 * consequence worth a line unasked is a window the rule would pull out of
 * another category.
 */
export function WindowRuleDialog({
  group,
  categories,
  source,
  browserProcesses,
  onClose,
  onSaved,
}: {
  group: ActivityTitleGroup;
  categories: Category[];
  source: ActivitySource | null;
  browserProcesses: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const banner = useBanner();
  const radioName = useId();
  const [choices, setChoices] = useState<WindowRuleChoice[] | null>(null);
  const [choiceId, setChoiceId] = useState(OTHER_CHOICE);
  const [customPattern, setCustomPattern] = useState("");
  const [customScope, setCustomScope] = useState(() => {
    const scope = defaultWindowRuleScope(group);
    return encodeTitleScope(scope.scopeKind, scope.scopeValue);
  });
  const [customWindows, setCustomWindows] = useState<TitleRuleWindow[] | null>(null);
  const [openList, setOpenList] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setChoices(null);
    if (!source) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const next = windowRuleChoices(source, group);
      if (cancelled) return;
      setChoices(next);
      setChoiceId(next[0]?.id ?? OTHER_CHOICE);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, group.key]);

  // Whole words, not any text: a fragment as short as "art" also takes
  // "start" and "party", and the count below is the only warning it gets.
  const customSpec = useMemo<TitleRuleSpec | null>(
    () => customPattern.trim()
      ? {
        pattern: customPattern,
        ...decodeTitleScope(customScope),
        titleMatchMode: "phrase",
        titleAnchor: "any",
      }
      : null,
    [customPattern, customScope],
  );
  // Deferred so typing stays responsive when the history is large.
  const deferredCustomSpec = useDeferredValue(customSpec);
  useEffect(() => {
    setCustomWindows(null);
    if (!source || !deferredCustomSpec || !titleSpecReady(deferredCustomSpec)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const next = titleRuleWindows(source, deferredCustomSpec);
      if (!cancelled) setCustomWindows(next);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, deferredCustomSpec]);

  const chosen = choices?.find((choice) => choice.id === choiceId) ?? null;
  const spec = choiceId === OTHER_CHOICE ? customSpec : chosen?.spec ?? null;
  // Null while the count for what is typed now is still being made, so a stale
  // count never stands beside new text.
  const typedWindows = customSpec !== null && deferredCustomSpec === customSpec ? customWindows : null;
  const windows = choiceId === OTHER_CHOICE ? typedWindows : chosen?.windows ?? null;
  const appNames = appSuffixNames(group.displayName, group.entityKey);
  const repeats = choices?.some((choice) => choice.windows.length > 1) ?? true;
  const ruleKind = group.entityKind === "website" ? "Website" : "App";
  const moving = strayWindows(windows ?? [], group, categoryId);

  const save = async () => {
    if (!spec) return;
    setSaving(true);
    try {
      await addRule("title", spec.pattern, Number(categoryId), spec);
      banner.show(`Window rule “${spec.pattern.trim()}” added.`);
      onSaved();
    } catch (error) {
      banner.report(error, "rule");
      setSaving(false);
    }
  };
  const saveBroadRule = async () => {
    setSaving(true);
    try {
      const matchType = group.entityKind === "website" ? "domain" : "process";
      await addRule(matchType, group.entityKey, Number(categoryId));
      banner.show(`${RULE_LABELS[matchType]} rule for ${group.displayName} added.`);
      onSaved();
    } catch (error) {
      banner.report(error, "rule");
      setSaving(false);
    }
  };
  const rows = [
    ...(choices ?? []).map((choice) => ({
      id: choice.id,
      label: choiceLabel(choice.spec, group.title),
      windows: choice.windows as TitleRuleWindow[] | null,
    })),
    { id: OTHER_CHOICE, label: "something else…", windows: typedWindows },
  ];

  return (
    <DialogShell
      onClose={onClose}
      busy={saving}
      labelledBy="window-rule-title"
      className="max-w-md"
    >
        <h2 id="window-rule-title" className="text-sm font-semibold">New Window rule</h2>
        <p className="mt-1 text-xs text-ink-3">{group.displayName} windows whose title…</p>

        {choices === null ? (
          <div className="mt-3">
            <Spinner label="Comparing with your title history…" />
          </div>
        ) : (
          <div role="radiogroup" aria-label="Which windows" className="-mx-1.5 mt-2">
            {rows.map((row) => {
              const checked = choiceId === row.id;
              const showCount = row.id !== OTHER_CHOICE || customSpec !== null;
              return (
                <div key={row.id}>
                  <div className="flex items-center gap-2 rounded-md px-1.5 hover:bg-hover-2">
                    <Radio
                      name={radioName}
                      checked={checked}
                      onChange={() => setChoiceId(row.id)}
                      className="min-w-0 flex-1 py-1.5 text-xs"
                    >
                      <span className={`truncate ${checked ? "text-ink" : "text-ink-2"}`}>{row.label}</span>
                    </Radio>
                    {showCount && (
                      row.windows === null ? (
                        <span className="shrink-0 text-xs text-ink-3">…</span>
                      ) : (
                        // Opening the list leaves the choice alone: it is how
                        // the choices get compared.
                        <button
                          type="button"
                          onClick={() => setOpenList(openList === row.id ? null : row.id)}
                          aria-expanded={openList === row.id}
                          title="Show the windows"
                          className={`shrink-0 rounded text-xs tabular-nums underline-offset-2 hover:text-ink-2 hover:underline ${
                            row.windows.length === 0 ? "text-bad" : "text-ink-3"
                          }`}
                        >
                          {countNoun(row.windows.length, "window")}
                        </button>
                      )
                    )}
                  </div>

                  {row.id === OTHER_CHOICE && checked && (
                    <div className="mb-1.5 ml-6 mr-1.5 mt-0.5 flex items-center gap-2">
                      <input
                        autoFocus={choices.length > 0}
                        value={customPattern}
                        onChange={(event) => setCustomPattern(event.target.value)}
                        placeholder="Words in the title"
                        aria-label="Words in the title"
                        className="min-w-0 flex-1 rounded-lg border border-control-edge bg-control px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent/60"
                      />
                      <span className="shrink-0 text-xs text-ink-3">in</span>
                      <MenuSelect
                        size="compact"
                        variant="resting"
                        align="end"
                        value={customScope}
                        onChange={setCustomScope}
                        label="Which apps"
                        options={titleRuleScopeOptions(group, browserProcesses)}
                      />
                    </div>
                  )}

                  {openList === row.id && row.windows !== null && (
                    <WindowTitleList windows={row.windows} appNames={appNames} />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!repeats && (
          <p className="mt-2 text-xs leading-snug text-ink-3">
            Nothing in this title repeats in other {group.displayName} windows. To
            put all of {group.displayName} in one category,{" "}
            <button
              type="button"
              disabled={saving || !categoryId}
              title={categoryId ? undefined : "Choose a category first"}
              onClick={() => void saveBroadRule()}
              className="cursor-pointer font-semibold text-ink-2 underline-offset-2 enabled:hover:text-accent enabled:hover:underline disabled:cursor-default"
            >
              use {ruleKind === "App" ? "an" : "a"} {ruleKind} rule instead
            </button>.
          </p>
        )}

        <MenuSelect
          size="field"
          className="mt-4 w-full"
          value={categoryId}
          onChange={setCategoryId}
          label="Category"
          placeholder="Choose a category"
          options={categoryDestinationOptions(categories)}
        />
        {moving.length > 0 && (
          <p className="mt-2 text-xs leading-snug text-warn">
            {strayMessage(moving, categories, appNames)}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={saving} onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving || !spec || !categoryId || !titleSpecReady(spec)}
            title={categoryId ? undefined : "Choose a category first"}
            onClick={() => void save()}
          >
            {saving ? "Adding…" : "Add rule"}
          </Button>
        </div>
    </DialogShell>
  );
}

/** The radio row for typed text, beside the suggestions' candidate ids. */
const OTHER_CHOICE = "other";

/** The most windows a count opens into; past that the list stops being read. */
const WINDOW_LIST_CAP = 5;

type WindowRuleChoice = { id: string; spec: TitleRuleSpec; windows: TitleRuleWindow[] };

/**
 * The suggestions as choices, each with the windows it would take.
 *
 * A choice that takes exactly the windows of one above it is dropped, and so
 * is one that takes none: two options with the same effect, or one with no
 * effect, are not a choice.
 */
function windowRuleChoices(source: ActivitySource, group: ActivityTitleGroup): WindowRuleChoice[] {
  const candidates = suggestTitleRuleCandidates(
    source,
    group.title,
    defaultWindowRuleScope(group),
    [group.displayName, group.entityKey],
  );
  const seen = new Set<string>();
  const choices: WindowRuleChoice[] = [];
  for (const candidate of candidates) {
    const spec = ruleSpecFromCandidate(candidate);
    const windows = titleRuleWindows(source, spec);
    const reach = windows.map((window) => window.key).sort().join("\n");
    if (windows.length === 0 || seen.has(reach)) continue;
    seen.add(reach);
    choices.push({ id: candidate.id, spec, windows });
  }
  return choices;
}

/** A choice in words, finishing "… windows whose title". The pattern is shown
 *  as this title spells it where it can be found, since stored patterns are
 *  normalized to lower case. */
function choiceLabel(spec: TitleRuleSpec, title: string): string {
  const at = title.toLowerCase().indexOf(spec.pattern.toLowerCase());
  const shown = `“${at < 0 ? spec.pattern : title.slice(at, at + spec.pattern.length)}”`;
  if (spec.titleMatchMode === "phrase") return `contains ${shown}`;
  if (spec.titleMatchMode === "contains") return `contains ${shown} anywhere`;
  if (spec.titleAnchor === "first") return `starts with ${shown}`;
  if (spec.titleAnchor === "last") return `ends with ${shown}`;
  if (spec.titleAnchor === "interior") return `has ${shown} in the middle`;
  return `has a ${shown} section`;
}

/** Windows the rule would take out of a category other than this window's and
 *  the one chosen. Nothing moves before a category is chosen. */
function strayWindows(
  windows: TitleRuleWindow[],
  group: ActivityTitleGroup,
  categoryId: string,
): TitleRuleWindow[] {
  if (!categoryId) return [];
  return windows.filter((window) =>
    window.key !== group.key
    && window.categoryId !== null
    && window.categoryId !== group.categoryId
    && window.categoryId !== Number(categoryId));
}

function strayMessage(moving: TitleRuleWindow[], categories: Category[], appNames: string[]): string {
  const from = new Set(moving.map((window) => window.categoryId));
  const only = from.size === 1
    ? categories.find((category) => category.id === moving[0].categoryId)?.name ?? null
    : null;
  const out = only ? `out of ${only}` : "out of other categories";
  return moving.length === 1
    ? `Also moves “${trimAppSuffix(moving[0].title, appNames)}” ${out}.`
    : `Also moves ${countNoun(moving.length, "window")} ${out}.`;
}

function WindowTitleList({ windows, appNames }: { windows: TitleRuleWindow[]; appNames: string[] }) {
  if (windows.length === 0) {
    return <p className="mb-1.5 ml-7 text-xs text-ink-3">No window has these words in its title.</p>;
  }
  return (
    <ul className="mb-1.5 ml-7 mr-1.5 grid gap-0.5">
      {windows.slice(0, WINDOW_LIST_CAP).map((window) => (
        <li key={window.key} className="truncate text-xs text-ink-3" title={window.title}>
          {trimAppSuffix(window.title, appNames)}
        </li>
      ))}
      {windows.length > WINDOW_LIST_CAP && (
        <li className="text-xs text-ink-3">and {windows.length - WINDOW_LIST_CAP} more</li>
      )}
    </ul>
  );
}

function defaultWindowRuleScope(group: ActivityTitleGroup): Pick<TitleRuleSpec, "scopeKind" | "scopeValue"> {
  return {
    scopeKind: group.entityKind === "website" ? "domain" : "process",
    scopeValue: group.entityKey.toLowerCase(),
  };
}

function encodeTitleScope(kind: TitleRuleScopeKind, value: string): string {
  return `${kind}:${value}`;
}

function decodeTitleScope(value: string): Pick<TitleRuleSpec, "scopeKind" | "scopeValue"> {
  const colon = value.indexOf(":");
  const scopeKind = value.slice(0, colon) as TitleRuleScopeKind;
  return { scopeKind, scopeValue: value.slice(colon + 1) };
}

/** Where typed text applies, worded to follow "in". */
function titleRuleScopeOptions(
  group: ActivityTitleGroup,
  browserProcesses: string[],
): MenuOption[] {
  const process = group.sessions[0]?.process.toLowerCase();
  const options: MenuOption[] = [];
  if (group.entityKind === "website") {
    options.push({
      value: encodeTitleScope("domain", group.entityKey),
      label: group.entityKey,
    });
  } else {
    options.push({
      value: encodeTitleScope("process", group.entityKey),
      label: group.displayName,
    });
  }
  if (
    process &&
    group.entityKind === "website"
  ) {
    options.push({
      value: encodeTitleScope("process", process),
      label: `this browser (${process})`,
    });
  }
  if (group.entityKind === "website" || (process && browserProcesses.includes(process))) {
    options.push({ value: encodeTitleScope(BROWSER_SCOPE, ""), label: "any browser" });
  }
  options.push({ value: encodeTitleScope(ANY_APP, ""), label: "any app" });
  return options;
}

function ruleSpecFromCandidate(candidate: TitleRuleCandidate): TitleRuleSpec {
  return {
    pattern: candidate.pattern,
    scopeKind: candidate.scopeKind,
    scopeValue: candidate.scopeValue,
    titleMatchMode: candidate.titleMatchMode,
    titleAnchor: candidate.titleAnchor,
  };
}

/** A visit's clock time as its row shows it; seconds where two edited times
 *  could otherwise read the same. */
function visitClock(seconds: number, withSeconds = false): string {
  return new Date(seconds * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
  });
}

export function SessionCorrectionDialog({
  sessionId,
  categories,
  aliases,
  onClose,
}: {
  sessionId: number;
  categories: Category[];
  aliases: Record<string, string>;
  onClose: () => void;
}) {
  const banner = useBanner();
  const [session, setSession] = useState<SessionCorrection | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [saving, setSaving] = useState(false);
  // Folded by default. Reclassifying is the routine reason to open this dialog;
  // the recorded times are a repair for the rare occasion the clock went wrong,
  // and leading with them made the common action look like the afterthought.
  const [editingTimes, setEditingTimes] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetchSessionCorrection(sessionId).then(
      (value) => {
        if (cancelled) return;
        setSession(value);
        setStart(localInputValue(value.start));
        setEnd(localInputValue(value.end));
        setCategoryId(value.categoryId == null ? "" : String(value.categoryId));
      },
      (error) => { if (!cancelled) { banner.report(error, "visit"); onClose(); } },
    );
    return () => { cancelled = true; };
  }, [sessionId]);
  const save = async () => {
    if (!session) return;
    const startSec = new Date(start).getTime() / 1000;
    const endSec = new Date(end).getTime() / 1000;
    setSaving(true);
    try {
      await correctSession({
        sessionId,
        startSec,
        endSec,
        categoryId: categoryId ? Number(categoryId) : null,
      });
      banner.show("Visit updated.");
      onClose();
    } catch (error) {
      banner.report(error, "visit");
      setSaving(false);
    }
  };
  const reset = async () => {
    setSaving(true);
    try {
      await resetSessionCorrection(sessionId);
      banner.show("Visit restored to what was recorded.");
      onClose();
    } catch (error) {
      banner.report(error, "visit");
      setSaving(false);
    }
  };
  const locked = session !== null && (session.isLive || session.isAfk);
  const timesEdited = session !== null
    && (session.start !== session.originalStart || session.end !== session.originalEnd);
  // A category on the correction row is a session override, which is what the
  // row's "Reclassified" tag is drawn from.
  const name = !session
    ? ""
    : session.domain
      ? cleanDomainName(session.domain, aliases)
      : cleanProcessName(session.process, aliases);
  const editLabel = session && visitEditLabel({
    isCorrected: session.isCorrected,
    classificationSource: session.categoryId == null ? "none" : "session_override",
  });
  return (
    <DialogShell
      onClose={onClose}
      busy={saving}
      labelledBy="correction-title"
      describedBy="correction-intro"
      className="max-w-lg"
    >
        {/* "Correct" named the rare half of this dialog and misnamed the
            common one. Setting a category on an afternoon is not repairing a
            mistake, and the row this writes to says "Reclassified" — so the
            button that opens it, the dialog, and the tag it produces are one
            vocabulary now. "Visit" for the same reason: "session" is the
            tracker's storage unit, and every list this dialog is opened from
            counts visits. */}
        <h2 id="correction-title" className="text-sm font-semibold">Edit visit</h2>
        <p id="correction-intro" className="mt-2 text-xs leading-relaxed text-ink-3">
          Changes apply to this visit only. Your rules stay as they are.
        </p>
        {!session ? <div className="py-10"><Spinner /></div> : (
          <>
            {/* The same anatomy as the Window rule dialog's card, and the same
                name and tag the row it was opened from shows. A raw process
                name and no time left the reader to work out which visit this
                was, when the row they clicked is identified by its time. */}
            <div className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs">
              <p className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                {editLabel && (
                  <span className="shrink-0 rounded-full bg-accent/10 px-1.5 py-[1px] text-xs text-accent">
                    {editLabel}
                  </span>
                )}
              </p>
              <p className="mt-1 tabular-nums text-ink-3">
                {formatVisitDay(session.start)} · {visitClock(session.start)}–{visitClock(session.end)} · {fmtDuration(Math.max(0, session.end - session.start))}
              </p>
              {/* Apps that title their window with their own name (ChatGPT,
                  Spotify) would repeat the line above. */}
              {session.title && session.title.trim().toLowerCase() !== name.toLowerCase() && (
                <p className="mt-1 truncate text-ink-3" title={session.title}>{session.title}</p>
              )}
            </div>
            {/* A state, not a failure: the warn tone the app's notices use. */}
            {locked && (
              <p className="mt-3 flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/[.08] px-3 py-2 text-xs text-ink-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-warn" />
                {session.isLive ? "The visit in progress cannot be edited." : "Away time cannot be edited."}
              </p>
            )}
            {/* Category leads: it is why this dialog is normally opened, it
                always succeeds, and it is the app's actual subject. */}
            <div className="mt-4 text-xs text-ink-3">
              <span>Category</span>
              <MenuSelect
                size="field"
                className="mt-1 w-full"
                value={categoryId}
                onChange={setCategoryId}
                label="Category"
                disabled={locked}
                options={[
                  { value: "", label: "Use automatic classification" },
                  ...categoryDestinationOptions(categories, null, { dividerOffset: 1 }),
                ]}
              />
            </div>

            {/* Set in a control's ink, as the Window rule dialog's Advanced
                toggle is: in the labels' grey it read as a third heading. */}
            <button
              type="button"
              onClick={() => setEditingTimes((open) => !open)}
              aria-expanded={editingTimes}
              disabled={locked}
              className="mt-4 flex items-center gap-1.5 rounded-md text-xs text-ink-2 transition-colors hover:text-ink disabled:cursor-default disabled:opacity-40"
            >
              <Chevron open={editingTimes} />
              Adjust recorded times
            </button>
            {editingTimes && !locked && (
              <div className="mt-2 rounded-lg border border-edge bg-surface-2 p-3">
                {/* Stated before the edit rather than after it fails. The
                    tracker records continuously, so the gap around a session
                    is usually the session itself — meaning it can be
                    shortened but almost never extended, which is worth
                    knowing before typing a time. */}
                <p className="text-xs leading-snug text-ink-3">
                  {describeCorrectionWindow(session)} Times use your local timezone and cannot end in the future.
                </p>
                {/* What Reset edits would restore. */}
                {timesEdited && (
                  <p className="mt-1.5 text-xs leading-snug tabular-nums text-ink-3">
                    Originally recorded {visitClock(session.originalStart, true)}–{visitClock(session.originalEnd, true)}.
                  </p>
                )}
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="text-xs text-ink-3">
                    Start
                    <input
                      type="datetime-local"
                      step="1"
                      value={start}
                      min={session.earliestStart == null ? undefined : localInputValue(session.earliestStart)}
                      max={end}
                      onChange={(event) => setStart(event.target.value)}
                      className="mt-1 block w-full rounded-lg border border-control-edge bg-control px-2.5 py-2 text-xs tabular-nums text-ink outline-none focus:border-accent/60"
                    />
                  </label>
                  <label className="text-xs text-ink-3">
                    End
                    <input
                      type="datetime-local"
                      step="1"
                      value={end}
                      min={start}
                      max={session.latestEnd == null ? undefined : localInputValue(session.latestEnd)}
                      onChange={(event) => setEnd(event.target.value)}
                      className="mt-1 block w-full rounded-lg border border-control-edge bg-control px-2.5 py-2 text-xs tabular-nums text-ink outline-none focus:border-accent/60"
                    />
                  </label>
                </div>
              </div>
            )}

            {/* Reset reverts this dialog's own edits and destroys nothing
                recorded, so it takes Settings' text action rather than the
                red reserved for the button that deletes. */}
            <div className="mt-5 flex items-center gap-2">
              {session.isCorrected && (
                <Button variant="text" disabled={saving} onClick={() => void reset()}>
                  Reset edits
                </Button>
              )}
              <span className="flex-1" />
              <Button disabled={saving} onClick={onClose}>Cancel</Button>
              <Button
                variant="primary"
                disabled={saving || locked || !start || !end}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </>
        )}
    </DialogShell>
  );
}

export function DeleteActivityDialog({
  scope,
  onClose,
  onDeleted,
}: {
  scope: DeleteScope;
  onClose: () => void;
  onDeleted: (request: ActivityDeleteRequest) => void;
}) {
  const banner = useBanner();
  const [preview, setPreview] = useState<ActivityDeletePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [backupNameOpen, setBackupNameOpen] = useState(false);
  // Always opens on the narrower of the two. Widening is a decision someone
  // has to make on purpose, and it is one keystroke away either way.
  const [wide, setWide] = useState(false);
  const widened = wide && scope.allHistory ? scope.allHistory : null;
  const active = widened ?? scope;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void previewActivityDelete(active.request).then(
      (value) => { if (!cancelled) { setPreview(value); setLoading(false); } },
      (error) => { if (!cancelled) { setLoading(false); banner.report(error, "deletion preview"); onClose(); } },
    );
    return () => { cancelled = true; };
  }, [active]);
  const confirm = async () => {
    if (!preview || preview.count === 0) return;
    setDeleting(true);
    try {
      const request = {
        ...active.request,
        snapshotMaxId: preview.snapshotMaxId,
        previewProtectedSessionId: preview.protectedSessionId,
      } as ActivityDeleteRequest & { snapshotMaxId: number };
      const result = await deleteActivity(request);
      if (result.protectedCount > 0) {
        banner.show(`${result.protectedCount} current live session was kept. Pause recording and retry after it closes if you need to remove it.`);
      }
      onDeleted(active.request);
    } catch (error) {
      banner.report(error, "activity deletion");
      setDeleting(false);
    }
  };
  return (
    <>
    <ConfirmDialog
      title="Delete recorded activity?"
      body={(
        <>
          {scope.allHistory && (
            <SegmentedPills
              label="Deletion range"
              value={wide}
              options={[
                { value: false, label: "Selected range" },
                { value: true, label: "All history" },
              ]}
              onChange={setWide}
              disabled={deleting}
              className="bg-surface-2"
              buttonClassName="flex-1 px-2.5"
              selectedClassName="bg-selected-strong text-ink"
            />
          )}
          {loading || !preview ? (
            <div className="py-8"><Spinner label="Checking deletion scope…" /></div>
          ) : (
            <>
              <p className={scope.allHistory ? "mt-3 text-ink-2" : "text-ink-2"}>
                {scope.label}
              </p>
              {active.span && (
                <p className="mt-1 tabular-nums text-ink-3">{active.span}</p>
              )}
              {preview.protectedCount > 0 && (
                <p className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-ink-2">
                  {preview.protectedCount} current live session is protected. Pause recording and
                  retry after it closes if you need to remove it.
                </p>
              )}
              {preview.count === 0 && (
                <p className="mt-3 text-ink-3">There are no deletable sessions in this scope.</p>
              )}
            </>
          )}
        </>
      )}
      metrics={preview && !loading ? [
        { label: "Visits", value: String(preview.count) },
        { label: "Recorded time", value: fmtDuration(preview.seconds) },
      ] : undefined}
      note={preview && !loading
        ? "Complete session rows are removed, securely compacted, and cannot be restored unless you have a backup."
        : undefined}
      extraAction={(
        <Button
          disabled={deleting}
          onClick={() => setBackupNameOpen(true)}
        >
          Back up first
        </Button>
      )}
      confirmLabel="Delete"
      busyLabel="Deleting…"
      busy={deleting}
      confirmDisabled={loading || !preview || preview.count === 0}
      onConfirm={() => void confirm()}
      onClose={onClose}
    />
    {backupNameOpen && (
      <BackupNameDialog
        onClose={() => setBackupNameOpen(false)}
        onSaved={(target) => banner.show(`Backup saved to ${target}`)}
      />
    )}
    </>
  );
}

/**
 * The match preview under one category's rule draft.
 *
 * A component per draft rather than one shared count, so the effect's only
 * dependency is that draft's own object: typing in one category cannot re-run
 * the pass over history that another category's half-written rule started.
 */
