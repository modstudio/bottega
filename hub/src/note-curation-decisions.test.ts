import { expect, test } from 'bun:test'
import {
  type CuratorNote,
  type NoteProposal,
  packCuratorPages,
  rankNoteClasses,
} from './note-curation-decisions.ts'

const note = (label: string, text: string, sightings = 1): CuratorNote => ({
  record_id: label,
  label,
  project: 'alpha',
  text,
  sightings,
  created_at: label,
})

test('page packing keeps fitting clusters together and isolates an oversized note', () => {
  const a = note('A', 'aaaa')
  const b = note('B', 'bbbb')
  const c = note('C', 'ccccc')
  const huge = note('D', 'x'.repeat(11))
  const clusters = [{ notes: [a, b], meanProbability: 0.9 }]
  expect(
    packCuratorPages([a, b, c, huge], clusters, 10).map((page) => page.map((n) => n.label)),
  ).toEqual([['A', 'B'], ['C'], ['D']])
})

test('class ranking orders by note count, sightings, then class identity', () => {
  const notes = [note('A', 'a', 2), note('B', 'b', 5), note('C', 'c', 1)]
  const proposals: NoteProposal[] = [
    {
      label: 'A',
      class: { seed: 'C1' },
      duplicate_of: null,
      still_holds: 'yes',
      reason: 'a',
      source: 'jev',
    },
    {
      label: 'B',
      class: { proposed: { name: 'Fresh', definition: 'd' } },
      duplicate_of: null,
      still_holds: 'yes',
      reason: 'b',
      source: 'curator',
    },
    {
      label: 'C',
      class: { proposed: { name: ' fresh ', definition: 'd' } },
      duplicate_of: null,
      still_holds: 'yes',
      reason: 'c',
      source: 'curator',
    },
  ]
  expect(
    rankNoteClasses(notes, proposals, [{ code: 'C1', name: 'One', definition: 'one' }]),
  ).toMatchObject([
    { key: 'fresh', noteCount: 2, sightings: 6, notes: ['B', 'C'], proposed: true },
    { key: 'C1', noteCount: 1, sightings: 2, notes: ['A'], proposed: false },
  ])
})
