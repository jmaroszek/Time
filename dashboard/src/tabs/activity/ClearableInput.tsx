export default function ClearableInput({
  value,
  onChange,
  label,
  placeholder,
  leadingIcon = false,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  leadingIcon?: boolean;
  className?: string;
}) {
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">{label}</span>
      {leadingIcon && (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="absolute left-3 top-2.5 h-3.5 w-3.5 text-ink-3">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
        </svg>
      )}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
        placeholder={placeholder}
        className={`w-full rounded-[9px] border border-control-edge bg-control py-2 pr-8 text-xs outline-none placeholder:text-ink-3 focus:border-accent/60 ${leadingIcon ? "pl-9" : "pl-2.5"}`}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          title={`Clear ${label.toLowerCase()}`}
          className="absolute right-2 top-1.5 rounded p-1 text-ink-3 hover:bg-hover-2 hover:text-ink-2"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
          <span className="sr-only">Clear {label.toLowerCase()}</span>
        </button>
      )}
    </label>
  );
}
