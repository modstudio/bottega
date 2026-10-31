import type { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { DB_PATH, openReadOnlyDatabase } from '../orchestrator/src/database/db.ts'
import { planWorkflowHydration } from '../orchestrator/src/workflow/workflow-tree.ts'
import { collectWorkflowTree } from '../orchestrator/src/workflow/workflow-tree-files.ts'
import { productionWorkflowTree } from '../orchestrator/src/workflow/workflow-tree-store.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { branchChangedPaths, registeredProjectAt } from './check-canon-drift.ts'
import { resolveRegisteredLandingBase } from './landing-base.ts'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const remedy = `${PLATFORM_SLUG} workflow hydrate --cwd <tree>`

type WorkflowDriftInput = { paths: string[]; landingBranch: string }

export function workflowDriftPartition(
  driftedPaths: Iterable<string>,
  changedPaths: Iterable<string>,
): { failing: string[]; informational: string[] } {
  const changed = new Set(changedPaths)
  const paths = [...driftedPaths]
  return {
    failing: paths.filter((path) => changed.has(path)),
    informational: paths.filter((path) => !changed.has(path)),
  }
}

function workflowDriftInput(checkout: string, database: Database): WorkflowDriftInput {
  const project = registeredProjectAt(checkout, database)
  const landingBranch = project.settings.trunk!.trim()
  const plan = planWorkflowHydration({
    store: productionWorkflowTree({ database, project: project.name }),
    tree: collectWorkflowTree(checkout),
  })
  return {
    paths: [...plan.writes.map(({ path }) => path), ...plan.deletes].sort(),
    landingBranch,
  }
}

if (import.meta.main) {
  const started = performance.now()
  let database: Database | undefined
  let input: WorkflowDriftInput | undefined
  try {
    database = openReadOnlyDatabase(DB_PATH)
    input = workflowDriftInput(root, database)
  } catch (cause) {
    console.error(
      `cannot read the project register or production workflows through a read-only connection: ${String((cause as Error).message ?? cause)}`,
    )
    console.error(`remedy: restore store access, then ${remedy}`)
    process.exitCode = 1
  } finally {
    database?.close()
  }
  if (input) {
    try {
      const base = resolveRegisteredLandingBase(
        root,
        'workflow drift check',
        input.landingBranch,
      ).commit
      const result = workflowDriftPartition(input.paths, branchChangedPaths(root, base))
      for (const path of result.failing)
        console.error(`${path}: tree differs from production workflow store; remedy: ${remedy}`)
      if (result.informational.length) {
        console.log(
          `workflow drift (informational): ${result.informational.join(', ')}; remedy: ${remedy}`,
        )
      }
      console.log(`workflow drift: checked in ${(performance.now() - started).toFixed(1)} ms`)
      if (result.failing.length) process.exitCode = 1
    } catch (cause) {
      console.error(String((cause as Error).message ?? cause))
      process.exitCode = 1
    }
  }
}
