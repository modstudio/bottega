import type { ToolCaller } from './tracker-list-scope.ts'

export type TrackerTaskText = {
  externalId: string | null
  key: string
  title: string
  body: string
  comments: string[]
}

export class TrackerLookupUnverifiable extends Error {
  constructor(
    protocol: string,
    key: string,
    detail = `task text read for ${key} returned an unexpected response`,
  ) {
    super(`${protocol} ${detail}`)
    this.name = 'TrackerLookupUnverifiable'
  }
}

export const cursorTaskNotFound = (cause: unknown): boolean => {
  const structuredContent =
    cause instanceof Error && cause.name === 'McpToolCallError' && 'structuredContent' in cause
      ? cause.structuredContent
      : undefined
  return Boolean(
    structuredContent &&
      typeof structuredContent === 'object' &&
      (structuredContent as { success?: unknown }).success === false &&
      (structuredContent as { code?: unknown }).code === 'NOT_FOUND',
  )
}

export const arrayTaskForKey = <T extends { key?: unknown }>(
  rows: readonly T[],
  key: string,
): T | undefined =>
  rows.find((row) => typeof row.key === 'string' && row.key.toUpperCase() === key.toUpperCase())

const comments = (rows: unknown[], field: string, protocol: string, key: string): string[] =>
  rows.flatMap((row) => {
    if (!row || typeof row !== 'object') throw new TrackerLookupUnverifiable(protocol, key)
    const value = (row as Record<string, unknown>)[field]
    if (typeof value !== 'string') throw new TrackerLookupUnverifiable(protocol, key)
    return value.trim() ? [value.trim()] : []
  })

export async function readWorkspaceTaskText(
  m: ToolCaller,
  key: string,
  getAction: string,
): Promise<TrackerTaskText | null> {
  const reply = await m.callTool(getAction, { id: key })
  if (reply === null) return null
  if (!reply || typeof reply !== 'object') {
    throw new TrackerLookupUnverifiable('workspace-mcp', key)
  }
  const task = reply as Record<string, unknown>
  if (
    typeof task.short_id !== 'string' ||
    task.short_id.toUpperCase() !== key.toUpperCase() ||
    typeof task.summary !== 'string' ||
    (task.id !== undefined && typeof task.id !== 'string') ||
    (task.comments !== undefined && !Array.isArray(task.comments))
  ) {
    throw new TrackerLookupUnverifiable('workspace-mcp', key)
  }
  return {
    externalId: task.id ?? null,
    key: task.short_id,
    title: task.summary,
    body:
      typeof task.description_markdown === 'string'
        ? task.description_markdown
        : typeof task.description === 'string'
          ? task.description
          : '',
    comments: comments(
      (task.comments as unknown[] | undefined) ?? [],
      'content',
      'workspace-mcp',
      key,
    ),
  }
}

export async function readCursorTaskText(
  m: ToolCaller,
  key: string,
  getAction: string,
  listCommentsAction: string,
): Promise<TrackerTaskText | null> {
  let reply: unknown
  try {
    reply = await m.callTool(getAction, { taskKey: key })
  } catch (cause) {
    if (cursorTaskNotFound(cause)) return null
    throw cause
  }
  if (!reply || typeof reply !== 'object') {
    throw new TrackerLookupUnverifiable('cursor-mcp', key)
  }
  const envelope = reply as { success?: unknown; data?: unknown }
  if (envelope.success === true && envelope.data === null) return null
  if (!envelope.data || typeof envelope.data !== 'object') {
    throw new TrackerLookupUnverifiable('cursor-mcp', key)
  }
  const task = envelope.data as Record<string, unknown>
  if (
    envelope.success !== true ||
    typeof task.id !== 'string' ||
    typeof task.title !== 'string' ||
    (task.description !== undefined &&
      task.description !== null &&
      typeof task.description !== 'string')
  ) {
    throw new TrackerLookupUnverifiable('cursor-mcp', key)
  }
  const commentReply = await m.callTool(listCommentsAction, {
    entityType: 'task',
    entityId: task.id,
  })
  if (!commentReply || typeof commentReply !== 'object') {
    throw new TrackerLookupUnverifiable('cursor-mcp', key)
  }
  const commentEnvelope = commentReply as { success?: unknown; data?: unknown }
  if (commentEnvelope.success !== true || !Array.isArray(commentEnvelope.data)) {
    throw new TrackerLookupUnverifiable('cursor-mcp', key)
  }
  return {
    externalId: task.id,
    key,
    title: task.title,
    body: typeof task.description === 'string' ? task.description : '',
    comments: comments(commentEnvelope.data, 'body', 'cursor-mcp', key),
  }
}

export async function readArrayTaskText(
  m: ToolCaller,
  key: string,
  getAction: string,
): Promise<TrackerTaskText | null> {
  const reply = await m.callTool(getAction, { search: key })
  if (!Array.isArray(reply)) throw new TrackerLookupUnverifiable('array-mcp', key)
  const hit = arrayTaskForKey(
    reply.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object')),
    key,
  )
  if (!hit) return null
  const task = hit as Record<string, unknown>
  if (
    typeof task.key !== 'string' ||
    typeof task.title !== 'string' ||
    (task.description !== undefined &&
      task.description !== null &&
      typeof task.description !== 'string') ||
    (task.id !== undefined && typeof task.id !== 'string')
  ) {
    throw new TrackerLookupUnverifiable('array-mcp', key)
  }
  return {
    externalId: task.id ?? null,
    key: task.key,
    title: task.title,
    body: typeof task.description === 'string' ? task.description : '',
    comments: [],
  }
}
