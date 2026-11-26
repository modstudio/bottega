import { expect, test } from 'bun:test'
import { rankNoteClasses, type SeedClass } from './note-curation-decisions.ts'
import { evaluateNotes } from './note-evaluate.ts'
import { appendCurationRecord, parseCurationRecord } from './note-evaluation-record.ts'

const note = (label: string) => ({
  record_id: label,
  label,
  project: 'alpha',
  text: label,
  sightings: 1,
  created_at: '2026-01-01',
  number: Number(label.split('#')[1]),
  last_seen_at: '2026-01-01',
  stale_at: null,
  stale_reason: null,
  promoted_task: null,
})

test('evaluation records one ranking containing Jev and curator proposals', async () => {
  const jevNote = note('alpha#1')
  const curatorNote = note('alpha#2')
  const notes = [jevNote, curatorNote]
  const seed: SeedClass[] = [{ code: 'C1', name: 'One', definition: 'one' }]
  let recorded = ''
  let rankCalls = 0
  await evaluateNotes(
    'alpha',
    { skipCurate: false },
    {
      registeredProject: () => ({ path: '/tmp/alpha' }),
      listNotes: async () => ({ notes, total: notes.length }),
      evaluatePairs: async () => ({
        generatedPairs: 0,
        pairsAsked: 0,
        answeredPairs: 0,
        reusedAnswers: 0,
        newAnswers: 0,
        answerFailure: null,
        recall: { produced: 0, total: 0, unreadable: 0, fraction: null },
        clusters: [],
      }),
      readSeed: async () => seed,
      classPass: async () => ({
        ran: true,
        status: 'Jev class pass obtained 1/2 answers',
        answers: 1,
        proposals: [
          {
            label: jevNote.label,
            class: { seed: 'C1' },
            duplicate_of: null,
            still_holds: 'unsure',
            reason: 'confident',
            source: 'jev',
          },
        ],
        remaining: [curatorNote],
      }),
      curate: async () => ({
        proposals: [
          {
            label: curatorNote.label,
            class: { proposed: { name: 'Two', definition: 'two' } },
            duplicate_of: null,
            still_holds: 'yes',
            reason: 'fit',
            source: 'curator',
          },
        ],
        failedPages: [],
        invalidEntries: 0,
        stopped: null,
      }),
      rank: (...args) => {
        rankCalls++
        return rankNoteClasses(...args)
      },
      appendRecord: appendCurationRecord,
      writeRecord: async (_project, body) => {
        recorded = body
        return {} as never
      },
      now: () => '2026-11-26T00:00:00.000Z',
    },
  )
  expect(rankCalls).toBe(1)
  expect(
    parseCurationRecord(recorded)
      ?.ranking.flatMap((item) => item.notes)
      .sort(),
  ).toEqual(['alpha#1', 'alpha#2'])
})
