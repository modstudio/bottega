import { describe, expect, test } from 'bun:test'
import {
  childTaskLabelUpdate,
  hostedTaskJoinCondition,
  hostedTaskReference,
  hostedTaskRelationships,
} from './hosted-task-reference.ts'

describe('hosted task references', () => {
  test('joins task children only by their task UUID', () => {
    expect(hostedTaskJoinCondition('hub_task_comment', 'c')).toBe('t.id=c.task_id')
    expect(hostedTaskJoinCondition('hub_task_document', 'd')).toBe('t.id=d.task_id')
    expect(hostedTaskJoinCondition('hub_task_status_event', 'e')).toBe('t.id=e.task_id')
    expect(hostedTaskJoinCondition('hub_task', 'child')).toBe('t.id=child.parent_id')
  })

  test('keeps the promoted-note key fallback outside the task-child relationships', () => {
    expect(hostedTaskJoinCondition('hub_note', 'n')).toBe(
      '(n.promoted_task_id IS NOT NULL AND t.id=n.promoted_task_id) OR (n.promoted_task_id IS NULL AND t.space_id=n.space_id AND t.key=n.promoted_task)',
    )
  })

  test('the relationship catalog supplies all hosted task references', () => {
    expect(hostedTaskRelationships).toEqual([
      {
        table: 'hub_task_comment',
        idColumn: 'task_id',
        keyColumn: 'task_key',
        onTaskDelete: 'soft-delete-child',
        keyFallback: false,
      },
      {
        table: 'hub_task_document',
        idColumn: 'task_id',
        keyColumn: 'task_key',
        onTaskDelete: 'soft-delete-child',
        keyFallback: false,
      },
      {
        table: 'hub_task_status_event',
        idColumn: 'task_id',
        keyColumn: 'task_key',
        onTaskDelete: 'soft-delete-child',
        keyFallback: false,
      },
      {
        table: 'hub_task',
        idColumn: 'parent_id',
        keyColumn: 'parent_key',
        onTaskDelete: 'clear-incoming',
        keyFallback: false,
      },
      {
        table: 'hub_note',
        idColumn: 'promoted_task_id',
        keyColumn: 'promoted_task',
        onTaskDelete: 'clear-incoming',
        keyFallback: true,
      },
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
