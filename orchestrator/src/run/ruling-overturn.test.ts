import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { overturnRuling } from './ruling-overturn.ts'

let priorSession: string | undefined

beforeEach(() => {
  priorSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
})

afterEach(() => {
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
})

describe('overturn ruling', () => {
  test('records the overturn, replacement, attribution, and audit without changing run state', () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'owner-session' })
    const question = db()
      .query(
        `INSERT INTO question
          (run_id,asked_at,question,answer,answered_at,answered_by,answerer_kind,answer_channel)
         VALUES (?,'2026-09-20','Which way?','Old ruling','2026-09-21','owner-session','agent','cli')
         RETURNING id`,
      )
      .get(run) as { id: number }

    overturnRuling({
      questionId: question.id,
      reason: 'New evidence contradicted it.',
      replacement: 'Use the replacement.',
      fromOperator: true,
    })

    expect(
      db()
        .query(`SELECT overturned_by,overturn_reason,replacement FROM question WHERE id=?`)
        .get(question.id),
    ).toEqual({
      overturned_by: 'operator via owner-session',
      overturn_reason: 'New evidence contradicted it.',
      replacement: 'Use the replacement.',
    })
    expect(db().query('SELECT status FROM run WHERE id=?').get(run)).toEqual({ status: 'ok' })
    expect(
      db().query("SELECT action,reason FROM run_mutation_audit WHERE action='overturn'").get(),
    ).toEqual({ action: 'overturn', reason: 'New evidence contradicted it.' })
  })
})
