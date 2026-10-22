import { describe, expect, test } from 'bun:test'
import {
  sharedWorkflowPromotionSpaces,
  type WorkflowPromotionVersion,
} from './workflow-shared-promotion.ts'

const shared = (
  spaceId: string | null,
  n: number,
  status: WorkflowPromotionVersion['status'] = 'production',
  definition = `definition-${n}`,
): WorkflowPromotionVersion => ({ spaceId, n, status, author: 'seed', definition })

describe('shared workflow promotion spaces', () => {
  test('a space with an identical prefix follows the source to its target', () => {
    const versions = [
      ...[15, 16, 17, 18, 19].map((n) => shared('source', n, 'retired')),
      shared('source', 20, 'draft'),
      ...[15, 16].map((n) => shared('follower', n, 'retired')),
      shared('follower', 17),
    ]

    expect(sharedWorkflowPromotionSpaces(versions, 20, 'source', [])).toEqual({
      changed: ['source', 'follower'],
      overrides: [],
      pinned: [],
    })
  })

  test('a space with a differing version is an override', () => {
    const versions = [shared('source', 17), shared('source', 20, 'draft'), shared('own', 17)]
    versions[2]!.definition = 'different'

    expect(sharedWorkflowPromotionSpaces(versions, 20, 'source', [])).toEqual({
      changed: ['source'],
      overrides: ['own'],
      pinned: [],
    })
  })

  test('a space with a version absent from the source is an override', () => {
    const versions = [shared('source', 20, 'draft'), shared('own', 17)]

    expect(sharedWorkflowPromotionSpaces(versions, 20, 'source', [])).toEqual({
      changed: ['source'],
      overrides: ['own'],
      pinned: [],
    })
  })

  test('keeps a space with its own promotion pin', () => {
    const versions = [
      shared('source', 17, 'retired'),
      shared('source', 20, 'draft'),
      shared('pinned', 17),
    ]
    expect(
      sharedWorkflowPromotionSpaces(versions, 20, 'source', [
        { spaceId: 'pinned', event: 'promote', operator: true, reason: 'pin version 17' },
      ]),
    ).toEqual({ changed: ['source'], overrides: [], pinned: ['pinned'] })
  })
})
