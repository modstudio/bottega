import { expect, test } from 'bun:test'
import { database, gather } from './workflow-floor-evidence.fixture.ts'

test('numbered pull-request artifacts resolve through their number and still enforce identity', async () => {
  const references: Array<number | string> = []
  const viewPullRequest = (_project: string, reference: number | string) => {
    references.push(reference)
    return {
      state: 'OPEN' as const,
      mergedAt: null,
      headRefName: 'DEV-977-work',
      baseRefName: 'main',
      url: `https://github.com/acme/app/pull/${reference === 16 ? 15 : reference}`,
    }
  }
  expect(
    (await gather(database(), { artifacts: ['#15'] }, { viewPullRequest })).artifacts?.[0],
  ).toMatchObject({
    artifact: { ref: '#15', exists: true },
    pullRequest: { url: 'https://github.com/acme/app/pull/15', head: 'DEV-977-work' },
  })
  await expect(
    gather(database(), { artifacts: ['#16'] }, { viewPullRequest }),
  ).rejects.toThrow('resolved as https://github.com/acme/app/pull/15')
  expect(references).toEqual([15, 16])
})

test('commit artifacts resolve through the project checkout and refuse an unresolved SHA', async () => {
  const resolved = '1234567890123456789012345678901234567890'
  expect(
    (
      await gather(
        database(),
        { artifacts: ['abc1234'] },
        {
          resolveCommit: (checkout, reference) => {
            expect([checkout, reference]).toEqual(['/fixture', 'abc1234'])
            return resolved
          },
        },
      )
    ).artifacts?.[0]?.artifact,
  ).toEqual({ ref: resolved, exists: true })
  await expect(
    gather(
      database(),
      { artifacts: ['def5678'] },
      {
        resolveCommit: () => {
          throw new Error('def5678 does not resolve to a commit in /fixture')
        },
      },
    ),
  ).rejects.toThrow('does not resolve to a commit')
})
