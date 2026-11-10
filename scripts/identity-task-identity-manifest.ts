export const TASK_IDENTITY_UUID_COLUMNS = [
  'run.task_record_id',
  'task_flow.record_id',
  'task_flow.task_record_id',
  'task_flow.project_record_id',
  'task_flow.open_stage_cursor_record_id',
  'task_flow.opening_machine_id',
  'task_flow.updated_machine_id',
  'workflow_cursor.task_flow_record_id',
  'workflow_cursor.task_record_id',
  'workflow_cursor.opened_machine_id',
  'workflow_cursor.taken_over_from_machine_id',
  'workflow_cursor.last_advanced_machine_id',
  'question.workflow_task_record_id',
  'port_ref.task_record_id',
  'presence.current_task_record_id',
] as const

export const TASK_IDENTITY_INTEGER_COLUMNS = [
  'task_flow.revision',
  'workflow_cursor.revision',
] as const

export const HOSTED_TASK_IDENTITY_INTEGER_COLUMNS = [
  'task_flow.revision',
  'task_flow_stage.active_ordinal',
  'task_flow_stage.number',
  'task_flow_stage.total_steps',
  'task_flow_stage.revision',
] as const
