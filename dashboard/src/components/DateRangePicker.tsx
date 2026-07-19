import { Select, TextInput } from "./ui";
import { addDays, parseDateInput, type Preset, type Range } from "../lib/time";

export type PresetOrCustom = Preset | "custom";

const PRESETS: { value: PresetOrCustom; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "last7", label: "Last 7 days" },
  { value: "last14", label: "Last 14 days" },
  { value: "last28", label: "Last 28 days" },
  { value: "custom", label: "Custom" },
];

function toInputValue(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export default function DateRangePicker({
  preset,
  range,
  onPreset,
  onCustomRange,
}: {
  preset: PresetOrCustom;
  range: Range;
  onPreset: (p: PresetOrCustom) => void;
  onCustomRange: (r: Range) => void;
}) {
  // range.end is exclusive; the UI shows the inclusive last day.
  const lastDay = addDays(range.end, -1);

  const commitCustom = (startStr: string, endStr: string) => {
    const start = parseDateInput(startStr);
    const endInclusive = parseDateInput(endStr);
    if (!start || !endInclusive || endInclusive < start) return;
    onCustomRange({ start, end: addDays(endInclusive, 1) });
  };

  return (
    <div className="flex items-center gap-2">
      <Select
        value={preset}
        onChange={(v) => onPreset(v as PresetOrCustom)}
        options={PRESETS}
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
