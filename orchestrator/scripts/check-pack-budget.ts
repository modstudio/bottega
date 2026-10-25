import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { CanonBudgetError, compilePack, compilePackFromGateFacts } from '../src/canon/canon.ts'
import { DEFAULT_PACK_BYTES } from '../src/canon/pack-budget.ts'
import { migrationRefusal } from '../src/database/migrations.ts'
import { GATE_FACTS_ENV, type GateFacts, readGateFactsFile } from '../src/gate/gate-facts.ts'
import { JOBS } from '../src/jobs/jobs.ts'
import { projects } from '../src/project/projects.ts'
import { registerStandardHooks } from '../src/runtime/store-hooks.ts'
import {
  classifyStore,
  liveStorePath,
  migrateStore,
  mintFixtureStore,
  snapshotStore,
  withBranchStoreScratch,
  withMainGateFactsSnapshot,
} from './branch-store.ts'

registerStandardHooks()

export function checkPackBudget(facts?: GateFacts): string[] {
  const failures: string[] = []
  for (const project of facts?.projects ?? projects()) {
    for (const job of Object.keys(JOBS)) {
      try {
        if (facts) compilePackFromGateFacts({ job, cwd: project.path }, facts)
        else compilePack({ job, cwd: project.path })
      } catch (error) {
        if (error instanceof CanonBudgetError)
          failures.push(`${project.name}/${job}\n${error.message}`)
        else throw error
      }
    }
  }
  return failures
}

const READY = 'BOTTEGA_PACK_BUDGET_READY'

function report(failures: string[]): never {
  if (failures.length) {
    console.error(
      `canon pack budget failed for ${failures.length} project/job combination(s):\n${failures.join('\n\n')}`,
    )
    process.exit(1)
  }
  console.log(`canon pack budget ok (ceiling ${DEFAULT_PACK_BYTES} bytes)`)
  process.exit(0)
}

function runReady(store: string): number {
  const child = Bun.spawnSync([process.execPath, fileURLToPath(import.meta.url)], {
    env: { ...process.env, BOTTEGA_ORCHESTRATOR_DB: store, [READY]: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return child.exitCode ?? 1
}

function runGateFacts(path: string): number {
  const child = Bun.spawnSync([process.execPath, fileURLToPath(import.meta.url)], {
    env: { ...process.env, [GATE_FACTS_ENV]: path, [READY]: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return child.exitCode ?? 1
}

if (import.meta.main) {
  if (process.env[READY] === '1') {
    const factsPath = process.env[GATE_FACTS_ENV]
    report(checkPackBudget(factsPath ? readGateFactsFile(factsPath) : undefined))
  }

  const live = liveStorePath()
  if (!live) {
    const code = withBranchStoreScratch('pack-budget', (dir) => {
      const minted = mintFixtureStore(dir)
      console.log('canon pack budget: no live store; checking fixture-minted store')
      return runReady(minted)
    })
    process.exit(code)
  }

  const kind = classifyStore(live)
  if (kind === 'ahead') {
    const code = withBranchStoreScratch('pack-budget', (dir) =>
      withMainGateFactsSnapshot(
        kind,
        dir,
        (snapshotError) => {
          const database = new Database(live, { readonly: true })
          try {
            console.error(migrationRefusal(database))
            console.error(String((snapshotError as Error).message ?? snapshotError))
          } finally {
            database.close()
          }
          return 1
        },
        (snapshot) => {
          console.log(
            `canon pack budget: gate-facts snapshot took ${snapshot.elapsedMs.toFixed(1)} ms`,
          )
          return runGateFacts(snapshot.path)
        },
      ),
    )
    process.exit(code)
  }
  if (kind === 'current') {
    console.log('canon pack budget: reading live store in place (read-only)')
    report(checkPackBudget())
  }

  const code = withBranchStoreScratch('pack-budget', (dir) => {
    const snapshot = snapshotStore(live, dir)
    migrateStore(snapshot)
    console.log(
      'canon pack budget: snapshotted live store, migrated the snapshot, checking packs there',
    )
    return runReady(snapshot)
  })
  process.exit(code)
}
