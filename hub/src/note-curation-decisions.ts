// concern: note curation decisions
/** Packs clustered notes into bounded pages and ranks class proposals. */

import type { EvaluationNote, NoteEvaluationCluster } from './note-evaluation.ts'

const CURATOR_PAGE_CHARACTERS = 40_000

export type CuratorNote = EvaluationNote & { sightings: number }
export type SeedClass = { code: string; name: string; definition: string }
export type ClassProposal = { seed: string } | { proposed: { name: string; definition: string } }
export type NoteProposal = {
  label: string
  class: ClassProposal
  duplicate_of: string | null
  still_holds: 'yes' | 'no' | 'unsure'
  reason: string
  source: 'jev' | 'curator'
}
export type RankedClass = {
  key: string
  name: string
  definition: string
  proposed: boolean
  noteCount: number
  sightings: number
  notes: string[]
}

function orderedGroups(
  notes: readonly CuratorNote[],
  clusters: readonly NoteEvaluationCluster[],
): CuratorNote[][] {
  const byId = new Map(notes.map((note) => [note.record_id, note]))
  const clustered = new Set<string>()
  const groups = clusters.flatMap((cluster) => {
    const group = cluster.notes.flatMap((note) => {
      const found = byId.get(note.record_id)
      if (!found) return []
      clustered.add(found.record_id)
      return [found]
    })
    return group.length ? [group] : []
  })
  const singletons = notes
    .filter((note) => !clustered.has(note.record_id))
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((note) => [note])
  return [...groups, ...singletons]
}

export function packCuratorPages(
  notes: readonly CuratorNote[],
  clusters: readonly NoteEvaluationCluster[],
  budget = CURATOR_PAGE_CHARACTERS,
): CuratorNote[][] {
  const pages: CuratorNote[][] = []
  let page: CuratorNote[] = []
  let used = 0
  const flush = () => {
    if (page.length) pages.push(page)
    page = []
    used = 0
  }
  for (const group of orderedGroups(notes, clusters)) {
    const groupSize = group.reduce((sum, note) => sum + note.text.length, 0)
    if (page.length && groupSize <= budget && used + groupSize > budget) flush()
    for (const note of group) {
      if (page.length && used + note.text.length > budget) flush()
      page.push(note)
      used += note.text.length
      if (note.text.length > budget) flush()
    }
  }
  flush()
  return pages
}

export function rankNoteClasses(
  notes: readonly CuratorNote[],
  proposals: readonly NoteProposal[],
  seeds: readonly SeedClass[],
): RankedClass[] {
  const noteByLabel = new Map(notes.map((note) => [note.label, note]))
  const seedByCode = new Map(seeds.map((seed) => [seed.code, seed]))
  const classes = new Map<string, RankedClass>()
  for (const proposal of proposals) {
    const note = noteByLabel.get(proposal.label)
    if (!note) continue
    const seed = 'seed' in proposal.class ? seedByCode.get(proposal.class.seed) : undefined
    const proposed = 'proposed' in proposal.class ? proposal.class.proposed : undefined
    if (!seed && !proposed) continue
    const key = seed ? seed.code : proposed!.name.trim().toLocaleLowerCase('en-US')
    const current = classes.get(key) ?? {
      key,
      name: seed?.name ?? proposed!.name.trim(),
      definition: seed?.definition ?? proposed!.definition,
      proposed: !seed,
      noteCount: 0,
      sightings: 0,
      notes: [],
    }
    current.noteCount++
    current.sightings += note.sightings
    current.notes.push(note.label)
    classes.set(key, current)
  }
  return [...classes.values()].sort(
    (left, right) =>
      right.noteCount - left.noteCount ||
      right.sightings - left.sightings ||
      left.key.localeCompare(right.key),
  )
}
