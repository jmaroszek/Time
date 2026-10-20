export function TextInput({
  value,
  onChange,
  onCommit,
  type = "text",
  className = "",
  placeholder,
  min,
  max,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: () => void;
  type?: string;
  className?: string;
  placeholder?: string;
  min?: string;
  max?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      min={min}
      max={max}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => e.key === "Enter" && onCommit?.()}
      className={`rounded-lg border border-control-edge bg-control px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent/60 ${className}`}
    />
  );
}
