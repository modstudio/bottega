export const TASK_IDENTITY_UUID_COLUMNS = [
  'run.task_record_id',
  'task_flow.record_id',
  'task_flow.task_record_id',
  'task_flow.project_record_id',
  'task_flow.open_stage_cursor_record_id',
  'workflow_cursor.task_flow_record_id',
  'workflow_cursor.task_record_id',
  'question.workflow_task_record_id',
  'port_ref.task_record_id',
  'presence.current_task_record_id',
] as const
