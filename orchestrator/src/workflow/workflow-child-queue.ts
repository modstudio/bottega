// concern: workflow child queue
/** Pure queue/Open classification and child selection. */

export type ChildTaskFact = {
  key: string
  parentKey: string | null
  number: number
  statusCategory: string | null
  cursorEverComposed: boolean
  liveTaskClaimSession: string | null
  liveQueuedClaimSession: string | null
  queuedAt: string | null
}

export type ChildQueueState = { queue: ChildTaskFact[]; open: ChildTaskFact[] }

export function childQueueState(
  rootKey: string,
  session: string,
  tasks: readonly ChildTaskFact[],
): ChildQueueState {
  const childCount = new Map<string, number>()
  for (const task of tasks)
    if (task.parentKey) childCount.set(task.parentKey, (childCount.get(task.parentKey) ?? 0) + 1)
  const descendants = new Set<string>()
  const visit = (key: string) => {
    for (const task of tasks) {
      if (task.parentKey !== key) continue
      descendants.add(task.key)
      visit(task.key)
    }
  }
  visit(rootKey)
  const queueable = tasks.filter(
    (task) =>
      descendants.has(task.key) &&
      !childCount.has(task.key) &&
      task.statusCategory !== 'done' &&
      task.statusCategory !== 'dropped' &&
      !task.cursorEverComposed &&
      task.liveTaskClaimSession === null,
  )
  return {
    queue: queueable
      .filter((task) => task.liveQueuedClaimSession === session)
      .sort(
        (left, right) =>
          (left.queuedAt ?? '').localeCompare(right.queuedAt ?? '') || left.number - right.number,
      ),
    open: queueable
      .filter((task) => task.liveQueuedClaimSession === null)
      .sort((left, right) => left.number - right.number),
  }
}

export function selectChildToStart(
  state: ChildQueueState,
  requested?: string,
): { action: 'start'; task: ChildTaskFact } | { action: 'refuse'; message: string } {
  if (requested) {
    const task = [...state.queue, ...state.open].find(({ key }) => key === requested)
    return task
      ? { action: 'start', task }
      : { action: 'refuse', message: `${requested} is not queued for this session or Open` }
  }
  const task = state.queue[0] ?? state.open[0]
  return task
    ? { action: 'start', task }
    : { action: 'refuse', message: 'nothing is queued or open under the epic' }
}
