import { pruneForeignHostedTasks } from './task-prune-foreign.ts'
import { pushTasks } from './task-push.ts'

const has = (argv: string[], name: string) => argv.includes(`--${name}`)
const flag = (argv: string[], name: string) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

export async function runHostedTaskMaintenance(command: 'push' | 'prune-foreign', argv: string[]) {
  if (command === 'push') {
    const result = await pushTasks({ dryRun: has(argv, 'dry-run') })
    console.log(JSON.stringify(result, null, 2))
    if (result.match === false) process.exitCode = 1
    return
  }
  const confirmation = flag(argv, 'confirm')
  const result = await pruneForeignHostedTasks({
    dryRun: has(argv, 'dry-run'),
    confirmation: confirmation === undefined ? undefined : Number(confirmation),
    project: flag(argv, 'project'),
    onlyPresentElsewhere: has(argv, 'only-present-elsewhere'),
  })
  if (has(argv, 'json')) {
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
