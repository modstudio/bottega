import { describe, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { continuationInstructionsForFreshRetry } from './run-answer.ts'

const failedRoot = () => addRun({ agent: 'grok', job: 'implement', status: 'failed' })

describe('fresh retry continuation recovery', () => {
  test('recovers the real 6442 chain with legacy audits on both sides of start', () => {
    const id = failedRoot()
    const turn6445 = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 2,
      startedAt: '2026-09-25T09:10:55.576Z',
    })
    const turn6500 = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 3,
      startedAt: '2026-09-25T14:48:05.591Z',
    })
    const turn6513 = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 4,
      startedAt: '2026-09-25T15:21:16.986Z',
    })
    const insertAudit = db().query(
      `INSERT INTO run_mutation_audit (run_id,root_id,action,at,reason)
       VALUES (?,?,?,?,?)`,
    )
    insertAudit.run(id, id, 'continue', '2026-09-25T09:10:54.846Z', 'instructions for 6445')
    insertAudit.run(id, id, 'continue', '2026-09-25T14:48:06.417Z', 'instructions for 6500')
    insertAudit.run(id, id, 'retry', '2026-09-25T14:49:29.674Z', 'retried as run 6503')
    insertAudit.run(id, id, 'continue', '2026-09-25T15:21:16.144Z', 'instructions for 6513')

    expect(continuationInstructionsForFreshRetry(true, id, id)).toEqual([
      {
        turnId: turn6445,
        at: '2026-09-25T09:10:54.846Z',
        instructions: 'instructions for 6445',
      },
      {
        turnId: turn6500,
        at: '2026-09-25T14:48:06.417Z',
        instructions: 'instructions for 6500',
      },
      {
        turnId: turn6513,
        at: '2026-09-25T15:21:16.144Z',
        instructions: 'instructions for 6513',
      },
    ])
  })

  test('uses audit turn identity without timestamp inference', () => {
    const id = failedRoot()
    const child = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 2,
      startedAt: '2026-09-25T09:10:55.576Z',
    })
    db()
      .query(
        `INSERT INTO run_mutation_audit (run_id,root_id,turn_id,action,at,reason)
       VALUES (?,?,?,?,?,?)`,
      )
      .run(id, id, child, 'continue', '2026-09-25T10:00:00.000Z', 'identified instructions')

    expect(continuationInstructionsForFreshRetry(true, id, id)).toEqual([
      {
        turnId: child,
        at: '2026-09-25T10:00:00.000Z',
        instructions: 'identified instructions',
      },
    ])
  })

  test('identifies a same-agent retry despite its companion continue audit', () => {
    const id = failedRoot()
    const child = addRun({ agent: 'grok', job: 'implement', status: 'failed', parent: id, turn: 2 })
    const insertAudit = db().query(
      `INSERT INTO run_mutation_audit (run_id,root_id,turn_id,action,at,reason)
       VALUES (?,?,?,?,?,?)`,
    )
    insertAudit.run(id, id, child, 'continue', '2026-09-25T10:00:00.000Z', null)
    insertAudit.run(id, id, child, 'retry', '2026-09-25T10:00:00.001Z', `continued as run ${child}`)

    expect(continuationInstructionsForFreshRetry(true, id, id)).toEqual([])
  })

  test('accepts a message-less continuation without adding instructions', () => {
    const id = failedRoot()
    const child = addRun({ agent: 'grok', job: 'implement', status: 'failed', parent: id, turn: 2 })
    db()
      .query(
        `INSERT INTO run_mutation_audit (run_id,root_id,turn_id,action,at,reason)
       VALUES (?,?,?,?,?,NULL)`,
      )
      .run(id, id, child, 'continue', '2026-09-25T09:10:55.600Z')

    expect(continuationInstructionsForFreshRetry(true, id, id)).toEqual([])
  })

  test('refuses ambiguous legacy audit attribution', () => {
    const id = failedRoot()
    const child = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 2,
      startedAt: '2026-09-25T09:10:55.576Z',
    })
    const insertAudit = db().query(
      `INSERT INTO run_mutation_audit (run_id,root_id,action,at,reason)
       VALUES (?,?,?,?,?)`,
    )
    insertAudit.run(id, id, 'continue', '2026-09-25T09:10:54.846Z', 'first candidate')
    insertAudit.run(id, id, 'continue', '2026-09-25T09:10:56.127Z', 'second candidate')

    expect(() => continuationInstructionsForFreshRetry(true, id, id)).toThrow(
      `run ${id} continuation turn ${child} has no recoverable continue instructions. ` +
        `Re-send the instructions with orch continue ${id} --file <spec>, ` +
        `or pass orch retry ${child} for that turn directly.`,
    )
  })
})
