/**
 * List order is the order the user arranged ("my order"): the array in the state file is the
 * source of truth, and both sides move items with the same two helpers.
 */

/** Insert `item` right after the item with id `after`; at the top when there is none. */
export function insertAfter<T extends { id: string }>(list: readonly T[], item: T, after?: string): T[] {
  const idx = after === undefined ? -1 : list.findIndex((x) => x.id === after);
  if (idx < 0) return [item, ...list];
  return [...list.slice(0, idx + 1), item, ...list.slice(idx + 1)];
}

/**
 * Move the item with `id` to sit right before the item with id `before`, or last when `before`
 * is null. Returns null when either id is not in the list.
 */
export function moveBefore<T extends { id: string }>(list: readonly T[], id: string, before: string | null): T[] | null {
  const item = list.find((x) => x.id === id);
  if (!item) return null;
  if (before === id) return [...list];
  const rest = list.filter((x) => x.id !== id);
  if (before === null) return [...rest, item];
  const idx = rest.findIndex((x) => x.id === before);
  if (idx < 0) return null;
  rest.splice(idx, 0, item);
  return rest;
}
