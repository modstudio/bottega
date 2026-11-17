import { expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { gatherStepQuestionEvidenceFromRows } from '../workflow/workflow-step-question-evidence.ts'
import { questionValuesForWrite, RECORD_QUESTION_STEP_COLUMNS } from './record-question-step.ts'

const CURSOR = '01990000-0000-7000-8000-000000002368'
const QUESTION = '01990000-0000-7000-8000-000000002369'
const STAMP = '2026-11-16T12:00:00.000Z'

function pgliteSql(database: PGlite): SQL {
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let statement = strings[0]!
    for (const [index] of values.entries()) statement += `$${index + 1}${strings[index + 1]!}`
    return (await database.query(statement, values)).rows
  }
  return query as unknown as SQL
}

const payload = {
  id: QUESTION,
  number: 1,
  spaceId: '01990000-0000-7000-8000-000000002360',
  runId: null,
  workflowKey: 'DEV-2368',
  workflowCursorRecordId: CURSOR,
  machineId: '01990000-0000-7000-8000-000000002361',
  revision: 1,
  askedAt: STAMP,
  question: 'Proceed?',
  options: null,
  withheldFields: [],
  createdAt: STAMP,
  updatedAt: STAMP,
}

test('hosted workflow questions keep the step where they were asked', async () => {
  const postgres = new PGlite()
  try {
    await postgres.exec(`
      CREATE TABLE task_flow_stage (
        id uuid PRIMARY KEY, active_ordinal integer NOT NULL, active_slug text NOT NULL
      );
      CREATE TABLE question (
        id uuid PRIMARY KEY, number integer NOT NULL, workflow_cursor_record_id uuid NOT NULL,
        workflow_step_ordinal integer, workflow_step_slug text, answered_at timestamptz,
        answerer_kind text, overturned_at timestamptz, replacement text, closed_at timestamptz
      );
      INSERT INTO task_flow_stage VALUES ('${CURSOR}',6,'design-signoff');
    `)
    const values = await questionValuesForWrite(pgliteSql(postgres), payload, null, null, CURSOR)
    await postgres.query(
      `INSERT INTO question
        (id,number,workflow_cursor_record_id,workflow_step_ordinal,workflow_step_slug)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        values.id,
        values.number,
        values.workflowCursorRecordId,
        values.workflowStepOrdinal,
        values.workflowStepSlug,
      ],
    )
    const read = async () =>
      (
        await postgres.query<Record<string, unknown>>(
          `SELECT q.number,q.answered_at,q.answerer_kind,q.overturned_at,q.replacement,q.closed_at,
                  ${RECORD_QUESTION_STEP_COLUMNS}
             FROM question q JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id`,
        )
      ).rows
    const factsOf = () => ({ state: 'open' as const, answeredAt: null, replacement: null })

    expect(
      gatherStepQuestionEvidenceFromRows(
        await read(),
        { stepOrdinal: 7, stepSlug: 'design-signoff' },
        factsOf,
      ),
    ).toEqual({
      stepQuestion: { id: 1, state: 'open', answeredAt: null, replacement: null },
    })

    await postgres.exec(
      `UPDATE task_flow_stage SET active_ordinal=7,active_slug='implementation' WHERE id='${CURSOR}'`,
    )
    expect(await read()).toMatchObject([
      { workflow_step_ordinal: 7, workflow_step_slug: 'design-signoff' },
    ])
  } finally {
    await postgres.close()
  }
})
