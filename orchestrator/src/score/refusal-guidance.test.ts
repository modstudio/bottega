import { describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { newestTurnOutputPath } from '../evidence/evidence-query.ts'
import { jobTakesFidelity } from '../jobs/job-fidelity.ts'
import { JOBS } from '../jobs/jobs.ts'
import { refusalScoreGuidance, refusalScoreGuidanceFromPath } from './refusal-guidance.ts'

type Fixture = {
  writingJobs: string[]
  replies: {
    shortRefused: Record<string, unknown>
    longRefused: Record<string, unknown>
    done: Record<string, unknown>
  }
  expected: { writing: string; nonWriting: string; longNonWriting: string }
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./refusal-guidance.fixture.json', import.meta.url)), 'utf8'),
) as Fixture

function replyPath(name: string, reply: Record<string, unknown>): string {
  const path = join(dir, `${name}-${crypto.randomUUID()}.json`)
  writeFileSync(path, JSON.stringify(reply))
  return path
}

describe('refusal score guidance', () => {
  test('the shared fixture pins wording, truncation, and the scorer writing-job set', () => {
    const declared = Object.keys(JOBS)
      .filter((name) => JOBS[name]?.needs.writesRepo)
      .sort()
    expect(declared).toEqual([...fixture.writingJobs].sort())
    expect(Object.keys(JOBS).filter(jobTakesFidelity).sort()).toEqual(declared)
    expect(refusalScoreGuidance(JSON.stringify(fixture.replies.shortRefused), 'implement')).toBe(
      fixture.expected.writing,
    )
    expect(refusalScoreGuidance(JSON.stringify(fixture.replies.shortRefused), 'craft')).toBe(
      fixture.expected.nonWriting,
    )
    expect(refusalScoreGuidance(JSON.stringify(fixture.replies.longRefused), 'craft')).toBe(
      fixture.expected.longNonWriting,
    )
  })

  test('a root whose newest turn refused yields the mark', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    const older = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    const newest = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 3 })
    const rootOutput = replyPath('done-root', fixture.replies.done)
    const olderOutput = replyPath('done-older', fixture.replies.done)
    const newestOutput = replyPath('refused-newest', fixture.replies.shortRefused)
    db().query('UPDATE run SET output_path=? WHERE record_id=?').run(rootOutput, root)
    db().query('UPDATE run SET output_path=? WHERE record_id=?').run(olderOutput, older)
    db().query('UPDATE run SET output_path=? WHERE record_id=?').run(newestOutput, newest)
    try {
      expect(refusalScoreGuidanceFromPath(newestTurnOutputPath(db(), root), 'implement')).toBe(
        fixture.expected.writing,
      )
    } finally {
      rmSync(rootOutput, { force: true })
      rmSync(olderOutput, { force: true })
      rmSync(newestOutput, { force: true })
    }
  })

  test('an unchained refused root yields the mark', () => {
    const root = addRun({ agent: 'codex', job: 'craft' })
    const output = replyPath('refused-root', fixture.replies.shortRefused)
    db().query('UPDATE run SET output_path=? WHERE record_id=?').run(output, root)
    try {
      expect(refusalScoreGuidanceFromPath(newestTurnOutputPath(db(), root), 'craft')).toBe(
        fixture.expected.nonWriting,
      )
    } finally {
      rmSync(output, { force: true })
    }
  })

  test('a done newest turn or no output path yields no mark', () => {
    const done = addRun({ agent: 'codex', job: 'implement' })
    const absent = addRun({ agent: 'codex', job: 'implement' })
    const output = replyPath('done', fixture.replies.done)
    db().query('UPDATE run SET output_path=? WHERE record_id=?').run(output, done)
    try {
      expect(refusalScoreGuidanceFromPath(newestTurnOutputPath(db(), done), 'implement')).toBeNull()
      expect(
        refusalScoreGuidanceFromPath(newestTurnOutputPath(db(), absent), 'implement'),
      ).toBeNull()
    } finally {
      rmSync(output, { force: true })
    }
  })
})
