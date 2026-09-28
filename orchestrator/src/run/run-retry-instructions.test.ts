import { describe, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { continuationInstructionsForFreshRetry } from './run-control.ts'
import { renderCheckpointContinuationPrompt } from './run-retry.ts'

const failedRoot = () => addRun({ agent: 'grok', job: 'implement', status: 'failed' })

describe('fresh retry continuation recovery', () => {
  test('checkpoint continuation carries earlier instructions before the new message exactly once', () => {
    const id = failedRoot()
    const first = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 2,
    })
    const second = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 3,
    })
    const insertAudit = db().query(
      `INSERT INTO run_mutation_audit (run_id,root_id,turn_id,action,at,reason)
       VALUES (?,?,?,?,?,?)`,
    )
    insertAudit.run(id, id, first, 'continue', '2026-09-25T10:00:00.000Z', 'first instruction')
    insertAudit.run(id, id, second, 'continue', '2026-09-25T11:00:00.000Z', 'second instruction')

    const prompt = renderCheckpointContinuationPrompt({
      checkpointContext: 'CHECKPOINT RESUME\nResume at abc.',
      originalSpec: 'ROOT SPEC',
      continuationInstructions: continuationInstructionsForFreshRetry(true, id, id),
      message: 'new instruction',
    })

    expect(prompt).toBe(
      'CHECKPOINT RESUME\nResume at abc.\n\n' +
        'ROOT SPEC\n\n' +
        'INSTRUCTIONS GIVEN SINCE THE ORIGINAL SPEC\n\n' +
        `Turn ${first} at 2026-09-25T10:00:00.000Z:\nfirst instruction\n\n` +
        `Turn ${second} at 2026-09-25T11:00:00.000Z:\nsecond instruction\n\n` +
        'new instruction',
    )
    expect(prompt.split('new instruction')).toHaveLength(2)
  })

  test('message-less same-agent retry carries earlier instructions', () => {
    const id = failedRoot()
    const first = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 2,
    })
    const second = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 3,
    })
    const insertAudit = db().query(
      `INSERT INTO run_mutation_audit (run_id,root_id,turn_id,action,at,reason)
       VALUES (?,?,?,?,?,?)`,
    )
    insertAudit.run(id, id, first, 'continue', '2026-09-25T10:00:00.000Z', 'first instruction')
    insertAudit.run(id, id, second, 'continue', '2026-09-25T11:00:00.000Z', 'second instruction')

    const prompt = renderCheckpointContinuationPrompt({
      checkpointContext: 'CHECKPOINT RESUME',
      originalSpec: 'ROOT SPEC',
      continuationInstructions: continuationInstructionsForFreshRetry(true, id, id),
      message: undefined,
    })

    expect(prompt).toContain('first instruction')
    expect(prompt).toContain('second instruction')
    expect(prompt.endsWith('second instruction')).toBe(true)
  })

  test('checkpoint continuation without earlier instructions renders as before', () => {
    expect(
      renderCheckpointContinuationPrompt({
        checkpointContext: 'CHECKPOINT RESUME',
        originalSpec: 'ROOT SPEC',
        continuationInstructions: [],
        message: 'new instruction',
      }),
    ).toBe('CHECKPOINT RESUME\n\nROOT SPEC\n\nnew instruction')
  })

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

  test('recovers the real 6207 chain with answer-created turns and repeated instructions', () => {
    const id = failedRoot()
    addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 2,
      startedAt: '2026-09-24T23:20:30.178Z',
    })
    const continued = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 3,
      startedAt: '2026-09-25T00:00:00.500Z',
    })
    addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 4,
      startedAt: '2026-09-25T01:00:01.000Z',
    })
    const stopped = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'stopped',
      parent: id,
      turn: 5,
      startedAt: '2026-09-25T02:00:00.500Z',
    })
    const final = addRun({
      agent: 'grok',
      job: 'implement',
      status: 'failed',
      parent: id,
      turn: 6,
      startedAt: '2026-09-25T03:00:00.500Z',
    })
    const insertAudit = db().query(
      `INSERT INTO run_mutation_audit (run_id,root_id,action,at,reason)
       VALUES (?,?,?,?,?)`,
    )
    insertAudit.run(id, id, 'answer', '2026-09-24T23:20:29.266Z', null)
    insertAudit.run(id, id, 'continue', '2026-09-25T00:00:00.000Z', 'first instructions')
    insertAudit.run(id, id, 'answer', '2026-09-25T01:00:00.000Z', null)
    insertAudit.run(id, id, 'continue', '2026-09-25T02:00:00.000Z', 'repeated instructions')
    insertAudit.run(id, id, 'continue', '2026-09-25T03:00:00.000Z', 'repeated instructions')

    expect(continuationInstructionsForFreshRetry(true, id, id)).toEqual([
      {
        turnId: continued,
        at: '2026-09-25T00:00:00.000Z',
        instructions: 'first instructions',
      },
      {
        turnId: stopped,
        at: '2026-09-25T02:00:00.000Z',
        instructions: 'repeated instructions',
      },
      {
        turnId: final,
        at: '2026-09-25T03:00:00.000Z',
        instructions: 'repeated instructions',
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
