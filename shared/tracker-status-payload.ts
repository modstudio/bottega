const WORKSPACE_STATUS_FIELDS = {
  'change-task-status-tool': 'task_status_id',
  'update-task-tool': 'status',
} as const

export function workspaceStatusPayload(
  action: string,
  key: string,
  status: string,
): Record<string, unknown> {
  const field = WORKSPACE_STATUS_FIELDS[action as keyof typeof WORKSPACE_STATUS_FIELDS]
  if (!field) {
    throw new Error(
      `workspace-mcp status write refused: action ${action} has no proven status payload`,
    )
  }
  return { id: key, [field]: status }
}
