import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { normalizeBrowserProcesses } from "../../lib/browsers";
import { coveringMediaSite, normalizeMediaSites } from "../../lib/mediaSites";

/** Keep number-field drafts within the syntax every Settings spec accepts. */
export function sanitizeNumericDraft(raw: string, allowDecimal: boolean): string {
  let value = raw.replace(/[^0-9.]/g, "");
  if (!allowDecimal) return value.replace(/\./g, "");
  const firstDot = value.indexOf(".");
  if (firstDot !== -1) {
    value = value.slice(0, firstDot + 1) + value.slice(firstDot + 1).replace(/\./g, "");
  }
  return value;
}

export function handleRadioKey(
  event: KeyboardEvent<HTMLButtonElement>,
  options: string[],
  index: number,
  onChange: (value: string) => void,
) {
  let next = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % options.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = options.length - 1;
  else return;
  event.preventDefault();
  onChange(options[next]);
  const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
  radios?.[next]?.focus();
}

export function ScheduleTimeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs font-semibold text-ink-2">
      {label}
      <input
        type="time"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-[8px] border border-edge-2 bg-surface-2 px-2.5 text-xs font-semibold tabular-nums text-ink outline-none focus:border-accent"
      />
    </label>
  );
}

/**
 * On is a *filled* control, not a tinted one, and its knob is whatever reads on
 * that fill — which is what --color-on-accent means. Off drops the knob to a
 * muted ink so it recedes.
 *
 * The translucent accent this replaces put the same near-full-strength ink knob
 * on both states, so off claimed as much attention as on, and the two differed
 * only by the knob's position. It also went wrong in light: an accent at 35%
 * over white is pale, so the ink knob landed at 10.5:1 against it where the
 * dark theme's sat at 7.2:1 — the light knob was the heavier of the two, on the
 * theme with less contrast to spend. Anchoring the pair to the accent fill makes
 * both themes land together without either being tuned by hand.
 */
export function PrivacyToggle({
  label,
  enabled,
  disabled = false,
  onChange,
}: {
  label: string;
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className="relative h-9 w-11 rounded-full disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        aria-hidden="true"
        className={`absolute left-0 top-1.5 h-6 w-11 rounded-full border transition-colors ${
          enabled ? "border-accent bg-accent" : "border-edge-2 bg-surface-2"
        }`}
      />
      <span
        aria-hidden="true"
        className={`absolute top-[10px] h-4 w-4 rounded-full transition-all ${
          enabled ? "left-[22px] bg-on-accent" : "left-[3px] bg-ink-3"
        }`}
      />
    </button>
  );
}

export function SettingGroup({ children, dependents }: { children: ReactNode; dependents?: ReactNode }) {
  return (
    <div className="border-t border-surface-2 px-4 py-[15px]">
      {children}
      {dependents && (
        <div className="ml-[3px] mt-4 flex flex-col gap-[15px] border-l border-edge-2 pl-[18px]">
          {dependents}
        </div>
      )}
    </div>
  );
}

export function Row({
  label,
  help,
  control,
  bare = false,
  compact = false,
  stacked = false,
  footer,
}: {
  label: string;
  help: string;
  control: ReactNode;
  /** Drop the card chrome — the caller is already providing it. */
  bare?: boolean;
  /** One step down in weight, for a row that qualifies the one above it. */
  compact?: boolean;
  /** Places a wide control below its description instead of in the right rail. */
  stacked?: boolean;
  /** Extra content on its own line below the label/help/control line, at the
   *  row's full width rather than squeezed into the control rail beside the
   *  help text. For a control that keeps its place in the rail (a toggle) but
   *  has a second element too wide to share that column with a three-line
   *  description — see the "Record websites" row, whose store-link buttons
   *  used to narrow the help text into an unusually tall paragraph. */
  footer?: ReactNode;
}) {
  return (
    <div className={bare ? "" : "border-t border-surface-2 px-4 py-[15px] first:border-t-0"}>
      <div className={stacked ? "" : "flex items-center justify-between gap-4 max-sm:block"}>
        <div className="min-w-0">
          <p className={`font-medium text-ink ${compact ? "text-xs" : "text-row"}`}>{label}</p>
          <p className="mt-[5px] max-w-[400px] text-meta leading-snug text-ink-3">
            {help}
          </p>
        </div>
        <div className={stacked ? "mt-3" : "shrink-0 max-sm:mt-3"}>{control}</div>
      </div>
      {footer && <div className="mt-3">{footer}</div>}
    </div>
  );
}

