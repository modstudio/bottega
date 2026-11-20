import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { applyHostedPushChangesInTransaction } from './hosted-push-changes.ts'
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
