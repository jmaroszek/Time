export function Spinner({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-ink-2">{label}</div>
  );
}
