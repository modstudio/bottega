// concern: canonical worker record-read MCP tool names

export const WORKER_READ_TOOLS = {
  task: 'read_task',
  document: 'read_task_document',
  workflow: 'read_workflow_text',
} as const

export type WorkerReadToolName = (typeof WORKER_READ_TOOLS)[keyof typeof WORKER_READ_TOOLS]
