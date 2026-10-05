import { isAbsolute } from 'node:path'

export const BOARD_TOPICS = ['release', 'mcp', 'gate', 'canon', 'infra'] as const
export const BOARD_MAX_PATH_TAGS = 10
const BOARD_MAX_TOPIC_TAGS = 5

export type BoardTagKind = 'task' | 'path' | 'topic'
export type BoardTag = {
  kind: BoardTagKind
  value: string
  origin: 'sender' | 'inferred'
}
export type SenderBoardTags = { task?: string; paths?: string[]; topics?: string[] }

function distinct(values: string[]): string[] {
  return [...new Set(values)]
}

export function pathTagRefusal(value: string): string | null {
  if (!value.trim()) return 'board path tag is empty; provide a repository-relative glob'
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value))
    return `board path tag ${value} is absolute; provide a repository-relative glob`
  if (value.split(/[\\/]/).includes('..'))
    return `board path tag ${value} contains a .. segment; remove that segment`
  return null
}

export function senderBoardTags(input: SenderBoardTags): BoardTag[] {
  const task = input.task?.trim()
  if (input.task !== undefined && !task)
    throw new Error('board task tag is empty; provide one task key or omit --task')
  const paths = distinct(input.paths ?? [])
  if (paths.length > BOARD_MAX_PATH_TAGS)
    throw new Error(
      `board notice has more than ${BOARD_MAX_PATH_TAGS} path tags; provide at most ${BOARD_MAX_PATH_TAGS}`,
    )
  for (const path of paths) {
    const refusal = pathTagRefusal(path)
    if (refusal) throw new Error(refusal)
  }
  const topics = distinct(input.topics ?? [])
  if (topics.length > BOARD_MAX_TOPIC_TAGS)
    throw new Error(
      `board notice has more than ${BOARD_MAX_TOPIC_TAGS} topic tags; provide at most ${BOARD_MAX_TOPIC_TAGS}`,
    )
  for (const topic of topics)
    if (!BOARD_TOPICS.some((known) => known === topic))
      throw new Error(`unknown board topic ${topic}; use one of ${BOARD_TOPICS.join(', ')}`)
  return [
    ...(task ? [{ kind: 'task' as const, value: task, origin: 'sender' as const }] : []),
    ...paths.map((value) => ({ kind: 'path' as const, value, origin: 'sender' as const })),
    ...topics.map((value) => ({ kind: 'topic' as const, value, origin: 'sender' as const })),
  ]
}

export function senderTagKey(tags: Pick<BoardTag, 'kind' | 'value'>[]): string {
  return JSON.stringify(
    tags
      .map(({ kind, value }) => [kind, value] as const)
      .sort(([leftKind, leftValue], [rightKind, rightValue]) =>
        leftKind === rightKind
          ? leftValue.localeCompare(rightValue)
          : leftKind.localeCompare(rightKind),
      ),
  )
}

export function inferredBoardTags(
  body: string,
  senderTags: BoardTag[],
  currentTaskKey: string | null,
): BoardTag[] {
  if (senderTags.length === 0) return []
  const inferred: BoardTag[] = []
  if (!senderTags.some((tag) => tag.kind === 'task') && currentTaskKey)
    inferred.push({ kind: 'task', value: currentTaskKey, origin: 'inferred' })
  const paths: string[] = []
  for (const match of body.matchAll(/`([^`\r\n]+)`/g)) {
    const value = match[1]!
    if (!value.includes('/') || pathTagRefusal(value) || paths.includes(value)) continue
    paths.push(value)
    if (paths.length === BOARD_MAX_PATH_TAGS) break
  }
  return [
    ...inferred,
    ...paths.map((value) => ({ kind: 'path' as const, value, origin: 'inferred' as const })),
  ]
}
