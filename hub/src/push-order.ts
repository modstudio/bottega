import {
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type HostedPushChange,
} from './push-contract.ts'

function taskDepth(
  change: Extract<HostedPushChange, { table: typeof HOSTED_TASK_TABLE; op: 'upsert' }>,
  tasks: ReadonlyMap<string, typeof change>,
  visiting = new Set<string>(),
): number {
  const parentKey = change.row.parent_key
  if (!parentKey || visiting.has(change.row.key)) return 0
  const parent = tasks.get(parentKey)
  if (!parent) return 0
  visiting.add(change.row.key)
  return 1 + taskDepth(parent, tasks, visiting)
}

export function orderHostedPushChanges(changes: readonly HostedPushChange[]): HostedPushChange[] {
  const tasks = new Map(
    changes.flatMap((change) =>
      change.table === HOSTED_TASK_TABLE && change.op === 'upsert'
        ? [[change.row.key, change] as const]
        : [],
    ),
  )
  return changes
    .map((change, index) => ({ change, index }))
    .sort((left, right) => {
      const rank = (change: HostedPushChange) => {
        if (change.table === HOSTED_STATUS_EVENT_TABLE) return Number.MAX_SAFE_INTEGER
        if (change.op === 'delete') return 0
        return taskDepth(change, tasks)
      }
      return rank(left.change) - rank(right.change) || left.index - right.index
    })
    .map(({ change }) => change)
}
