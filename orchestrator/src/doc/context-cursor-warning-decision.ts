// concern: context-cursor-warning-decision
/** Pure policy for warning when task context cannot reach any session brief. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { shellWord } from './context-moment.ts'

export type CarriedTaskPair = { key: string; project: string }
type TaskIdentity = CarriedTaskPair
type TaskParent = TaskIdentity & { parent_key?: string | null }
type CursorTask = { project: string; taskKey: string | null }

/** Names each cursor task and every same-project ancestor, including missing cursor tasks. */
export function tasksCarriedByOpenCursors(
  openCursors: readonly CursorTask[],
  tasks: readonly TaskParent[],
): Set<CarriedTaskPair> {
  const tasksByKey = new Map(tasks.map((task) => [`${task.project}\0${task.key}`, task]))
  const carriedKeys = new Set<string>()
  const carried: CarriedTaskPair[] = []
  for (const cursor of openCursors) {
    if (!cursor.taskKey) continue
    let key: string | null = cursor.taskKey
    const visited = new Set<string>()
    while (key && !visited.has(key)) {
      visited.add(key)
      const scopedKey = `${cursor.project}\0${key}`
      if (!carriedKeys.has(scopedKey)) {
        carriedKeys.add(scopedKey)
        carried.push({ project: cursor.project, key })
      }
      const task = tasksByKey.get(scopedKey)
      if (!task) break
      key = task.parent_key ?? null
    }
  }
  return new Set(carried)
}

type CarriedTask = TaskParent & { record_id: string }

/** Maps carried task identities present in the task list to their durable holders. */
export function taskHoldersCarriedByOpenCursors(
  openCursors: readonly CursorTask[],
  tasks: readonly CarriedTask[],
): string[] {
  const carried = tasksCarriedByOpenCursors(openCursors, tasks)
  const carriedKeys = new Set([...carried].map(({ project, key }) => `${project}\0${key}`))
  return tasks
    .filter((task) => carriedKeys.has(`${task.project}\0${task.key}`))
    .map((task) => `task:${task.record_id}`)
}

export function contextCursorWarning(input: {
  task: TaskIdentity
  openCursors: readonly CursorTask[]
  tasks: readonly TaskParent[]
}): string | null {
  const carried = [...tasksCarriedByOpenCursors(input.openCursors, input.tasks)].some(
    ({ project, key }) => project === input.task.project && key === input.task.key,
  )
  if (carried) return null
  return `warning: no open workflow cursor carries ${input.task.key} or its descendants, so this item reaches no session brief; open one with ${PLATFORM_SLUG} workflow compose <workflow> --project ${shellWord(input.task.project)} --arg ${shellWord(`key=${input.task.key}`)}`
}
