import { expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { questionValuesForWrite } from './record-question-step.ts'

const CURSOR = '01990000-0000-7000-8000-000000002370'
const STAMP = '2026-11-16T12:00:00.000Z'

function pgliteSql(database: PGlite): SQL {
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let statement = strings[0]!
    for (const [index] of values.entries()) statement += `$${index + 1}${strings[index + 1]!}`
    return (await database.query(statement, values)).rows
  }
  return query as unknown as SQL
}

test('hosted question write values take the cursor step on the one-based ordinal', async () => {
  const postgres = new PGlite()
  try {
    await postgres.exec(`
      CREATE TABLE task_flow_stage (
        id uuid PRIMARY KEY, active_ordinal integer NOT NULL, active_slug text NOT NULL
      );
      INSERT INTO task_flow_stage VALUES ('${CURSOR}',6,'design-signoff');
    `)
    const values = await questionValuesForWrite(
      pgliteSql(postgres),
      {
        id: '01990000-0000-7000-8000-000000002371',
        number: 1,
        spaceId: '01990000-0000-7000-8000-000000002372',
        workflowCursorRecordId: CURSOR,
        machineId: '01990000-0000-7000-8000-000000002373',
        revision: 1,
        askedAt: STAMP,
        question: 'Proceed?',
        options: null,
        withheldFields: [],
        createdAt: STAMP,
        updatedAt: STAMP,
      },
      null,
      null,
      CURSOR,
    )

    expect(values).toMatchObject({
      workflowStepOrdinal: 7,
      workflowStepSlug: 'design-signoff',
    })
  } finally {
    await postgres.close()
  }
})
