/** Toggle one member without mutating React state in place. */
export function toggleSetValue<T>(current: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** Select all supplied members, or clear them when they are already selected. */
export function toggleSetValues<T>(current: ReadonlySet<T>, values: readonly T[]): Set<T> {
  const next = new Set(current);
  if (values.every((value) => next.has(value))) {
    for (const value of values) next.delete(value);
  } else {
    for (const value of values) next.add(value);
  }
  return next;
}
