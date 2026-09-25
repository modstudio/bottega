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

  test('overturns a workflow ruling with cursor authority and question audit', () => {
    const cursor = db()
      .query(
        `INSERT INTO workflow_cursor
          (project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
           workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
           total_steps,created_at,updated_at)
         VALUES ('fixture','ship','default','DEV-964','','owner-session',1,1,'{}',0,'build',
                 'running','[]',NULL,1,'2026-09-20','2026-09-21') RETURNING id`,
      )
      .get() as { id: number }
    const question = db()
      .query(
        `INSERT INTO question
          (workflow_cursor_id,workflow_key,asked_at,question,answer,answered_at,answered_by,
           answerer_kind,answer_channel,asked_via)
         VALUES (?,'DEV-964','2026-09-20','Which way?','Old','2026-09-21',
                 'owner-session','agent','cli','workflow') RETURNING id`,
      )
      .get(cursor.id) as { id: number }

    overturnRuling({
      questionId: question.id,
      reason: 'Changed.',
      replacement: 'New.',
      fromOperator: false,
    })
    expect(db().query('SELECT action FROM question_mutation_audit').get()).toEqual({
      action: 'overturn',
    })
    expect(db().query('SELECT action FROM run_mutation_audit').all()).toEqual([])
  })

  test('workflow overturn requires owner authority or operator override and audits the actual actor', () => {
    const cursor = db()
      .query(
        `INSERT INTO workflow_cursor
          (project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
           workflow_version,catalogue_version,args,ordinal,step_slug,state,closed,question,
           total_steps,created_at,updated_at)
         VALUES ('fixture','ship','default','DEV-964','','owner-session',1,1,'{}',0,'build',
                 'running','[]',NULL,1,'2026-09-20','2026-09-21') RETURNING id`,
      )
      .get() as { id: number }
    const question = db()
      .query(
        `INSERT INTO question
          (workflow_cursor_id,workflow_key,asked_at,question,answer,answered_at,asked_via)
         VALUES (?,'DEV-964','2026-09-20','Which?','Old','2026-09-21','workflow') RETURNING id`,
      )
      .get(cursor.id) as { id: number }
    process.env.CLAUDE_CODE_SESSION_ID = 'foreign-session'

    expect(() =>
      overturnRuling({
        questionId: question.id,
        reason: 'Changed.',
        replacement: 'New.',
        fromOperator: false,
      }),
    ).toThrow('owned by session owner-session')
    overturnRuling({
      questionId: question.id,
      reason: 'Changed.',
      replacement: 'New.',
      fromOperator: true,
    })
    expect(db().query('SELECT action,actor_session FROM question_mutation_audit').all()).toEqual([
      { action: 'overturn', actor_session: 'foreign-session' },
    ])
  })
})
