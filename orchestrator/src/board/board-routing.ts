import type { BoardTag } from './board-tags.ts'

export type BoardSessionContext = {
  taskKeys: ReadonlySet<string>
  changedPaths: ReadonlySet<string>
}

/** Decide whether stored message context overlaps a session's derived work context. Topic tags do not narrow. */
export function boardNoticeMatches(tags: BoardTag[], context: BoardSessionContext): boolean {
  if (tags.length === 0 || tags.every((tag) => tag.kind === 'topic')) return true
  return tags.some((tag) => {
    if (tag.kind === 'task') return context.taskKeys.has(tag.value)
    if (tag.kind === 'topic') return false
    const glob = new Bun.Glob(tag.value)
    return [...context.changedPaths].some((path) => glob.match(path))
  })
}
