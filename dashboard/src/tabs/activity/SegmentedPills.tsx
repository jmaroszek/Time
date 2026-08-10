export interface SegmentedPillOption<T extends string | number | boolean> {
  value: T;
  label: string;
}

/** The compact, mutually-exclusive pill control used across Activity surfaces. */
export default function SegmentedPills<T extends string | number | boolean>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  buttonClassName = "",
  selectedClassName = "bg-surface-3 text-ink-2",
}: {
  label: string;
  value: T;
  options: readonly SegmentedPillOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  selectedClassName?: string;
}) {
  return (
    <span
      role="group"
      aria-label={label}
      className={`flex rounded-lg border border-edge bg-surface p-0.5 ${className}`}
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          disabled={disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-40 ${buttonClassName} ${
            value === option.value
              ? selectedClassName
              : "text-ink-3 hover:text-ink-2"
          }`}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}
