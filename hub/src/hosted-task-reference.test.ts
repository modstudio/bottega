import { describe, expect, test } from 'bun:test'
import {
  childTaskLabelUpdate,
  hostedTaskJoinCondition,
  hostedTaskReference,
  hostedTaskRelationships,
} from './hosted-task-reference.ts'

describe('hosted task references', () => {
  test('joins by record id and falls back to the scoped key only for unbackfilled rows', () => {
    expect(hostedTaskJoinCondition('hub_task_status_event', 'e')).toBe(
      '(e.task_id IS NOT NULL AND t.id=e.task_id) OR (e.task_id IS NULL AND t.space_id=e.space_id AND t.key=e.task_key)',
    )
  })

  test('the relationship catalog supplies all hosted task references', () => {
    expect(hostedTaskRelationships).toEqual([
      { table: 'hub_task_comment', idColumn: 'task_id', keyColumn: 'task_key' },
      { table: 'hub_task_document', idColumn: 'task_id', keyColumn: 'task_key' },
      { table: 'hub_task_status_event', idColumn: 'task_id', keyColumn: 'task_key' },
      { table: 'hub_task', idColumn: 'parent_id', keyColumn: 'parent_key' },
      { table: 'hub_note', idColumn: 'promoted_task_id', keyColumn: 'promoted_task' },
    ])
    expect(
      hostedTaskReference('hub_note', {
        promoted_task_id: 'task-id',
        promoted_task: 'DEV-2',
      }),
    ).toEqual({ id: 'task-id', key: 'DEV-2' })
  })

  test('a task key change requires child label snapshots to move', () => {
    expect(childTaskLabelUpdate('DEV-1', 'DEV-2')).toEqual({
      previousKey: 'DEV-1',
      nextKey: 'DEV-2',
    })
    expect(childTaskLabelUpdate('DEV-2', 'DEV-2')).toBeNull()
  })
})
