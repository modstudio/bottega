export type IdentifiedAnchor = { id?: string }

export function mergeNoteAnchors<T extends IdentifiedAnchor>(
  stored: readonly T[],
  incoming: readonly T[],
): { anchors: T[]; sightings: number; appended: number } {
  const ids = new Set(stored.flatMap((anchor) => (anchor.id ? [anchor.id] : [])))
  const anchors = [...stored]
  let appended = 0
  for (const anchor of incoming) {
    if (!anchor.id || ids.has(anchor.id)) continue
    ids.add(anchor.id)
    anchors.push(anchor)
    appended += 1
  }
  return { anchors, sightings: anchors.length, appended }
}
