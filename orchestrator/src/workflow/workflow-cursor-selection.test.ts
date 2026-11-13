import { expect, test } from 'bun:test'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { selectByHandle } from './workflow-cursor-selection.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'

test('a local cursor handle resolves outside a registered project without a project option', async () => {
  const d = database()
  const composed = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )
  d.query('UPDATE project SET path=? WHERE name=?').run('/fixture-not-this-cwd', 'fixture')

  expect((await selectByHandle(composed.cursor!.id, {}, d)).record_id).toBe(
    d
      .query<{ record_id: string }, [number]>(
        'SELECT record_id FROM workflow_cursor WHERE number=?',
      )
      .get(composed.cursor!.id)!.record_id,
  )
})
