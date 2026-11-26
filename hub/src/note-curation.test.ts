import { expect, test } from 'bun:test'
import { curateEvaluationNotes } from './note-curation.ts'
import type { CuratorNote, SeedClass } from './note-curation-decisions.ts'

const seed: SeedClass[] = [{ code: 'C1', name: 'One', definition: 'one' }]
const note = (label: string, text = label): CuratorNote => ({
  record_id: label,
  label,
  project: 'alpha',
  text,
  sightings: 1,
  created_at: label,
})

test('invalid replies fail only their page and cross-page duplicate references are dropped', async () => {
  const notes = [note('A', 'a'.repeat(40_001)), note('B', 'b'.repeat(40_001))]
  let call = 0
  const result = await curateEvaluationNotes('/tmp/alpha', notes, notes, [], seed, async () => {
    call++
    return call === 1
      ? { runId: 'r1', reply: { wrong: [] } }
      : {
          runId: 'r2',
          reply: {
            proposals: [
              {
                label: 'B',
                class: { seed: 'C1' },
                duplicate_of: 'A',
                still_holds: 'yes',
                reason: 'fit',
              },
            ],
          },
        }
  })
  expect(result.failedPages).toMatchObject([{ page: 1, labels: ['A'], runId: 'r1' }])
  expect(result.proposals).toMatchObject([{ label: 'B', duplicate_of: null }])
  expect(result.invalidEntries).toBe(1)
})

test('a refused first dispatch stops without dispatching another page', async () => {
  const notes = [note('A'), note('B')]
  let calls = 0
  const result = await curateEvaluationNotes('/tmp/alpha', notes, notes, [], seed, async () => {
    calls++
    throw new Error('open a keyless workflow cursor, then retry')
  })
  expect(calls).toBe(1)
  expect(result.stopped).toContain('keyless workflow cursor')
})
