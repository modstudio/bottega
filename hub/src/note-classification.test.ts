import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  runNoteClassPass,
  seedClassesFromTasks,
  selectNoteClassQuestion,
} from './note-classification.ts'
import type { CuratorNote } from './note-curation-decisions.ts'
import type { TaskRow } from './task-row.ts'
import {
  type NOTE_CLASS_QUESTION,
  TYPED_QUESTION_DECLARATIONS,
} from './typed-question-declarations.ts'

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

const noteClassQuestions = TYPED_QUESTION_DECLARATIONS.filter(
  (question): question is typeof NOTE_CLASS_QUESTION =>
    question.id === 'note_class' && question.type === 'choice',
)
const questionCodes = (question: (typeof noteClassQuestions)[number]) =>
  Object.keys(question.criteria).filter((code) => code !== 'none')

test('selects v1 or v2 when the seed exactly matches that version', () => {
  expect(selectNoteClassQuestion(['C1', 'C2', 'C4', 'C5', 'C6', 'C7'])?.version).toBe(1)
  expect(selectNoteClassQuestion(['C1', 'C2', 'C4', 'C5', 'C6', 'C7', 'C9'])?.version).toBe(2)
})

test('a duplicated seed code matches no declared version', () => {
  expect(selectNoteClassQuestion(['C1', 'C1', 'C2', 'C4', 'C5', 'C6', 'C7'])).toBeUndefined()
})

test('every declared note_class version selects itself from its option set', () => {
  for (const question of noteClassQuestions)
    expect(selectNoteClassQuestion(questionCodes(question))?.version).toBe(question.version)
})

test('live class task rows use the selected version definitions', () => {
  for (const question of noteClassQuestions) {
    const seed = seedClassesFromTasks(questionCodes(question).map(task))
    expect(seed.map(({ definition }) => definition)).toEqual(
      questionCodes(question).map((code) => question.criteria[code]!),
    )
  }
})

test('an unmatched seed skips Jev and names every declaration with the remedy', async () => {
  const seed = seedClassesFromTasks([
    ...['C1', 'C2', 'C4', 'C5', 'C6', 'C7'].map(task),
    task('C10'),
  ])
  const result = await runNoteClassPass([note], seed)
  expect(result.ran).toBeFalse()
  expect(result.remaining).toEqual([note])
  expect(result.status).toContain('skipped')
  for (const question of noteClassQuestions)
    expect(result.status).toContain(
      `v${question.version} ${questionCodes(question).sort().join(',')}`,
    )
  expect(result.status).toContain('declare a new note_class version')
})

test('only a confident seed choice keeps a note off curator pages', async () => {
  const seed = seedClassesFromTasks(['C1', 'C2', 'C4', 'C5', 'C6', 'C7', 'C9'].map(task))
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

test('the selected declaration is asked and names the proposal reason', async () => {
  const v1 = noteClassQuestions.find(({ version }) => version === 1)!
  const seed = seedClassesFromTasks(questionCodes(v1).map(task))
  let askedVersion: number | undefined
  const result = await runNoteClassPass([note], seed, {
    credential: async () => ({ available: true }),
    ask: async ({ question }) => {
      askedVersion = question.version
      return {
        answer: { choice: 'C1', confidence: 0.9, probabilities: {} },
        reused: false,
      }
    },
  })
  expect(askedVersion).toBe(1)
  expect(result.proposals[0]?.reason).toBe('note_class v1 confidence 0.900')
})

test('missing credential asks and records nothing and sends every note to curation', async () => {
  const seed = seedClassesFromTasks(['C1', 'C2', 'C4', 'C5', 'C6', 'C7', 'C9'].map(task))
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
