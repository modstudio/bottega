import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { db } from '../database/db.ts'
import { resolveComparisonRunIds, scoreNote, scorePathForJob } from './judgment.ts'

const trackResidue = trackedTestResidue()

const flags = (values: Record<string, string>) =>
  ({
    flag: (name: string) => values[name],
  }) as Parameters<typeof scoreNote>[0]

test('inline score notes accept ordinary punctuation and quoted strings', () => {
  expect(scoreNote(flags({ note: 'The households\' reports quote "caught value".' }))).toBe(
    'The households\' reports quote "caught value".',
  )
})

test('a note file is content and bypasses shell-fragment checks', () => {
  const root = trackResidue(join(dir, 'score-note-file'))
  mkdirSync(root, { recursive: true })
  const path = join(root, 'note.txt')
  writeFileSync(path, "The households' note says `caught value`.")
  expect(scoreNote(flags({ 'note-file': path }))).toBe("The households' note says `caught value`.")
})

test('a lone inline backtick is refused as an unexpanded shell fragment', () => {
  expect(() => scoreNote(flags({ note: '`' }))).toThrow('unexpanded shell fragment')
})

test('comparison flags resolve mixed run numbers and UUIDs and deduplicate by row', () => {
  const first = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const second = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const secondRecordId = (
    db().query('SELECT record_id FROM run WHERE record_id=?').get(second) as { record_id: string }
  ).record_id
  const mixed = resolveComparisonRunIds({
    has: () => false,
    values: () => [],
    flag: (name) => (name === 'better-than' ? `${first},${secondRecordId}` : undefined),
  })
  expect(mixed.flag('better-than')).toBe(`${first},${second}`)
  expect(() =>
    resolveComparisonRunIds({
      has: () => false,
      values: () => [],
      flag: (name) => (name === 'same-as' ? `${second},${secondRecordId}` : undefined),
    }).flag('same-as'),
  ).toThrow('same run more than once')
})

test('comparison flags refuse an unknown run UUID', () => {
  expect(() =>
    resolveComparisonRunIds({
      has: () => false,
      values: () => [],
      flag: (name) => (name === 'worse-than' ? '01990000-0000-7000-8000-000000000099' : undefined),
    }).flag('worse-than'),
  ).toThrow('no run matches')
})

test('findings jobs take the judge path and another job takes the score path', () => {
  expect(scorePathForJob('review-lens')).toBe('judge')
  expect(scorePathForJob('implement')).toBe('score')
})

test('voiding a findings run takes the score path, and the score path refuses discard', () => {
  const given =
    (...names: string[]) =>
    (name: string) =>
      names.includes(name)
  expect(scorePathForJob('review-lens', given('void'))).toBe('score')
  expect(scorePathForJob('review-lens', given('discard'))).toBe('judge')
  expect(() => scorePathForJob('implement', given('discard'))).toThrow('--discard applies only')
  expect(() => scorePathForJob('review-lens', given('void', 'discard'))).toThrow(
    '--discard applies only',
  )
  expect(scorePathForJob('review-lens', given('finding'))).toBe('judge')
  expect(() => scorePathForJob('review-lens', given('scorer', 'finding'))).toThrow(
    '--finding applies only',
  )
})
