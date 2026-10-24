import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
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
          (number,record_id,run_record_id,asked_at,question,answer,answered_at,answered_by,answerer_kind,answer_channel)
         VALUES (1,'${newRecordId()}',?,'2026-09-20','Which way?','Old ruling','2026-09-21','owner-session','agent','cli')
         RETURNING record_id`,
      )
      .get(run) as { record_id: string }

    overturnRuling({
      questionId: question.record_id,
      reason: 'New evidence contradicted it.',
      replacement: 'Use the replacement.',
      fromOperator: true,
    })

    expect(
      db()
        .query(`SELECT overturned_by,overturn_reason,replacement FROM question WHERE record_id=?`)
        .get(question.record_id),
    ).toEqual({
      overturned_by: 'operator via owner-session',
      overturn_reason: 'New evidence contradicted it.',
      replacement: 'Use the replacement.',
    })
    expect(db().query('SELECT status FROM run WHERE record_id=?').get(run)).toEqual({
      status: 'ok',
    })
    expect(
      db().query("SELECT action,reason FROM run_mutation_audit WHERE action='overturn'").get(),
    ).toEqual({ action: 'overturn', reason: 'New evidence contradicted it.' })
  })

  test('overturns a workflow ruling with cursor authority and question audit', () => {
    const cursor = db()
      .query(
        `INSERT INTO workflow_cursor
          (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
           workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,question,
           total_steps,created_at,updated_at)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture','fixture-workflow','default','DEV-964','','owner-session',?,?,'{}',0,'build',
                 'running','[]',NULL,1,'2026-09-20','2026-09-21') RETURNING record_id`,
      )
      .get(workflowVersionRecordId(db()), catalogueVersionRecordId(db())) as { record_id: string }
    const question = db()
      .query(
        `INSERT INTO question
          (number,record_id,workflow_cursor_record_id,workflow_key,asked_at,question,answer,answered_at,answered_by,
           answerer_kind,answer_channel,asked_via)
         VALUES (1,'${newRecordId()}',?,'DEV-964','2026-09-20','Which way?','Old','2026-09-21',
                 'owner-session','agent','cli','workflow') RETURNING record_id`,
      )
      .get(cursor.record_id) as { record_id: string }

    overturnRuling({
      questionId: question.record_id,
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
          (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
           workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,question,
           total_steps,created_at,updated_at)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture','fixture-workflow','default','DEV-964','','owner-session',?,?,'{}',0,'build',
                 'running','[]',NULL,1,'2026-09-20','2026-09-21') RETURNING record_id`,
      )
      .get(workflowVersionRecordId(db()), catalogueVersionRecordId(db())) as { record_id: string }
    const question = db()
      .query(
        `INSERT INTO question
          (number,record_id,workflow_cursor_record_id,workflow_key,asked_at,question,answer,answered_at,asked_via)
         VALUES (1,'${newRecordId()}',?,'DEV-964','2026-09-20','Which?','Old','2026-09-21','workflow') RETURNING record_id`,
      )
      .get(cursor.record_id) as { record_id: string }
    db()
      .query('UPDATE workflow_cursor SET updated_at=? WHERE record_id=?')
      .run(new Date().toISOString(), cursor.record_id)
    process.env.CLAUDE_CODE_SESSION_ID = 'foreign-session'

    expect(() =>
      overturnRuling({
        questionId: question.record_id,
        reason: 'Changed.',
        replacement: 'New.',
        fromOperator: false,
      }),
    ).toThrow('owned by session owner-session')
    overturnRuling({
      questionId: question.record_id,
      reason: 'Changed.',
      replacement: 'New.',
      fromOperator: true,
    })
    expect(db().query('SELECT action,actor_session FROM question_mutation_audit').all()).toEqual([
      { action: 'overturn', actor_session: 'foreign-session' },
    ])
  })
})
