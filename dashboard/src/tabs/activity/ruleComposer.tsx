import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { Button } from "../../components/ui";
import type { ActivitySource } from "../../lib/activity";
import { showBroadMatchWarning } from "../../lib/activityFormat";
import {
  ANY_APP,
  BROWSER_SCOPE,
  normalizeRulePattern,
  type MatchType,
  type Productivity,
  type Rule,
  type TitleRuleAnchor,
  type TitleRuleMatchMode,
  type TitleRuleScopeKind,
  type TitleRuleSpec,
} from "../../lib/classify";
import {
  TITLE_MATCH_MODE_OPTIONS,
  titleMatchModeHelp,
} from "../../lib/categoryRules";
import { fmtDuration } from "../../lib/format";
import { previewRule, type TitleRulePreview } from "../../lib/titleRuleAnalysis";
import SegmentedPills from "./SegmentedPills";

export const ASSIGNABLE_STATES: Productivity[] = ["productive", "neutral", "unproductive"];
/** The states are stored lowercase, and the trigger title-cases them with a
 *  `capitalize` class. The menu renders through a portal, so that class never
 *  reaches it — the label has to arrive already capitalized. */
export const stateLabel = (state: Productivity) => state[0].toUpperCase() + state.slice(1);

export const RULE_LABELS: Record<MatchType, string> = {
  domain: "Website",
  title: "Window",
  process: "App",
};

/** The "no category of its own" entry in the bulk Classify menu. A sentinel
 *  rather than the empty string, because MenuSelect reads "" as "nothing is
 *  selected" — which is exactly what an action menu passes as its value, and
 *  an option sharing it would render permanently checked. */
export const AUTOMATIC_CLASSIFICATION = "auto";

/** A broad scope and substring comparison are separate decisions. The stable
 *  mode help always explains inside-word matching; this caution can therefore
 *  retire once the rule is limited to one app or website. */
