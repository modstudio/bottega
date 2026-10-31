import type { DisplayLabel } from './identity-inventory.ts'

export const TASK_CHILD_DISPLAY_LABELS: readonly DisplayLabel[] = [
  {
    store: 'hub',
    column: 'task.parent_key',
    sibling: 'task.parent_record_id',
    reason: 'display label beside the parent task UUID reference',
  },
  {
    store: 'hub',
    column: 'task_comment.task_key',
    sibling: 'task_comment.task_record_id',
    reason: 'display label beside the task UUID reference',
  },
  {
    store: 'hub',
    column: 'task_document.task_key',
    sibling: 'task_document.task_record_id',
    reason: 'display label beside the task UUID reference',
  },
  {
    store: 'hub',
    column: 'task_status_event.task_key',
    sibling: 'task_status_event.task_record_id',
    reason: 'display label beside the task UUID reference',
  },
  {
    store: 'hub',
    column: 'task_identity_migration_repairs.task_key',
    sibling: 'task_identity_migration_repairs.new_record_id',
    reason: 'machine-local audit label for the repaired task beside its UUID',
  },
  {
    store: 'hosted',
    column: 'hub_task.parent_key',
    sibling: 'hub_task.parent_id',
    reason: 'display label beside the parent task UUID reference',
  },
  {
    store: 'hosted',
    column: 'hub_task_comment.task_key',
    sibling: 'hub_task_comment.task_id',
    reason: 'display label beside the task UUID reference',
  },
  {
    store: 'hosted',
    column: 'hub_task_document.task_key',
    sibling: 'hub_task_document.task_id',
    reason: 'display label beside the task UUID reference',
  },
  {
    store: 'hosted',
    column: 'hub_task_status_event.task_key',
    sibling: 'hub_task_status_event.task_id',
    reason: 'display label beside the task UUID reference',
  },
]
