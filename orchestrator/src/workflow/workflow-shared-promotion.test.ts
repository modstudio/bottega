import { describe, expect, test } from 'bun:test'
import {
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

    expect(sharedWorkflowPromotionSpaces(versions, 20, 'seed', [])).toEqual({
      changed: ['source', 'space-a', 'space-b', 'space-c', null],
      overrides: ['own-space'],
      pinned: [],
    })
  })

  test('keeps a space with its own promotion pin but not one changed by a shared promotion', () => {
    const versions = [shared('source', 20, 'draft'), shared('pinned', 17), shared('follow', 17)]
    expect(
      sharedWorkflowPromotionSpaces(versions, 20, 'seed', [
        { spaceId: 'pinned', event: 'promote', author: 'operator', reason: 'pin version 17' },
        {
          spaceId: 'follow',
          event: 'promote',
          author: 'operator',
          reason: 'shared promotion: prior release',
        },
      ]),
    ).toEqual({ changed: ['source', 'follow'], overrides: [], pinned: ['pinned'] })
  })
})
