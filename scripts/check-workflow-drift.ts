import type { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
import { DB_PATH, openReadOnlyDatabase } from '../orchestrator/src/database/db.ts'
import { projectAt } from '../orchestrator/src/project/projects.ts'
import { planWorkflowHydration } from '../orchestrator/src/workflow/workflow-tree.ts'
import { collectWorkflowTree } from '../orchestrator/src/workflow/workflow-tree-files.ts'
import { productionWorkflowTree } from '../orchestrator/src/workflow/workflow-tree-store.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const remedy = `run ${PLATFORM_SLUG} workflow hydrate --cwd <tree>`

function workflowDriftPaths(checkout: string, database: Database): string[] {
  const project = projectAt(checkout, database)
  if (!project) throw new Error(`cannot find the checkout ${checkout} in the project register`)
  const plan = planWorkflowHydration({
    store: productionWorkflowTree({ database, project: project.name }),
    tree: collectWorkflowTree(checkout),
  })
  return [...plan.writes.map(({ path }) => path), ...plan.deletes].sort()
}

if (import.meta.main) {
  const started = performance.now()
  let database: Database | undefined
  try {
    database = openReadOnlyDatabase(DB_PATH)
    const paths = workflowDriftPaths(root, database)
    for (const path of paths)
      console.error(`${path}: tree differs from production workflow store; remedy: ${remedy}`)
    console.log(`workflow drift: checked in ${(performance.now() - started).toFixed(1)} ms`)
    if (paths.length) process.exitCode = 1
  } catch (cause) {
    console.error(
      `cannot read the project register or production workflows through a read-only connection: ${String((cause as Error).message ?? cause)}`,
    )
    console.error(`remedy: restore store access, then ${remedy}`)
    process.exitCode = 1
  } finally {
    database?.close()
  }
}
