import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { migrationRefusal } from '../src/database/migrations.ts'
import { GATE_FACTS_ENV } from '../src/gate/gate-facts.ts'
import {
  classifyStore,
  liveStorePath,
  migrateStore,
  snapshotStore,
  withBranchStoreScratch,
  withMainGateFactsSnapshot,
} from './branch-store.ts'

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')

function run(store?: string): number {
  const child = Bun.spawnSync([`${root}/bin/${PLATFORM_SLUG}`, 'gate', 'check', '--enabled'], {
    env: store ? { ...process.env, BOTTEGA_ORCHESTRATOR_DB: store } : process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return child.exitCode ?? 1
}

function runGateFacts(path: string): number {
  const child = Bun.spawnSync([`${root}/bin/${PLATFORM_SLUG}`, 'gate', 'check', '--enabled'], {
    env: { ...process.env, [GATE_FACTS_ENV]: path },
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
    const code = withBranchStoreScratch('project-checks', (dir) =>
      withMainGateFactsSnapshot(
        kind,
        dir,
        (snapshotError) => {
          const database = new Database(live!, { readonly: true })
          try {
            console.error(migrationRefusal(database))
            console.error(String((snapshotError as Error).message ?? snapshotError))
            console.error('branch remedy: rebase the branch onto the landing branch')
          } finally {
            database.close()
          }
          return 1
        },
        (snapshot) => {
          console.log(
            `project checks: gate-facts snapshot took ${snapshot.elapsedMs.toFixed(1)} ms`,
          )
          return runGateFacts(snapshot.path)
        },
      ),
    )
    process.exit(code)
  }

  const code = withBranchStoreScratch('project-checks', (dir) => {
    const snapshot = snapshotStore(live!, dir)
    migrateStore(snapshot)
    return run(snapshot)
  })
  process.exit(code)
}
