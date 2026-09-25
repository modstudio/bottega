import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { migrationRefusal } from '../src/database/migrations.ts'
import {
  classifyStore,
  liveStorePath,
  migrateStore,
  snapshotStore,
  withBranchStoreScratch,
} from './branch-store.ts'

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')

function run(store?: string): number {
  const child = Bun.spawnSync([`${root}/bin/orch`, 'check', '--enabled'], {
    env: store ? { ...process.env, ORCH_DB: store } : process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return child.exitCode ?? 1
}

if (import.meta.main) {
  const live = liveStorePath()
  const kind = classifyStore(live)
  if (kind === 'current' || kind === 'absent') process.exit(run())

  if (kind === 'ahead') {
    const database = new Database(live!, { readonly: true })
    try {
      console.error(migrationRefusal(database))
      console.error('branch remedy: rebase the branch onto the landing branch')
    } finally {
      database.close()
    }
    process.exit(1)
  }

  const code = withBranchStoreScratch('project-checks', (dir) => {
    const snapshot = snapshotStore(live!, dir)
    migrateStore(snapshot)
    return run(snapshot)
  })
  process.exit(code)
}
