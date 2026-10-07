import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  formatRecordedGateResult,
  type RecordedGateCandidate,
  recordedGateResult,
  selectRecordedGateResult,
} from './gate-result.ts'

const readerPath = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const otherPath = `${readerPath}/orchestrator`
const unregisteredCwd = '/unregistered/gate-cwd'

function insertProject(name: string, path: string): number {
  return (
    db()
      .query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?) RETURNING id')
      .get(name, path, 'bun', '{}') as { id: number }
  ).id
}

function insertRun(projectId: number, job: string, headCommit: string): number {
  const id = addRun({ agent: 'codex', job, status: 'running', headCommit })
  db().query('UPDATE run SET project_id=? WHERE id=?').run(projectId, id)
  return id
}

function insertGate(input: {
  runId: number | null
  finishedAt: string
  exitCode: number
  headCommit: string
  cwd?: string | null
  outputTail?: string
}): number {
  return (
    db()
      .query(
        `INSERT INTO gate_execution
          (run_id,requested_at,finished_at,exit_code,timed_out,elapsed_ms,output_tail,head_commit,cwd)
         VALUES (?,?,?,?,0,1000,?,?,?) RETURNING id`,
      )
      .get(
        input.runId,
        input.finishedAt,
        input.finishedAt,
        input.exitCode,
        input.outputTail ?? `gate ${input.exitCode}`,
        input.headCommit,
        input.cwd ?? null,
      ) as { id: number }
  ).id
}

test('recorded gate result is the most recent finished execution for the exact project commit', () => {
  const row = (
    id: number,
    projectId: number,
    headCommit: string,
    finishedAt: string,
  ): RecordedGateCandidate => ({
    id,
    projectId,
    headCommit,
    runId: id + 100,
    exitCode: 0,
    timedOut: false,
    elapsedMs: 20,
    finishedAt,
    outputTail: `gate ${id}`,
  })
  const target = { projectId: 7, headCommit: 'reviewed' }
  expect(
    selectRecordedGateResult(
      [
        row(1, 7, 'reviewed', '2026-09-30T12:00:00.000Z'),
        row(2, 8, 'reviewed', '2026-10-01T12:00:00.000Z'),
        row(3, 7, 'other', '2026-10-01T13:00:00.000Z'),
        row(4, 7, 'reviewed', '2026-10-01T11:00:00.000Z'),
        row(5, 7, 'reviewed', '2026-10-01T11:00:00.000Z'),
      ],
      target,
    )?.id,
  ).toBe(5)
  expect(
    selectRecordedGateResult([row(6, 8, 'reviewed', '2026-10-01T14:00:00.000Z')], target),
  ).toBeNull()
})

test('a later passing orch gate run beats a cancelled worker gate on the same commit', () => {
  const commit = 'reviewed-commit'
  const projectId = insertProject('reader', readerPath)
  const reader = insertRun(projectId, 'review-lens', commit)
  const writer = insertRun(projectId, 'implement', commit)
  insertGate({
    runId: writer,
    finishedAt: '2026-10-01T10:00:00.000Z',
    exitCode: -1,
    headCommit: commit,
    outputTail: 'cancelled',
  })
  const passing = insertGate({
    runId: null,
    finishedAt: '2026-10-01T11:00:00.000Z',
    exitCode: 0,
    headCommit: commit,
    cwd: readerPath,
    outputTail: 'architect passed',
  })
  expect(recordedGateResult(reader).result?.id).toBe(passing)
})

test('the only finished gate may be a row with no run', () => {
  const commit = 'solo-commit'
  const projectId = insertProject('reader', readerPath)
  const reader = insertRun(projectId, 'review-lens', commit)
  const passing = insertGate({
    runId: null,
    finishedAt: '2026-10-01T11:00:00.000Z',
    exitCode: 0,
    headCommit: commit,
    cwd: `${readerPath}/hub`,
    outputTail: 'architect only',
  })
  expect(recordedGateResult(reader).result?.id).toBe(passing)
})

test('a row with no run is not returned for another project or an unregistered cwd', () => {
  const commit = 'foreign-commit'
  const readerProject = insertProject('reader', readerPath)
  insertProject('other', otherPath)
  const reader = insertRun(readerProject, 'review-lens', commit)
  insertGate({
    runId: null,
    finishedAt: '2026-10-01T11:00:00.000Z',
    exitCode: 0,
    headCommit: commit,
    cwd: otherPath,
    outputTail: 'other project',
  })
  insertGate({
    runId: null,
    finishedAt: '2026-10-01T12:00:00.000Z',
    exitCode: 0,
    headCommit: commit,
    cwd: unregisteredCwd,
    outputTail: 'unregistered',
  })
  expect(recordedGateResult(reader).result).toBeNull()
})

test('formatRecordedGateResult names orch gate run when the row has no run', () => {
  const formatted = formatRecordedGateResult({
    headCommit: 'abc',
    result: {
      id: 9,
      projectId: 1,
      headCommit: 'abc',
      runId: null,
      exitCode: 0,
      timedOut: false,
      elapsedMs: 10,
      finishedAt: '2026-10-01T12:00:00.000Z',
      outputTail: 'ok',
    },
  })
  expect(formatted).toBe(
    [
      'Recorded gate result for commit abc:',
      "This result was recorded by the project's writer gate or by orch gate run for that commit.",
      'recorded by: orch gate run',
      'exit code: 0',
      'timed out: false',
      'elapsed ms: 10',
      'finished at: 2026-10-01T12:00:00.000Z',
      'output tail:',
      'ok',
    ].join('\n'),
  )
})
