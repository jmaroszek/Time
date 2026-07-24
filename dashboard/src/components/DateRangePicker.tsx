import { Checkbox, MenuSelect, TextInput, type MenuOption } from "./ui";
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
          <Checkbox checked={rolling} onChange={onRollingChange} className="text-[11px] text-ink-3">
            Rolling
          </Checkbox>
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
