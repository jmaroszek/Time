import { useDeferredValue, useEffect, useState } from "react";

import {
  Button,
  Checkbox,
  ConfirmDialog,
  DialogShell,
  MenuSelect,
  Spinner,
  type MenuOption,
} from "../../components/ui";
import type {
  ActivitySource,
  ActivityTitleGroup,
  ActivityTriageItem,
} from "../../lib/activity";
import {
  defaultRulePattern,
  describeCorrectionWindow,
  localInputValue,
  showBroadMatchWarning,
} from "../../lib/activityFormat";
import {
  ANY_APP,
  BROWSER_SCOPE,
  type Category,
  type TitleRuleScopeKind,
  type TitleRuleSpec,
} from "../../lib/classify";
import {
  describeTitleRule,
  explainTitleMatchAgainstTitle,
  TITLE_MATCH_MODE_OPTIONS,
} from "../../lib/categoryRules";
import { fmtDuration } from "../../lib/format";
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
  previewTitleRule,
  suggestTitleRuleCandidates,
  type TitleRuleCandidate,
  type TitleRulePreview,
} from "../../lib/titleRuleAnalysis";
import { useBanner } from "../../state/banner";
import Chevron from "./Chevron";
import { categoryDestinationOptions } from "./menuOptions";
import { toggleSetValue } from "../../lib/setUpdates";
import SegmentedPills from "./SegmentedPills";
import {
  BroadMatchWarning,
  RULE_LABELS,
  RulePreviewText,
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
                    <span className="text-micro text-ink-3">
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
 * process. "Skill Tree" in an editor is a project; in a browser it might be
 * anything. A broader reading must be a deliberate choice.
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
  const [spec, setSpec] = useState<TitleRuleSpec>(() => defaultWindowRuleSpec(group));
  const [candidates, setCandidates] = useState<TitleRuleCandidate[] | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [preview, setPreview] = useState<TitleRulePreview | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCandidates(null);
    setSelectedCandidateId("");
    if (!source) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const next = suggestTitleRuleCandidates(
        source,
        group.title,
        { scopeKind: spec.scopeKind, scopeValue: spec.scopeValue },
        [group.displayName, group.entityKey],
      );
      if (cancelled) return;
      setCandidates(next);
      if (next[0]) {
        setSpec(ruleSpecFromCandidate(next[0]));
        setSelectedCandidateId(next[0].id);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, group.key, spec.scopeKind, spec.scopeValue]);

  // Count against all history, like the rule list's "unused" tag. Deferring
  // keeps typing in Advanced responsive even when the history is large.
  const deferredSpec = useDeferredValue(spec);
  useEffect(() => {
    setPreview(null);
    if (!source || !deferredSpec.pattern.trim() || !titleSpecReady(deferredSpec)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const next = previewTitleRule(source, deferredSpec);
      if (!cancelled) setPreview(next);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, deferredSpec]);

  const chooseCandidate = (candidate: TitleRuleCandidate) => {
    setSpec(ruleSpecFromCandidate(candidate));
    setSelectedCandidateId(candidate.id);
  };
  const changeSpec = (patch: Partial<TitleRuleSpec>) => {
    setSelectedCandidateId("");
    setSpec((current) => {
      const next = { ...current, ...patch };
      return next.titleMatchMode === "segment"
        ? next
        : { ...next, titleAnchor: "any" };
    });
  };

  const save = async () => {
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
  const scopeOptions = titleRuleScopeOptions(group, browserProcesses);
  const encodedScope = encodeTitleScope(spec.scopeKind, spec.scopeValue);

  return (
    <DialogShell
      onClose={onClose}
      busy={saving}
      labelledBy="window-rule-title"
      className="max-w-xl"
    >
        <h2 id="window-rule-title" className="text-sm font-semibold">New Window rule</h2>
        {/* "the other windows you mean" asked the reader to hold a set in their
            head that nothing on screen had shown them yet. Each suggestion
            below states its own reach, so the intro only has to say what the
            choice is. */}
        <p className="mt-1 text-xs text-ink-3">
          Choose the part of this title to match on. The rule applies to past and
          future activity.
        </p>

        <div className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs">
          <p className="truncate font-medium" title={group.title}>{group.title}</p>
          <p className="mt-1 text-ink-3">
            {group.displayName} · {group.sessionCount} visit{group.sessionCount === 1 ? "" : "s"} · {fmtDuration(group.seconds)} in range
          </p>
        </div>

        {/* What the rule does, before how it matches. That also puts the two
            matching controls next to each other, where the advanced one reads
            as an extension of the suggestions rather than a third unrelated
            step. */}
        <div className="mt-4 text-xs text-ink-3">
          <span>Category</span>
          <MenuSelect
            size="field"
            className="mt-1 w-full"
            value={categoryId}
            onChange={setCategoryId}
            label="Category"
            options={[
              { value: "", label: "Choose a category…" },
              ...categories.map((category, i) => ({
                value: String(category.id),
                label: category.name,
                divider: i === 0,
              })),
            ]}
          />
        </div>

        <div className="mt-4">
          <p className="text-xs text-ink-3">Suggested matches</p>
          {candidates === null ? (
            <div className="mt-2 rounded-lg border border-edge bg-surface-2 px-3 py-3">
              <Spinner label="Comparing with your title history…" />
            </div>
          ) : candidates.length > 0 ? (
            <div className="mt-2 grid gap-2">
              {candidates.map((candidate) => {
                const selected = selectedCandidateId === candidate.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                      selected
                        ? "border-accent/60 bg-accent/[.08]"
                        : "border-edge bg-surface-2 hover:border-edge-2"
                    }`}
                    onClick={() => chooseCandidate(candidate)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {candidate.pattern}
                      </span>
                      {candidate.recommended && (
                        <span className="rounded-full bg-surface-3 px-1.5 py-[1px] text-xs text-ink-2">
                          recommended
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-xs text-ink-3">
                      {describeTitleRule(candidate)} · {Math.round(candidate.reach * 100)}% of
                      titled windows in this scope · {candidate.days} active{" "}
                      {candidate.days === 1 ? "day" : "days"}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="mt-2 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs leading-snug text-ink-3">
              This title has no durable, reusable part in the selected scope. Use
              an App or Website rule if all of {group.displayName} belongs together,
              or open Advanced to write a precise rule yourself.
            </p>
          )}
        </div>

        {/* A chevron and the ink of a control. Set in the same size and grey
            as the "Category" and "Suggested matches" labels above it, this read
            as a third heading — the one thing in the dialog that did something
            looked like the two things that did not. */}
        <button
          type="button"
          className="mt-3 flex items-center gap-1.5 rounded-md text-xs text-ink-2 transition-colors hover:text-ink"
          onClick={() => setAdvanced((current) => !current)}
          aria-expanded={advanced}
        >
          <Chevron open={advanced} />
          Advanced matching and scope
        </button>
        {advanced && (
          <div className="mt-2 rounded-lg border border-edge bg-surface-2 p-3">
            <label className="block text-xs text-ink-3">
              Text to match
              <input
                value={spec.pattern}
                onChange={(event) => changeSpec({ pattern: event.target.value })}
                className="mt-1 block w-full rounded-lg border border-control-edge bg-control px-2.5 py-2 text-xs text-ink outline-none focus:border-accent/60"
              />
            </label>
            <div className="mt-3">
              <span className="text-xs text-ink-3">Match</span>
              <SegmentedPills
                label="Window title match mode"
                value={spec.titleMatchMode}
                options={TITLE_MATCH_MODE_OPTIONS}
                onChange={(mode) => changeSpec({ titleMatchMode: mode })}
                className="mt-1 w-fit"
              />
              {showBroadMatchWarning(spec) && <BroadMatchWarning className="mt-1.5" />}
            </div>
            <div className="mt-3 text-xs text-ink-3">
              <span>Applies to</span>
              <MenuSelect
                size="field"
                className="mt-1 w-full"
                value={encodedScope}
                onChange={(value) => {
                  const scope = decodeTitleScope(value);
                  changeSpec(scope);
                }}
                label="Rule scope"
                options={scopeOptions}
              />
            </div>
          </div>
        )}

        <p className="mt-2 rounded-lg border border-edge/60 bg-surface-2 px-3 py-2 text-xs leading-snug text-ink-3">
          <span className="font-medium text-ink-2">On this title:</span>{" "}
          {explainTitleMatchAgainstTitle(spec, group.title)}
        </p>

        {/* The safety net for a pattern aimed too widely: say what it takes
            before it takes it. */}
        {(
          !spec.pattern.trim()
          || preview === null
          || preview.sessions > 0
        ) && (
          <p className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs leading-snug text-ink-3">
            {!spec.pattern.trim()
              ? "Enter text this rule should match."
              : <RulePreviewText preview={preview} />}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button
            disabled={saving || !categoryId}
            title={`Use one ${group.entityKind === "website" ? "Website" : "App"} rule instead of inspecting the title`}
            onClick={() => void saveBroadRule()}
          >
            Classify all of {group.displayName}
          </Button>
          <span className="flex-1" />
          <Button disabled={saving} onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving || !spec.pattern.trim() || !categoryId || !titleSpecReady(spec)}
            onClick={() => void save()}
          >
            {saving ? "Adding…" : "Add rule"}
          </Button>
        </div>
    </DialogShell>
  );
}


/**
 * A history-free fallback while ranked candidates are being computed. It never
 * returns the whole delimiter-bearing title or a version-bearing part.
 */
function defaultWindowRuleSpec(group: ActivityTitleGroup): TitleRuleSpec {
  return {
    pattern: defaultRulePattern(group.title),
    scopeKind: group.entityKind === "website" ? "domain" : "process",
    scopeValue: group.entityKey.toLowerCase(),
    titleMatchMode: "segment",
    titleAnchor: "any",
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

function titleRuleScopeOptions(
  group: ActivityTitleGroup,
  browserProcesses: string[],
): MenuOption[] {
  const process = group.sessions[0]?.process.toLowerCase();
  const options: MenuOption[] = [];
  if (group.entityKind === "website") {
    options.push({
      value: encodeTitleScope("domain", group.entityKey),
      label: `Only ${group.entityKey}`,
    });
  } else {
    options.push({
      value: encodeTitleScope("process", group.entityKey),
      label: `Only ${group.displayName} (${group.entityKey})`,
    });
  }
  if (
    process &&
    group.entityKind === "website"
  ) {
    options.push({
      value: encodeTitleScope("process", process),
      label: `Only this browser (${process})`,
    });
  }
  if (group.entityKind === "website" || (process && browserProcesses.includes(process))) {
    options.push({ value: encodeTitleScope(BROWSER_SCOPE, ""), label: "Any browser" });
  }
  options.push({ value: encodeTitleScope(ANY_APP, ""), label: "Any app" });
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

export function SessionCorrectionDialog({
  sessionId,
  categories,
  onClose,
}: {
  sessionId: number;
  categories: Category[];
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
  return (
    <DialogShell
      onClose={onClose}
      busy={saving}
      labelledBy="correction-title"
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
        {!session ? <div className="py-10"><Spinner /></div> : (
          <>
            <div className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs"><p className="font-medium">{session.domain ?? session.process}</p>{session.title && <p className="mt-1 truncate text-ink-3" title={session.title}>{session.title}</p>}</div>
            {(session.isLive || session.isAfk) && <p className="mt-3 rounded-lg border border-bad/30 bg-bad/[.04] px-3 py-2 text-xs text-bad">{session.isLive ? "The visit in progress cannot be edited." : "Away time cannot be edited."}</p>}
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
                options={[
                  // Falling back to the rules is a different kind of answer
                  // from naming one category, so the rule marks the seam.
                  { value: "", label: "Use automatic classification" },
                  ...categories.map((category, i) => ({
                    value: String(category.id),
                    label: category.name,
                    divider: i === 0,
                  })),
                ]}
              />
            </div>

            <div className="mt-4 border-t border-edge/60 pt-3">
              <button
                type="button"
                onClick={() => setEditingTimes((open) => !open)}
                aria-expanded={editingTimes}
                className="flex w-full items-center gap-1.5 rounded-sm text-left text-xs text-ink-3 outline-none hover:text-ink-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
              >
                <Chevron open={editingTimes} />
                Adjust recorded times
                <span className="ml-auto tabular-nums">
                  {fmtDuration(Math.max(0, session.end - session.start))}
                </span>
              </button>
              {editingTimes && (
                <>
                  {/* Stated before the edit rather than after it fails. The
                      tracker records continuously, so the gap around a session
                      is usually the session itself — meaning it can be
                      shortened but almost never extended, which is worth
                      knowing before typing a time. */}
                  <p className="mt-2 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs leading-snug text-ink-3">
                    {describeCorrectionWindow(session)}
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="text-xs text-ink-3">Start<input type="datetime-local" step="1" value={start} min={session.earliestStart == null ? undefined : localInputValue(session.earliestStart)} max={end} onChange={(event) => setStart(event.target.value)} className="mt-1 block w-full rounded-lg border border-control-edge bg-control px-2.5 py-2 text-xs text-ink outline-none focus:border-accent/60" /></label>
                    <label className="text-xs text-ink-3">End<input type="datetime-local" step="1" value={end} min={start} max={session.latestEnd == null ? undefined : localInputValue(session.latestEnd)} onChange={(event) => setEnd(event.target.value)} className="mt-1 block w-full rounded-lg border border-control-edge bg-control px-2.5 py-2 text-xs text-ink outline-none focus:border-accent/60" /></label>
                  </div>
                  <p className="mt-2 text-xs leading-snug text-ink-3">Times use your local timezone and cannot end in the future.</p>
                </>
              )}
            </div>
            <div className="mt-5 flex items-center justify-between"><span>{session.isCorrected && <Button variant="danger" disabled={saving} onClick={() => void reset()}>Reset edits</Button>}</span><span className="flex gap-2"><Button disabled={saving} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={saving || session.isLive || session.isAfk || !start || !end} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button></span></div>
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
