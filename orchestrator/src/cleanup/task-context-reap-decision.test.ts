import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideTaskContextReap } from './task-context-reap-decision.ts'

describe('decideTaskContextReap', () => {
  test('clears done tasks and keeps open and missing task holders', () => {
    const result = decideTaskContextReap(
      [
        { holderId: 'done-id', itemCount: 3 },
        { holderId: 'open-id', itemCount: 2 },
        { holderId: 'missing-id', itemCount: 1 },
      ],
      [
        {
          record_id: 'done-id',
          key: 'DEV-1',
          project: PLATFORM_SLUG,
          status_category: 'done',
        },
        {
          record_id: 'open-id',
          key: 'DEV-2',
          project: PLATFORM_SLUG,
          status_category: 'active',
        },
      ],
    )

    expect(result).toEqual({
      clear: [{ holderId: 'done-id', itemCount: 3, key: 'DEV-1', project: PLATFORM_SLUG }],
      keptOpen: 1,
      unresolved: [{ holderId: 'missing-id', itemCount: 1 }],
    })
  })
})
