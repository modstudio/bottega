import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { runNoteClassPass, seedClassesFromTasks, seedMismatch } from './note-classification.ts'
import type { CuratorNote } from './note-curation-decisions.ts'
import type { TaskRow } from './task-row.ts'

const task = (code: string): TaskRow => ({
  record_id: code,
  external_id: null,
  key: `DEV-${code.slice(1)}`,
  project: PLATFORM_SLUG,
  title: `Class ${code}: Class ${code}`,
  status: 'open',
  status_category: 'open',
  parent_key: 'DEV-2079',
  parent_record_id: 'parent',
  body: 'definition',
  assignee: null,
  opened_at: null,
  closed_at: null,
  updated_at: null,
  source: 'local',
  first_seen: '2026-01-01',
  last_seen: '2026-01-01',
  next_document_number: 1,
  retired_reason: null,
})
const note: CuratorNote = {
  record_id: 'note-1',
  label: `${PLATFORM_SLUG}#1`,
  project: PLATFORM_SLUG,
  text: 'note',
  sightings: 1,
  created_at: '2026-01-01',
}

test('live class task rows determine the seed and a new class skips Jev with the remedy', () => {
  const seed = seedClassesFromTasks(['C1', 'C2', 'C4', 'C5', 'C6', 'C7'].map(task))
  expect(seedMismatch(seed)).toBeNull()
  expect(
    seedMismatch(
      seedClassesFromTasks([...['C1', 'C2', 'C4', 'C5', 'C6', 'C7'].map(task), task('C9')]),
    ),
  ).toContain('declare a new note_class version')
})

test('only a confident seed choice keeps a note off curator pages', async () => {
  const seed = seedClassesFromTasks(['C1', 'C2', 'C4', 'C5', 'C6', 'C7'].map(task))
  for (const [answer, assigned] of [
    [{ choice: 'C1', confidence: 0.9, probabilities: {} }, true],
    [{ choice: 'C1', confidence: 0.7, probabilities: {} }, false],
    [{ choice: 'none', confidence: 0.99, probabilities: {} }, false],
  ] as const) {
    const result = await runNoteClassPass([note], seed, {
      credential: async () => ({ available: true }),
      ask: async () => ({ answer, reused: false }),
    })
    expect(result.proposals.length === 1).toBe(assigned)
    expect(result.remaining.length === 0).toBe(assigned)
  }
})

test('missing credential asks and records nothing and sends every note to curation', async () => {
  const seed = seedClassesFromTasks(['C1', 'C2', 'C4', 'C5', 'C6', 'C7'].map(task))
  let asks = 0
  const result = await runNoteClassPass([note], seed, {
    credential: async () => ({
      available: false,
      reason: 'Jev class pass obtained no answers: missing',
    }),
    ask: async () => {
      asks++
      return null
    },
  })
  expect({ asks, remaining: result.remaining.length, status: result.status }).toEqual({
    asks: 0,
    remaining: 1,
    status: 'Jev class pass obtained no answers: missing',
  })
})
