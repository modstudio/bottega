import { describe, expect, test } from 'bun:test'
import { childTaskLabelUpdate, hostedTaskJoinCondition } from './hosted-task-reference.ts'

describe('hosted task references', () => {
  test('joins by record id and falls back to the scoped key only for unbackfilled rows', () => {
    expect(hostedTaskJoinCondition('e')).toBe(
      '(e.task_id IS NOT NULL AND t.id=e.task_id) OR (e.task_id IS NULL AND t.space_id=e.space_id AND t.key=e.task_key)',
    )
  })

  test('a task key change requires child label snapshots to move', () => {
    expect(childTaskLabelUpdate('DEV-1', 'DEV-2')).toEqual({
      previousKey: 'DEV-1',
      nextKey: 'DEV-2',
    })
    expect(childTaskLabelUpdate('DEV-2', 'DEV-2')).toBeNull()
  })
})