/** The chip-list field Settings uses wherever a setting is a set of names the
 *  reader can extend — browser processes, media sites.
 *
 *  Everything specific to a list lives in the props: how typed text parses into
 *  entries (`normalize`), how many must survive (`minimum`), and whether an
 *  entry is redundant rather than new (`describeCovered`, whose message is
 *  shown below the field instead of adding a chip). The keyboard contract —
 *  Enter or comma to add, Left Arrow from the empty input to reach the chips,
 *  Delete to remove — is the part worth having in one place. */
function ChipEditor({
  values,
  onChange,
  normalize,
  groupLabel,
  collectionName,
  addLabel,
  instructionsId,
  display = (value) => value,
  minimum = 0,
  minimumHint,
  describeCovered,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  normalize: (raw: string) => string[];
  /** Names the field for assistive technology: "Browser processes". */
  groupLabel: string;
  /** Names the set inside a chip's remove label: "browser processes". */
  collectionName: string;
  /** Verb phrase for the input: "Add a browser process". */
  addLabel: string;
  instructionsId: string;
  display?: (value: string) => string;
  minimum?: number;
  minimumHint?: string;
  describeCovered?: (value: string, current: string[]) => string | null;
}) {
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const commit = (raw = input) => {
    const additions = normalize(raw);
    if (additions.length > 0) {
      const next = [...values];
      let covered: string | null = null;
      for (const addition of additions) {
        // Redundancy is reported, not silently accepted: pressing Enter and
        // watching nothing happen reads as a broken field.
        const message = describeCovered?.(addition, next);
        if (message) {
          covered ??= message;
          continue;
        }
        if (!next.includes(addition)) next.push(addition);
      }
      setNotice(covered);
      if (next.length !== values.length) onChange(next);
    }
    setInput("");
  };

  const remove = (index: number) => {
    if (values.length <= minimum) return;
    onChange(values.filter((_, valueIndex) => valueIndex !== index));
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const focusChip = (index: number) => {
    chipRefs.current[index]?.focus();
  };

  return (
    <div>
      <div
        className="flex min-h-[42px] flex-wrap items-center gap-2 rounded-[10px] border border-control-edge bg-control px-2.5 py-2 transition-colors focus-within:border-accent/60"
        role="group"
        aria-label={groupLabel}
        aria-describedby={instructionsId}
      >
        {values.map((value, index) => {
          const label = display(value);
          const removable = values.length > minimum;
          return (
            <button
              key={value}
              ref={(element) => {
                chipRefs.current[index] = element;
              }}
              type="button"
              tabIndex={-1}
              aria-label={
                removable
                  ? `Remove ${label} from ${collectionName}`
                  : `${label}; ${minimumHint ?? ""}`
              }
              aria-disabled={!removable}
              title={removable ? `Remove ${label}` : minimumHint}
              onClick={() => remove(index)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  focusChip(Math.max(0, index - 1));
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  if (index === values.length - 1) inputRef.current?.focus();
                  else focusChip(index + 1);
                } else if (event.key === "Delete" || event.key === "Backspace") {
                  event.preventDefault();
                  remove(index);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  inputRef.current?.focus();
                }
              }}
              className={`flex h-7 items-center gap-1.5 rounded-[8px] border border-edge bg-surface-3 px-2.5 font-mono text-xs text-ink transition-colors ${
                removable ? "hover:border-edge-2 hover:bg-hover-2" : "cursor-default"
              }`}
            >
              <span>{label}</span>
              <span aria-hidden="true" className={removable ? "text-ink-3" : "text-ink-3/40"}>×</span>
            </button>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={input}
          aria-label={addLabel}
          placeholder={`${addLabel}…`}
          onChange={(event) => {
            setInput(event.target.value);
            setNotice(null);
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (input.trim() || !/[\r\n,]/.test(pasted)) return;
            event.preventDefault();
            commit(pasted);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              commit();
            } else if (
              event.key === "ArrowLeft"
              && input.length === 0
              && event.currentTarget.selectionStart === 0
              && values.length > 0
            ) {
              event.preventDefault();
              focusChip(values.length - 1);
            }
          }}
          className="h-7 min-w-0 flex-1 basis-full bg-transparent px-1 font-mono text-xs text-ink outline-none placeholder:font-sans placeholder:text-ink-3 sm:min-w-[168px] sm:basis-auto"
        />
        <span id={instructionsId} className="sr-only">
          Press Enter or comma to add. From the empty input, press Left Arrow to manage existing entries, then Delete to remove one.
        </span>
      </div>
      {/* Polite, not an alert: a redundant entry is a correction to the reader's
          expectation, not an error they have to clear. */}
      {notice && (
        <p role="status" className="mt-2 pl-0.5 text-meta text-ink-3">
          {notice}
        </p>
      )}
    </div>
  );
}

export function BrowserProcessEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (processes: string[]) => void;
}) {
  return (
    <ChipEditor
      values={normalizeBrowserProcesses(value)}
      onChange={onChange}
      normalize={normalizeBrowserProcesses}
      groupLabel="Browser processes"
      collectionName="browser processes"
      addLabel="Add a browser process"
      instructionsId="browser-process-instructions"
      display={(process) => process.replace(/\.exe$/i, "")}
      minimum={1}
      minimumHint="At least one browser process is required"
    />
  );
}

