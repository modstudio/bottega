import { expect, test } from 'bun:test'
import { CURSOR_RECORD_ID, database, gather } from './workflow-floor-evidence.fixture.ts'

test('a satisfied class-measured obligation gathers registered checkout roots', async () => {
  const d = database()
  d.query(
    `INSERT INTO workflow_obligation
      (record_id,cursor_record_id,step_ordinal,step_slug,floor,operator_ruling,floor_deferrable,reason,created_at)
     VALUES ('00000000-0000-4000-8000-000000000002','${CURSOR_RECORD_ID}',1,'measure-class','class-measured',0,0,'measure it','2026-09-01')`,
  ).run()

  expect(
    (
      await gather(d, {
        satisfies: '00000000-0000-4000-8000-000000000002',
      })
    ).registeredCheckoutRoots,
  ).toEqual(expect.arrayContaining(['/fixture', '/other']))
})
