const WORKSPACE_STATUS_FIELDS = {
  'change-task-status-tool': 'task_status_id',
  'update-task-tool': 'status',
} as const

export function workspaceStatusPayload(
  wireToolName: string,
  key: string,
  status: string,
): Record<string, unknown> {
  const field = WORKSPACE_STATUS_FIELDS[wireToolName as keyof typeof WORKSPACE_STATUS_FIELDS]
  if (!field) {
    throw new Error(
      `workspace-mcp status write refused: action ${wireToolName} has no proven status payload`,
    )
  }
  return { id: key, [field]: status }
}

export const cursorStatusPayload = (
  externalId: string,
  status: string,
): Record<string, unknown> => ({
  id: externalId,
  status,
})

export const arrayStatusPayload = (
  externalId: string,
  status: string,
  confirm: string,
): Record<string, unknown> => ({ id: externalId, status, confirm })
