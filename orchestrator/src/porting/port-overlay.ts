// concern: porting
/** Chooses hosted port items by natural key while retaining unmatched local items. */
export function overlayPortItems<T>(
  local: readonly T[],
  hosted: readonly T[],
  naturalKey: (item: T) => string,
): T[] {
  const hostedKeys = new Set(hosted.map(naturalKey))
  return [...hosted, ...local.filter((item) => !hostedKeys.has(naturalKey(item)))]
}
