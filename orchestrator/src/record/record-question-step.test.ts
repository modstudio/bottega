import { expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { sql } from 'drizzle-orm'
import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { gatherStepQuestionEvidenceFromRows } from '../workflow/workflow-step-question-evidence.ts'
import { questionValuesForWrite, RECORD_QUESTION_STEP_COLUMNS } from './record-question-step.ts'

const CURSOR = '01990000-0000-7000-8000-000000002368'
const QUESTION = '01990000-0000-7000-8000-000000002369'
const STAMP = '2026-11-16T12:00:00.000Z'

const questionConflictRecord = pgTable('question', {
  id: uuid().primaryKey(),
  workflowStepOrdinal: integer('workflow_step_ordinal'),
  workflowStepSlug: text('workflow_step_slug'),
})

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

test('hosted question conflict updates preserve the step where the question was asked', async () => {
  const postgres = new PGlite()
  try {
    await postgres.exec(`
      CREATE TABLE task_flow_stage (
        id uuid PRIMARY KEY, active_ordinal integer NOT NULL, active_slug text NOT NULL
      );
      CREATE TABLE question (
        id uuid PRIMARY KEY, workflow_step_ordinal integer, workflow_step_slug text
      );
      INSERT INTO task_flow_stage VALUES ('${CURSOR}',6,'design-signoff');
    `)
    const database = drizzle({ client: postgres })
    const first = await questionValuesForWrite(pgliteSql(postgres), payload, null, null, CURSOR)
    const write = (values: typeof first) =>
      database
        .insert(questionConflictRecord)
        .values({
          id: values.id,
          workflowStepOrdinal: values.workflowStepOrdinal,
          workflowStepSlug: values.workflowStepSlug,
        })
        .onConflictDoUpdate({
          target: questionConflictRecord.id,
          set: {
            workflowStepOrdinal: sql`COALESCE(${questionConflictRecord.workflowStepOrdinal}, excluded.workflow_step_ordinal)`,
            workflowStepSlug: sql`COALESCE(${questionConflictRecord.workflowStepSlug}, excluded.workflow_step_slug)`,
          },
        })

    await write(first)
    await postgres.exec(
      `UPDATE task_flow_stage SET active_ordinal=7,active_slug='implementation' WHERE id='${CURSOR}'`,
    )
    const second = await questionValuesForWrite(pgliteSql(postgres), payload, null, null, CURSOR)
    await write(second)

    expect(
      (
        await postgres.query(
          'SELECT workflow_step_ordinal,workflow_step_slug FROM question WHERE id=$1',
          [QUESTION],
        )
      ).rows,
    ).toEqual([{ workflow_step_ordinal: 7, workflow_step_slug: 'design-signoff' }])

    const hostedWrite = await Bun.file(
      new URL('./record-question-write.ts', import.meta.url),
    ).text()
    expect(hostedWrite).toContain(
      'workflowStepOrdinal: drizzleSql`COALESCE($' +
        '{questionRecord.workflowStepOrdinal}, excluded.workflow_step_ordinal)`',
    )
  } finally {
    await postgres.close()
  }
})

test('legacy hosted questions without a stored step use the one-based cursor step', async () => {
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
      INSERT INTO question
        (id,number,workflow_cursor_record_id,workflow_step_ordinal,workflow_step_slug)
      VALUES ('${QUESTION}',1,'${CURSOR}',NULL,NULL);
    `)
    const rows = (
      await postgres.query<Record<string, unknown>>(
        `SELECT q.number,q.answered_at,q.answerer_kind,q.overturned_at,q.replacement,q.closed_at,
                ${RECORD_QUESTION_STEP_COLUMNS}
           FROM question q JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id`,
      )
    ).rows

    expect(
      gatherStepQuestionEvidenceFromRows(
        rows,
        { stepOrdinal: 7, stepSlug: 'design-signoff' },
        () => ({ state: 'open' as const, answeredAt: null, replacement: null }),
      ),
    ).toEqual({
      stepQuestion: { id: 1, state: 'open', answeredAt: null, replacement: null },
    })
  } finally {
    await postgres.close()
  }
})
