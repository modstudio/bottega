import type { ParsedTaskArguments } from './task-command-arguments.ts'
import { pruneForeignHostedTasks } from './task-prune-foreign.ts'
import { pushTasks } from './task-push.ts'

export async function runHostedTaskMaintenance(
  command: 'push' | 'prune-foreign',
  args: ParsedTaskArguments,
) {
  const has = (name: string) => args.booleans.has(`--${name}`)
  const flag = (name: string) => args.values.get(`--${name}`)
  if (command === 'push') {
    const result = await pushTasks({ dryRun: has('dry-run') })
    console.log(JSON.stringify(result, null, 2))
    if (result.match === false) process.exitCode = 1
    return
  }
  const confirmation = flag('confirm')
  const result = await pruneForeignHostedTasks({
    dryRun: has('dry-run'),
    confirmation: confirmation === undefined ? undefined : Number(confirmation),
    project: flag('project'),
    onlyPresentElsewhere: has('only-present-elsewhere'),
  })
  if (has('json')) {
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
