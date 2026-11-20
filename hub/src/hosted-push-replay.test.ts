import { expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { hostedTaskRow } from '../test/hosted-push-rows.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { applyHostedPushChangesInTransaction } from './hosted-push-changes.ts'
import { HostedChangeIdMismatchError } from './hosted-push-conflict.ts'
import type { ParsedHostedPushChange } from './push-contract.ts'

test('a replay probe failure is rethrown without remembering an outcome', async () => {
  const statements: string[] = []
  const tx = (async (strings: TemplateStringsArray) => {
    const statement = strings.join('')
    statements.push(statement)
    if (statement.includes('SELECT result FROM hub_applied_change'))
      throw new Error('replay probe failed')
    return []
  }) as unknown as SQL
  tx.unsafe = (async (statement: string) => {
    statements.push(statement)
    return []
  }) as SQL['unsafe']
  const input = [
    {
      table: 'hub_interval',
      id: '01990000-0000-7000-8000-000000001412',
      op: 'delete',
      change_id: '01990000-0000-7000-8000-000000001413',
    },
  ] satisfies ParsedHostedPushChange[]

  await expect(
    applyHostedPushChangesInTransaction(tx, { userId: 'user', spaceId: 'space' }, input),
  ).rejects.toThrow('replay probe failed')
  expect(statements.some((statement) => statement.includes('INSERT INTO hub_applied_change'))).toBe(
    false,
  )
})

test('a change id journaled in another space is refused as a typed mismatch', async () => {
  const spaceId = '01990000-0000-7000-8000-000000001250'
  const otherSpaceId = '01990000-0000-7000-8000-000000001418'
  const userId = '01990000-0000-7000-8000-000000001249'
  const projectId = '01990000-0000-7000-8000-000000000075'
  const id = '01990000-0000-7000-8000-000000001419'
  const changeId = '01990000-0000-7000-8000-00000000141a'
  const database = await createHostedRecordFixture({ spaceId, userId })
  try {
    await database.exec(`
      INSERT INTO project (id,space_id,name,created_at)
      VALUES ('${projectId}','${spaceId}','workshop',now());
      RESET ROLE;
      INSERT INTO space(id,name,slug,created_at)
      VALUES ('${otherSpaceId}','Other journal space','other-journal-space',now());
      INSERT INTO hub_applied_change(change_id,space_id,result,applied_at)
      VALUES ('${changeId}','${otherSpaceId}','{"fingerprint":"other","outcome":{"id":"${id}","status":"applied"}}',now());
      SET ROLE ${RECORD_ACTOR_ROLE};
      SELECT set_config('app.user_id','${userId}',false);
      SELECT set_config('app.space_id','${spaceId}',false);
      SELECT set_config('app.space_ids','${spaceId}',false);
    `)
    const apply = () =>
      database.transaction(async (transaction) => {
        const sql = pgliteSql(transaction as unknown as PGlite)
        sql.unsafe = (async (statement: string) =>
          (await transaction.query(statement)).rows) as SQL['unsafe']
        return applyHostedPushChangesInTransaction(sql, { userId, spaceId }, [
          {
            table: 'hub_task',
            id,
            op: 'upsert',
            row: hostedTaskRow(id, 'DEV-419', projectId),
            change_id: changeId,
          },
        ])
      })
    try {
      await apply()
      throw new Error('expected a cross-space change-id mismatch')
    } catch (error) {
      expect(error).toBeInstanceOf(HostedChangeIdMismatchError)
      expect(error).toMatchObject({ appliedIndex: 0 })
    }
    expect((await database.query(`SELECT 1 FROM hub_task WHERE id=$1`, [id])).rows).toHaveLength(0)
  } finally {
    await database.close()
  }
})
