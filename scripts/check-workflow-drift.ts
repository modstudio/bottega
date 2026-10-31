import type { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { DB_PATH, openReadOnlyDatabase } from '../orchestrator/src/database/db.ts'
import { planWorkflowHydration } from '../orchestrator/src/workflow/workflow-tree.ts'
import { collectWorkflowTree } from '../orchestrator/src/workflow/workflow-tree-files.ts'
import {
  newestDraftWorkflowTree,
  productionWorkflowTree,
} from '../orchestrator/src/workflow/workflow-tree-store.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { branchChangedPaths, registeredProjectAt } from './check-canon-drift.ts'
import { resolveRegisteredLandingBase } from './landing-base.ts'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const remedy = `${PLATFORM_SLUG} workflow hydrate --cwd <tree>`

type WorkflowDriftInput = {
  productionPaths: string[]
  draftPaths: string[]
  landingBranch: string
}

export function workflowDriftPartition(
  productionDriftedPaths: Iterable<string>,
  newestDraftDriftedPaths: Iterable<string>,
  changedPaths: Iterable<string>,
): { failing: string[]; informational: string[] } {
  const changed = new Set(changedPaths)
  const draftDrift = new Set(newestDraftDriftedPaths)
  const paths = [...productionDriftedPaths].filter((path) => draftDrift.has(path))
  return {
    failing: paths.filter((path) => changed.has(path)),
    informational: paths.filter((path) => !changed.has(path)),
  }
}

function workflowDriftInput(checkout: string, database: Database): WorkflowDriftInput {
  const project = registeredProjectAt(checkout, database)
  const landingBranch = project.settings.trunk!.trim()
  const productionPlan = planWorkflowHydration({
    store: productionWorkflowTree({ database, project: project.name }),
    tree: collectWorkflowTree(checkout),
  })
  const draftPlan = planWorkflowHydration({
    store: newestDraftWorkflowTree({ database, project: project.name }),
    tree: collectWorkflowTree(checkout),
  })
  return {
    productionPaths: [
      ...productionPlan.writes.map(({ path }) => path),
      ...productionPlan.deletes,
    ].sort(),
    draftPaths: [...draftPlan.writes.map(({ path }) => path), ...draftPlan.deletes].sort(),
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
      const result = workflowDriftPartition(
        input.productionPaths,
        input.draftPaths,
        branchChangedPaths(root, base),
      )
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
