// concern: context-cursor-warning-decision
/** Pure policy for warning when task context cannot reach any session brief. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

type TaskIdentity = { key: string; project: string }
type TaskParent = TaskIdentity & { parent_key?: string | null }
type CursorTask = { project: string; taskKey: string | null }

export function contextCursorWarning(input: {
  task: TaskIdentity
  openCursors: readonly CursorTask[]
  tasks: readonly TaskParent[]
}): string | null {
  const tasksByKey = new Map(
    input.tasks
      .filter((task) => task.project === input.task.project)
      .map((task) => [task.key, task]),
  )
  const carried = input.openCursors.some((cursor) => {
    if (cursor.project !== input.task.project || !cursor.taskKey) return false
    let key: string | null = cursor.taskKey
    const visited = new Set<string>()
    while (key && !visited.has(key)) {
      if (key === input.task.key) return true
      visited.add(key)
      key = tasksByKey.get(key)?.parent_key ?? null
    }
    return false
  })
  if (carried) return null
  return `warning: no open workflow cursor carries ${input.task.key} or its children, so this item reaches no session brief; open one with ${PLATFORM_SLUG} workflow compose <workflow> --project ${input.task.project} --arg key=${input.task.key}`
}
