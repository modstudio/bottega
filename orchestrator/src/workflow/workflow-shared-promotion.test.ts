import { describe, expect, test } from 'bun:test'
import {
  promoteSharedWorkflowSpaces,
  sharedWorkflowPromotionSpaces,
  type WorkflowPromotionVersion,
} from './workflow-shared-promotion.ts'

const shared = (
  spaceId: string | null,
  n: number,
  status: WorkflowPromotionVersion['status'] = 'production',
): WorkflowPromotionVersion => ({ spaceId, n, status, author: 'seed' })

describe('shared workflow promotion spaces', () => {
  test('moves every shared space on an earlier version and reports an authored override', () => {
    const versions = [
      shared('source', 17, 'retired'),
      shared('source', 20, 'draft'),
      shared('space-a', 17),
      shared('space-b', 17),
      shared('space-c', 17),
      shared(null, 17),
      { ...shared('own-space', 17), author: 'architect' },
    ]

    expect(sharedWorkflowPromotionSpaces(versions, 20, 'seed')).toEqual({
      changed: ['source', 'space-a', 'space-b', 'space-c', null],
      overrides: ['own-space'],
    })
  })

  test('copies and promotes the shared history in three spaces while keeping an override', async () => {
    const versions = [
        shared('source', 17, 'retired'),
        shared('source', 18, 'retired'),
        shared('source', 19, 'retired'),
        shared('source', 20, 'draft'),
        shared('space-a', 17),
        shared('space-b', 17),
        shared('space-c', 17),
        { ...shared('own-space', 17), author: 'architect' },
      ],
      copied: string[] = [],
      promoted: (string | null)[] = []

    const report = await promoteSharedWorkflowSpaces({
      slug: 'ship-task',
      targetVersion: 20,
      sourceSpace: 'source',
      seedAuthor: 'seed',
      versions,
      async draftVersion(spaceId, version) {
        copied.push(`${spaceId}:${version.n}`)
        return version.n
      },
      async promoteSpace(spaceId) {
        promoted.push(spaceId)
      },
    })

    expect(copied).toEqual([
      'space-a:18',
      'space-a:19',
      'space-a:20',
      'space-b:18',
      'space-b:19',
      'space-b:20',
      'space-c:18',
      'space-c:19',
      'space-c:20',
    ])
    expect(promoted).toEqual(['source', 'space-a', 'space-b', 'space-c'])
    expect(report).toEqual({
      changed: ['source', 'space-a', 'space-b', 'space-c'],
      overrides: ['own-space'],
    })
  })
})
