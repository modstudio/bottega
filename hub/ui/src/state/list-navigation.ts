/**
 * Which item a key moves to in a vertical list, skipping disabled items.
 * Returns the current index for a key the list does not handle.
 */
export function moveIndex(
  key: string,
  current: number,
  disabled: readonly boolean[],
  loop = true,
): number {
  const count = disabled.length
  if (!count) return -1
  const step = (from: number, delta: 1 | -1) => {
    for (let offset = 1; offset <= count; offset++) {
      const raw = from + delta * offset
      if (!loop && (raw < 0 || raw >= count)) return current
      const index = ((raw % count) + count) % count
      if (!disabled[index]) return index
    }
    return current
  }
  if (key === 'ArrowDown') return step(current, 1)
  if (key === 'ArrowUp') return step(current < 0 ? count : current, -1)
  if (key === 'Home') return step(-1, 1)
  if (key === 'End') return step(count, -1)
  return current
}

/**
 * The item a typed prefix selects: the next enabled label starting with it,
 * searching after the current item so repeating a letter cycles.
 */
export function typeaheadIndex(
  query: string,
  labels: readonly string[],
  current: number,
  disabled: readonly boolean[],
): number {
  const prefix = query.toLowerCase()
  if (!prefix) return current
  const count = labels.length
  // A repeated single letter cycles; a longer query first tries the current item.
  const repeated = prefix.length > 1 && [...prefix].every((letter) => letter === prefix[0])
  const needle = repeated ? prefix[0]! : prefix
  const start = needle.length === 1 ? 1 : 0
  for (let offset = start; offset < count + start; offset++) {
    const index = (current + offset + count) % count
    if (!disabled[index] && labels[index]!.toLowerCase().startsWith(needle)) return index
  }
  return current
}
