import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { TASK_RULINGS_MAX_COUNT } from './task-rulings.ts'
import { taskRulingsForDispatch } from './task-rulings-store.ts'

function root(repo: string, launchKey: string): string {
  const id = addRun({ agent: 'codex', job: 'implement', repo })
  db()
    .query(
      'UPDATE run SET launch_key=?,project_record_id=(SELECT record_id FROM project WHERE name=?) WHERE record_id=?',
    )
    .run(launchKey, repo, id)
  return id
}

function answeredQuestion(
  runId: string,
  question: string,
  answeredAt: string,
  overturn?: { at: string; replacement: string | null },
): void {
  db()
    .query(
      `INSERT INTO question
         (number,record_id,run_record_id,asked_at,question,answer,answered_at,answerer_kind,overturned_at,replacement)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,'2026-09-01',?,'answer',?,'agent',?,?)`,
    )
    .run(runId, question, answeredAt, overturn?.at ?? null, overturn?.replacement ?? null)
}

describe('task ruling candidate query', () => {
  test('filters in SQL, orders by effective date, caps, and reports the full omitted count', () => {
    upsertProject({
      recordId: newRecordId(),
      name: PLATFORM_SLUG,
      path: `/fixture/${PLATFORM_SLUG}`,
    })
    upsertProject({ recordId: newRecordId(), name: 'other', path: '/fixture/other' })
    const matching = root(PLATFORM_SLUG, 'DEV-960')
    const otherKey = root(PLATFORM_SLUG, 'DEV-999')
    const otherProject = root('other', 'DEV-960')
    for (let index = 1; index <= TASK_RULINGS_MAX_COUNT + 3; index += 1) {
      answeredQuestion(
        matching,
        `matching ${index}`,
        `2026-09-${String(index).padStart(2, '0')}T12:00:00.000Z`,
      )
    }
    answeredQuestion(matching, 'withdrawn', '2026-09-30T12:00:00.000Z', {
      at: '2026-10-02T12:00:00.000Z',
      replacement: null,
    })
    answeredQuestion(matching, 'replaced', '2026-09-01T12:00:00.000Z', {
      at: '2026-10-01T12:00:00.000Z',
      replacement: 'new answer',
    })
    answeredQuestion(otherKey, 'wrong key', '2026-10-03T12:00:00.000Z')
    answeredQuestion(otherProject, 'wrong project', '2026-10-04T12:00:00.000Z')
    const cursor = db()
      .query(
        `INSERT INTO workflow_cursor
          (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,workflow_version_record_id,
           catalogue_version_record_id,args,ordinal,step_slug,state,closed,question,total_steps,created_at,updated_at)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),?,(SELECT record_id FROM project WHERE name=?),'fixture-workflow','default','DEV-960','',?,?,'{}',0,'build','running','[]',NULL,1,
                 '2026-09-01','2026-10-05') RETURNING record_id`,
      )
      .get(
        newRecordId(),
        PLATFORM_SLUG,
        PLATFORM_SLUG,
        workflowVersionRecordId(db()),
        catalogueVersionRecordId(db()),
      ) as { record_id: string }
    db()
      .query(
        `INSERT INTO question
        (number,record_id,workflow_cursor_record_id,workflow_key,asked_at,question,answer,answered_at,answerer_kind,asked_via)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,'DEV-960','2026-09-01','workflow ruling','workflow answer',
               '2026-10-05T12:00:00.000Z','agent','workflow')`,
      )
      .run(cursor.record_id)
    db().query("UPDATE project SET name='renamed-fixture' WHERE name=?").run(PLATFORM_SLUG)

    const selected = taskRulingsForDispatch({
      resume: false,
      project: 'renamed-fixture',
      launchKey: 'DEV-960',
    })

    expect(selected.rulings).toHaveLength(TASK_RULINGS_MAX_COUNT)
    expect(selected.rulings[0]).toMatchObject({
      question: 'workflow ruling',
      ruling: 'workflow answer',
      workflowCursorId: cursor.record_id,
    })
    expect(selected.rulings.map((ruling) => ruling.question)).not.toContain('withdrawn')
    expect(selected.rulings.map((ruling) => ruling.question)).not.toContain('wrong key')
    expect(selected.rulings.map((ruling) => ruling.question)).not.toContain('wrong project')
    expect(selected.omitted).toBe(5)
  })

  test('carries the operator name, preferring the overturner of a replaced ruling', () => {
    upsertProject({ recordId: newRecordId(), name: PLATFORM_SLUG, path: `/fixture/${PLATFORM_SLUG}` })
    const run = root(PLATFORM_SLUG, 'DEV-960')
    db()
      .query(
        `INSERT INTO question
           (number,record_id,run_record_id,asked_at,question,answer,answered_at,answerer_kind,answered_by_name,
            overturned_at,overturned_by_name,replacement)
         VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,'2026-09-01',?,'answer',?,'operator','Ada Lovelace',?,?,?)`,
      )
      .run(newRecordId(), run, 'answered', '2026-09-02T12:00:00.000Z', null, null, null)
    db()
      .query(
        `INSERT INTO question
           (number,record_id,run_record_id,asked_at,question,answer,answered_at,answerer_kind,answered_by_name,
            overturned_at,overturned_by_name,replacement)
         VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,'2026-09-01',?,'answer',?,'operator','Ada Lovelace',?,?,?)`,
      )
      .run(
        newRecordId(),
        run,
        'replaced',
        '2026-09-01T12:00:00.000Z',
        '2026-09-03T12:00:00.000Z',
        'Grace Hopper',
        'new answer',
      )

    const selected = taskRulingsForDispatch({ resume: false, project: PLATFORM_SLUG, launchKey: 'DEV-960' })

    const ruledBy = Object.fromEntries(selected.rulings.map((ruling) => [ruling.question, ruling.ruledBy]))
    expect(ruledBy).toEqual({
      answered: 'Ada Lovelace (operator)',
      replaced: 'Grace Hopper (operator)',
    })
  })
})
