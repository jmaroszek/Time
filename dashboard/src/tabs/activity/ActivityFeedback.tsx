export function NoResults({
  isAllTime,
  onTryAllTime,
  search,
  hasActiveFilters,
  onClearFilters,
}: {
  isAllTime: boolean;
  onTryAllTime: () => void;
  search?: string;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}) {
  const message = search
    ? hasActiveFilters
      ? <>No matches for &ldquo;{search}&rdquo; with these filters</>
      : <>No matches for &ldquo;{search}&rdquo; in this range</>
    : hasActiveFilters
      ? <>No activity matches these filters</>
      : <>No activity found in this range</>;
  return (
    <div className="flex h-36 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-ink-3">
      <span className="max-w-[42ch] truncate">{message}</span>
      <span className="flex items-center gap-1.5">
        {hasActiveFilters && (
          <button type="button" onClick={onClearFilters} className="text-xs text-accent hover:text-accent/80">
            Clear filters
          </button>
        )}
        {hasActiveFilters && !isAllTime && <span aria-hidden="true">·</span>}
        {!isAllTime && (
          <button type="button" onClick={onTryAllTime} className="text-xs text-accent hover:text-accent/80">
            Try all time
          </button>
        )}
      </span>
    </div>
  );
}

export function LoadMore({ shown, total, onClick, disabled = false }: { shown: number; total: number; onClick: () => void; disabled?: boolean }) {
  return (
    <div className="mt-3 flex items-center justify-center gap-2 text-xs text-ink-3">
      <span>{shown} of {total}</span>
      <button type="button" onClick={onClick} disabled={disabled} className="rounded-md px-2 py-1 text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40">Load more</button>
    </div>
  );
}
