import { expect, test } from 'bun:test'
import { database, gather } from './workflow-floor-evidence.fixture.ts'

test('an unresolvable second artifact refuses the close and names that artifact', async () => {
  const d = database()
  expect(
    async () =>
      await gather(d, {
        artifacts: ['task:DEV-977', 'not-an-artifact'],
      }),
  ).toThrow('not-an-artifact')
})

test('a duplicated artifact reference is resolved once', async () => {
  const d = database()
  let reads = 0
  const evidence = await gather(
    d,
    { artifacts: ['task:DEV-977', 'task:DEV-977'] },
    {
      readTask: (key) => {
        reads += 1
        return {
          recordId: `task-${key}`,
          key,
          updatedAt: null,
          status: 'done',
          statusCategory: 'done',
          commentIds: [],
          commentsVerifiable: true,
        }
      },
    },
  )
  expect(reads).toBe(1)
  expect(evidence.artifacts).toHaveLength(1)
})
