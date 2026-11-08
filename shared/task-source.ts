export const TASK_SOURCES = ['mcp', 'local'] as const
export type TaskSource = (typeof TASK_SOURCES)[number]
