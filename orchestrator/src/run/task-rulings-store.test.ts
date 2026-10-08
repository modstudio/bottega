import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { TASK_RULINGS_MAX_COUNT } from './task-rulings.ts'
import { taskRulingsForDispatch } from './task-rulings-store.ts'

function root(repo: string, launchKey: string): number {
  const id = addRun({ agent: 'codex', job: 'implement', repo })
  db().query('UPDATE run SET launch_key=? WHERE id=?').run(launchKey, id)
  return id
}

function answeredQuestion(
  runId: number,
  question: string,
  answeredAt: string,
  overturn?: { at: string; replacement: string | null },
): void {
  db()
    .query(
      `INSERT INTO question
         (run_id,asked_at,question,answer,answered_at,answerer_kind,overturned_at,replacement)
       VALUES (?,'2026-09-01',?,'answer',?,'agent',?,?)`,
    )
    .run(runId, question, answeredAt, overturn?.at ?? null, overturn?.replacement ?? null)
}

describe('task ruling candidate query', () => {
  test('filters in SQL, orders by effective date, caps, and reports the full omitted count', () => {
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
          (project,workflow_slug,mode_slug,workflow_key,instance_id,workflow_version,
           catalogue_version,args,ordinal,step_slug,state,closed,question,total_steps,created_at,updated_at)
         VALUES (?, 'fixture-workflow','default','DEV-960','',1,1,'{}',0,'build','running','[]',NULL,1,
                 '2026-09-01','2026-10-05') RETURNING id`,
      )
      .get(PLATFORM_SLUG) as { id: number }
    db()
      .query(
        `INSERT INTO question
        (workflow_cursor_id,workflow_key,asked_at,question,answer,answered_at,answerer_kind,asked_via)
       VALUES (?,'DEV-960','2026-09-01','workflow ruling','workflow answer',
               '2026-10-05T12:00:00.000Z','agent','workflow')`,
      )
      .run(cursor.id)

    const selected = taskRulingsForDispatch({
      resume: false,
      project: PLATFORM_SLUG,
      launchKey: 'DEV-960',
    })

    expect(selected.rulings).toHaveLength(TASK_RULINGS_MAX_COUNT)
    expect(selected.rulings[0]).toMatchObject({
      question: 'workflow ruling',
      ruling: 'workflow answer',
      workflowCursorId: cursor.id,
    })
    expect(selected.rulings.map((ruling) => ruling.question)).not.toContain('withdrawn')
    expect(selected.rulings.map((ruling) => ruling.question)).not.toContain('wrong key')
    expect(selected.rulings.map((ruling) => ruling.question)).not.toContain('wrong project')
    expect(selected.omitted).toBe(5)
  })
})