/** The reader's additions to the built-in media list. Empty is the normal
 *  state — the built-ins are deliberately not shown as removable chips, so the
 *  field stays one line for everyone Time already covers. */
export function MediaSiteEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (sites: string[]) => void;
}) {
  return (
    <ChipEditor
      values={normalizeMediaSites(value)}
      onChange={onChange}
      normalize={normalizeMediaSites}
      groupLabel="Media sites"
      collectionName="media sites"
      addLabel="Add a media site"
      instructionsId="media-site-instructions"
      describeCovered={(site, current) => {
        const covering = coveringMediaSite(site, current);
        return covering ? `Time already recognizes ${covering}.` : null;
      }}
    />
  );
}

/** Keys a native number input would otherwise accept but no spec here ever
 *  wants: scientific notation and an explicit sign. Every spec's minimum is
 *  non-negative, so "-" is never valid either. */
function blockNonNumericKeys(event: KeyboardEvent<HTMLInputElement>) {
  if (["e", "E", "+", "-"].includes(event.key)) event.preventDefault();
}

export function NumberStepper({
  label,
  value,
  display,
  unit,
  readOnly = false,
  min,
  max,
  step,
  onChange,
  onBlur,
  onMinus,
  onPlus,
}: {
  label: string;
  value: string;
  display?: string;
  unit?: string;
  readOnly?: boolean;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: string) => void;
  onBlur: () => void;
  onMinus: () => void;
  onPlus: () => void;
}) {
  return (
    <div className="inline-flex items-center rounded-[10px] border border-control-edge bg-control p-[3px] transition-colors focus-within:border-accent/60">
      <button type="button" aria-label={`Decrease ${label}`} className="flex h-7 w-[30px] items-center justify-center rounded-[7px] text-sm text-ink-2 hover:bg-hover-2 hover:text-ink" onClick={onMinus}>−</button>
      <div className={`flex items-baseline justify-center ${unit ? "min-w-[34px] gap-1" : "min-w-[34px]"}`}>
        <input
          type={readOnly ? "text" : "number"}
          inputMode={readOnly ? undefined : "decimal"}
          readOnly={readOnly}
          min={readOnly ? undefined : min}
          max={readOnly ? undefined : max}
          step={readOnly ? undefined : step}
          aria-label={label}
          value={display ?? value}
          // Always sized to its own content, never left at the browser's default
          // intrinsic width for type="number" (which `w-full` fell back to when
          // the parent had no width of its own to resolve a percentage against —
          // the no-unit branch used to render nearly a digit wider than every
          // unit-carrying stepper as a result).
          style={{ width: `${Math.max((display ?? value).length, 1)}ch` }}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.currentTarget.blur(); return; }
            if (!readOnly) blockNonNumericKeys(event);
          }}
          className={`${unit ? "text-right" : "text-center"} bg-transparent text-row font-semibold tabular-nums text-ink outline-none`}
        />
        {unit && <span className="text-xs text-ink-3">{unit}</span>}
      </div>
      <button type="button" aria-label={`Increase ${label}`} className="flex h-7 w-[30px] items-center justify-center rounded-[7px] text-sm text-ink-2 hover:bg-hover-2 hover:text-ink" onClick={onPlus}>+</button>
    </div>
  );
}

export function Segmented({ label, options, value, onChange, labels }: { label: string; options: string[]; value: string; onChange: (value: string) => void; labels?: Record<string, string> }) {
  return (
    <div className="inline-flex rounded-[10px] border border-edge bg-surface-2 p-[3px]" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          type="button"
          key={option}
          role="radio"
          aria-checked={value === option}
          tabIndex={value === option ? 0 : -1}
          className={`rounded-[7px] px-[13px] py-1.5 text-xs transition-colors ${value === option ? "bg-accent/15 font-semibold text-accent" : "text-ink-3 hover:text-ink-2"}`}
          onClick={() => onChange(option)}
          onKeyDown={(event) => handleRadioKey(event, options, index, onChange)}
        >
          {labels?.[option] ?? (option === "auto" ? "Auto" : option)}
        </button>
      ))}
    </div>
  );
}
