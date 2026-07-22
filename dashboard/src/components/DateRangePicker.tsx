import { MenuSelect, TextInput, type MenuOption } from "./ui";
import { addDays, isRollingPreset, parseDateInput, type Preset, type Range } from "../lib/time";

export type PresetOrCustom = Preset | "custom" | "alltime";

// Every entry above the rule completes the selection on its own; Custom
// instead hands off to the two date fields beside it.
const PRESETS: (MenuOption & { value: PresetOrCustom })[] = [
  { value: "today", label: "Today" },
  { value: "last7", label: "Week" },
  { value: "last30", label: "Month" },
  { value: "last90", label: "Quarter" },
  { value: "last365", label: "Year" },
  { value: "alltime", label: "All time" },
  { value: "custom", label: "Custom", divider: true },
];

function toInputValue(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export default function DateRangePicker({
  preset,
  range,
  rolling,
  onPreset,
  onRollingChange,
  onCustomRange,
}: {
  preset: PresetOrCustom;
  range: Range;
  rolling: boolean;
  onPreset: (p: PresetOrCustom) => void;
  onRollingChange: (rolling: boolean) => void;
  onCustomRange: (r: Range) => void;
}) {
  // range.end is exclusive; the UI shows the inclusive last day.
  const lastDay = addDays(range.end, -1);
  const supportsRolling = preset !== "custom" && preset !== "alltime" && isRollingPreset(preset);

  const commitCustom = (startStr: string, endStr: string) => {
    const start = parseDateInput(startStr);
    const endInclusive = parseDateInput(endStr);
    if (!start || !endInclusive || endInclusive < start) return;
    onCustomRange({ start, end: addDays(endInclusive, 1) });
  };

  return (
    <div className="flex items-center gap-2">
      <div className="flex w-16 justify-end">
        {supportsRolling && (
          <label className="group flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-3">
            <input
              type="checkbox"
              checked={rolling}
              onChange={(event) => onRollingChange(event.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="flex h-3 w-3 items-center justify-center rounded-[3px] border border-edge bg-surface text-ink-3 transition-colors group-hover:border-edge-2 peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-edge-2"
            >
              {rolling && (
                <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none">
                  <path d="m2.5 6 2.1 2.1 4.9-4.9" stroke="currentColor" strokeWidth="1.4" />
                </svg>
              )}
            </span>
            Rolling
          </label>
        )}
      </div>
      <MenuSelect
        value={preset}
        onChange={(v) => onPreset(v as PresetOrCustom)}
        options={PRESETS}
        label="Date range preset"
        className="w-32"
      />
      {/* min/max keep start <= end selectable in the native picker; typed
          inverted ranges still no-op in commitCustom. */}
      <TextInput
        type="date"
        value={toInputValue(range.start)}
        max={toInputValue(lastDay)}
        onChange={(v) => commitCustom(v, toInputValue(lastDay))}
        className="w-36"
      />
      <span className="text-xs text-ink-3">to</span>
      <TextInput
        type="date"
        value={toInputValue(lastDay)}
        min={toInputValue(range.start)}
        onChange={(v) => commitCustom(toInputValue(range.start), v)}
        className="w-36"
      />
    </div>
  );
}
