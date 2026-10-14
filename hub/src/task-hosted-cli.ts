import { pruneForeignHostedTasks } from './task-prune-foreign.ts'
import { formatTaskPushReport, pushTasks } from './task-push.ts'

export async function runHostedTaskMaintenance(
  command: 'push' | 'prune-foreign',
  args: {
    confirm?: string
    dryRun?: boolean
    json?: boolean
    onlyPresentElsewhere?: boolean
    project?: string
    repair?: boolean
  },
) {
  if (command === 'push') {
    const result = await pushTasks({ repair: Boolean(args.repair) })
    console.log(args.json ? JSON.stringify(result, null, 2) : formatTaskPushReport(result))
    if (!result.ok) process.exitCode = 1
    return
  }
  const confirmation = args.confirm
  const result = await pruneForeignHostedTasks({
    dryRun: Boolean(args.dryRun),
    confirmation: confirmation === undefined ? undefined : Number(confirmation),
    project: args.project,
    onlyPresentElsewhere: Boolean(args.onlyPresentElsewhere),
  })
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  for (const row of result.tasks)
    console.log(
      `${row.key}\t${row.project}\t${row.source}\t` +
        `present elsewhere: ${row.present_elsewhere === null ? 'unknown' : row.present_elsewhere ? 'yes' : 'no'}`,
    )
  console.log(
    result.deleted
      ? `soft-deleted ${result.deleted.tasks} tasks in active space ${result.active_space_id}`
      : `${result.tasks.length} foreign tasks; dry run, nothing deleted`,
  )
}
