import {
  HOSTED_COMMENT_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_INTERVAL_TABLE,
  HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
  HOSTED_NOTE_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type HostedPushChange,
} from './push-contract.ts'

function taskDepth(
  change: Extract<HostedPushChange, { table: typeof HOSTED_TASK_TABLE; op: 'upsert' }>,
  tasks: ReadonlyMap<string, typeof change>,
  visiting = new Set<string>(),
): number {
  const parentId = change.row.parent_id
  if (!parentId || visiting.has(change.row.id)) return 0
  const parent = tasks.get(parentId)
  if (!parent) return 0
  visiting.add(change.row.id)
  return 1 + taskDepth(parent, tasks, visiting)
}

export function orderHostedPushChanges(changes: readonly HostedPushChange[]): HostedPushChange[] {
  const tasks = new Map(
    changes.flatMap((change) =>
      change.table === HOSTED_TASK_TABLE && change.op === 'upsert'
        ? [[change.row.id, change] as const]
        : [],
    ),
  )
  return changes
    .map((change, index) => ({ change, index }))
    .sort((left, right) => {
      const rank = (change: HostedPushChange) => {
        if (change.table === HOSTED_INTERVAL_TABLE) return change.op === 'delete' ? -1 : 0
        if (change.table === HOSTED_STATUS_EVENT_TABLE) return Number.MAX_SAFE_INTEGER
        if (change.table === HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE) return Number.MAX_SAFE_INTEGER
        if (change.table === HOSTED_NOTE_TABLE) return change.op === 'delete' ? 2 : 1
        if (change.table === HOSTED_COMMENT_TABLE || change.table === HOSTED_DOCUMENT_TABLE)
          return Number.MAX_SAFE_INTEGER - 1
        if (change.op === 'delete') return 0
        return change.table === HOSTED_TASK_TABLE ? taskDepth(change, tasks) : 0
      }
      return rank(left.change) - rank(right.change) || left.index - right.index
    })
    .map(({ change }) => change)
}