export function BroadMatchWarning({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs leading-snug text-ink-3 ${className}`}>
      <span className="font-medium text-ink-2">Broad scope:</span> this text
      fragment can match unrelated titles. Limit it to one app or website when
      possible.
    </p>
  );
}

/**
 * What a rule would take, in the two places a rule is written.
 *
 * Counted over all history rather than the range on screen, because that is the
 * scope a rule actually has. Null while the count is still running; the caller
 * decides what an unusable or empty pattern says, since only it knows which
 * field is blank.
 */
export function RulePreviewText({ preview }: { preview: TitleRulePreview | null }) {
  if (preview === null) return <>Counting what this would match…</>;
  if (preview.sessions === 0) return null;
  return (
    <>
      Claims <span className="text-ink-2">{preview.sessions}</span> visit
      {preview.sessions === 1 ? "" : "s"}
      {preview.titles > 0 && (
        <> with <span className="text-ink-2">{preview.titles}</span> distinct title
          {preview.titles === 1 ? "" : "s"}</>
      )}{" "}
      across <span className="text-ink-2">{preview.days}</span> active{" "}
      {preview.days === 1 ? "day" : "days"} —{" "}
      <span className="text-ink-2">{fmtDuration(preview.seconds)}</span> of all
      recorded time.
      {preview.reclassified > 0 && (
        <> <span className="text-ink-2">{preview.reclassified}</span> of them
        currently classify differently and would change.</>
      )}
    </>
  );
}

/** Rule kinds are told apart by shape, not hue: color in this app means
 *  category identity, so a colored chip per kind would overload it. */
export type CategoryRuleDraft = {
  type: MatchType;
  pattern: string;
  scopeKind: TitleRuleScopeKind;
  scopeValue: string;
  titleMatchMode: TitleRuleMatchMode;
  titleAnchor: TitleRuleAnchor;
};

export type RuleConflict = {
  categoryId: number;
  existingRule: Rule;
  existingCategoryName: string;
  draft: CategoryRuleDraft;
};

export type RuleEditState = {
  ruleId: number;
  categoryId: number;
  draft: CategoryRuleDraft;
  conflict: string | null;
};

export function draftFromRule(rule: Rule): CategoryRuleDraft {
  const isWindow = rule.matchType === "title";
  return {
    type: rule.matchType,
    pattern: rule.pattern,
    scopeKind: isWindow
      ? rule.scopeKind ?? "any"
      : rule.matchType === "domain" ? "domain" : "process",
    scopeValue: isWindow ? rule.scopeValue ?? "" : rule.pattern,
    titleMatchMode: rule.titleMatchMode ?? "phrase",
    titleAnchor: rule.titleAnchor ?? "any",
  };
}

export function EditRuleButton({
  rule,
  onClick,
}: {
  rule: Rule;
  onClick: () => void;
}) {
  const label = `Edit ${RULE_LABELS[rule.matchType]} rule ${rule.pattern}`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink-2"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    </button>
  );
}

/** The rule-kind choice is frequent enough to deserve the same spatial
 * continuity as the primary tabs. One measured pill follows unequal labels
 * without assuming a fixed button width. */
function RuleTypeSelector({
  value,
  onChange,
}: {
  value: MatchType;
  onChange: (value: MatchType) => void;
}) {
  const listRef = useRef<HTMLSpanElement | null>(null);
  const buttonRefs = useRef(new Map<MatchType, HTMLButtonElement>());
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const list = listRef.current;
      const button = buttonRefs.current.get(value);
      if (!list || !button) return;
      setPill({ left: button.offsetLeft, width: button.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (listRef.current) observer.observe(listRef.current);
    for (const button of buttonRefs.current.values()) observer.observe(button);
    return () => observer.disconnect();
  }, [value]);

  return (
    <span
      ref={listRef}
      role="group"
      aria-label="Rule type"
      className="relative flex rounded-lg border border-edge bg-surface p-0.5"
    >
      {pill && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0.5 bottom-0.5 rounded-md bg-selected-strong transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
          style={{ width: pill.width, transform: `translateX(${pill.left}px)`, left: 0 }}
        />
      )}
      {(["process", "domain", "title"] as MatchType[]).map((type) => (
        <button
          key={type}
          ref={(node) => {
            if (node) buttonRefs.current.set(type, node);
            else buttonRefs.current.delete(type);
          }}
          type="button"
          aria-pressed={value === type}
          className={`relative rounded-md px-2 py-1 text-xs transition-colors ${
            value === type ? "text-ink-2" : "text-ink-3 hover:text-ink-2"
          }`}
          onClick={() => onChange(type)}
        >
          {RULE_LABELS[type]}
        </button>
      ))}
    </span>
  );
}

/** Small pages keep the scroll well shallow: "load more" should deepen it a
 *  little, not add a screen of rows at a time. */

export function titleSpecReady(
  spec: Pick<TitleRuleSpec, "scopeKind" | "scopeValue">,
): boolean {
  if (spec.scopeKind === "any" || spec.scopeKind === "browsers") return true;
  return spec.scopeValue.trim() !== "";
}

export function ruleDraftReady(
  draft: { type: MatchType } & Pick<TitleRuleSpec, "scopeKind" | "scopeValue">,
): boolean {
  if (draft.type !== "title") return true;
  return titleSpecReady(draft);
}

function RuleDraftPreview({
  source,
  draft,
  replacingRuleId,
}: {
  source: ActivitySource | null;
  draft: CategoryRuleDraft;
  replacingRuleId?: number;
}) {
  // Null only until the first count lands. A recount keeps the previous
  // figure on screen rather than blanking to "Counting…", which otherwise
  // flashed on every keystroke while a pattern matched nothing yet.
  const [result, setResult] = useState<TitleRulePreview | null>(null);
  const deferred = useDeferredValue(draft);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const next = previewRule(
        source,
        deferred.type,
        deferred.pattern,
        deferred.type === "title" ? deferred : {},
        replacingRuleId,
      );
      // The form only mounts this preview for a usable pattern, so null here
      // is a draft that went unusable mid-count; it says nothing.
      if (!cancelled) setResult(next);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, deferred, replacingRuleId]);

  if (result !== null && result.sessions === 0) return null;

  return (
    <p className="mt-3 text-xs leading-relaxed text-ink-3">
      <RulePreviewText preview={result} />
    </p>
  );
}

/** One field set for adding and editing keeps the saved-row editor from
 * quietly acquiring different Window meanings than the builder beneath it. */
export function CategoryRuleForm({
  draft,
  onChange,
  onSubmit,
  submitLabel,
  onCancel,
  source,
  windowTitleCaptureEnabled,
  autoFocus = false,
  replacingRuleId,
}: {
  draft: CategoryRuleDraft;
  onChange: (patch: Partial<CategoryRuleDraft>) => void;
  onSubmit: () => void;
  submitLabel: string;
  onCancel?: () => void;
  source: ActivitySource | null;
  windowTitleCaptureEnabled: boolean;
  autoFocus?: boolean;
  replacingRuleId?: number;
}) {
  const ready = draft.pattern.trim() !== "" && ruleDraftReady(draft);
  // A pattern that normalizes to nothing is the one addRule would reject. It
  // is only called out once Add has been tried: judging a half-typed domain
  // on every keystroke tells someone they are wrong before they could be done.
  // After that first try the line tracks the field, so it leaves once fixed.
  const usable = normalizeRulePattern(draft.type, draft.pattern) !== null;
  const [attempted, setAttempted] = useState(false);
  const submit = () => {
    if (!ready) return;
    if (!usable) return setAttempted(true);
    onSubmit();
  };
  return (
    <>
      <div className="flex items-center gap-2">
        <RuleTypeSelector
          value={draft.type}
          onChange={(type) => {
            setAttempted(false);
            onChange({ type });
          }}
        />
        <input
          autoFocus={autoFocus}
          value={draft.pattern}
          aria-invalid={attempted && ready && !usable}
          onChange={(event) => onChange({ pattern: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
            else if (event.key === "Escape") onCancel?.();
          }}
          placeholder={draft.type === "domain"
            ? "example.com"
            : draft.type === "title" ? "words to match…" : "example.exe"}
          className="min-w-0 flex-1 rounded-lg border border-control-edge bg-control px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-ink-3 focus:border-accent/60"
        />
        {/* Borderless, as the rest of the app's inline actions now are: the
            field beside them is the only outlined thing in this row. */}
        {onCancel && <Button variant="text" onClick={onCancel}>Cancel</Button>}
        {/* Primary only once there is something to submit: a disabled
            primary rests as a faded blue ghost that reads as broken. */}
        <Button
          variant={ready ? "primary" : "text"}
          disabled={!ready}
          onClick={submit}
        >
          {submitLabel}
        </Button>
      </div>
      {attempted && ready && !usable && (
        <p className="mt-2 text-xs leading-snug text-bad">
          {draft.type === "domain"
            ? "That is not a usable website domain — enter one like example.com."
            : "Enter text this rule should match."}
        </p>
      )}
      {/* The options sit in a label column and a control column, and every
          line of help beneath them starts in the control column too, so the
          explanations read as belonging to the choices above them instead of
          as a third block of text. */}
      {draft.type === "title" && (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="w-[68px] shrink-0 text-xs text-ink-3">Match</span>
            <SegmentedPills
              label="Window title match mode"
              value={draft.titleMatchMode}
              options={TITLE_MATCH_MODE_OPTIONS}
              onChange={(mode) => onChange({
                titleMatchMode: mode,
                titleAnchor: mode === "segment" ? draft.titleAnchor : "any",
              })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap">
            <span className="w-[68px] shrink-0 text-xs text-ink-3">Applies to</span>
            <SegmentedPills
              label="Window rule scope"
              value={draft.scopeKind}
              options={[
                { value: ANY_APP, label: "Any app" },
                { value: BROWSER_SCOPE, label: "Browsers" },
                { value: "process", label: "One app" },
                { value: "domain", label: "Website" },
              ]}
              onChange={(kind) => onChange({
                scopeKind: kind,
                scopeValue:
                  kind === "any" || kind === "browsers"
                    ? ""
                    : draft.scopeValue,
              })}
            />
            {(draft.scopeKind === "process" || draft.scopeKind === "domain") && (
              <input
                value={draft.scopeValue}
                onChange={(event) => onChange({
                  scopeValue: event.target.value,
                })}
                placeholder={draft.scopeKind === "process"
                  ? "example.exe"
                  : "example.com"}
                className="min-w-0 flex-1 basis-full rounded-lg border border-control-edge bg-control px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-ink-3 focus:border-accent/60 sm:basis-auto"
              />
            )}
          </div>
          {/* Website and App rules need no help line: the placeholder shows
              the format. A Window rule's line explains the mode just chosen. */}
          <div className="flex flex-col gap-1.5 sm:pl-[80px]">
            <p className="text-xs leading-relaxed text-ink-3">
              {titleMatchModeHelp(draft.titleMatchMode)}
              {!windowTitleCaptureEnabled
                && " Future window title capture is off; existing stored titles can still match."}
            </p>
            {showBroadMatchWarning(draft) && (
              <BroadMatchWarning className="leading-relaxed" />
            )}
          </div>
        </div>
      )}
      {ready && usable && (
        <RuleDraftPreview
          source={source}
          draft={draft}
          replacingRuleId={replacingRuleId}
        />
      )}
    </>
  );
}
