import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { workflowReadSpaceFor } from '../workflow/workflow-read-space.ts'
import { productionWorkflows } from '../workflow/workflows.ts'

export function resolveMcpWorkflowSpace(cwd: string, d: Database = db()) {
  const project = projectAt(cwd, d)
  const spaceId = workflowReadSpaceFor(d, project?.name ?? null)
  return { spaceId, workflows: productionWorkflows(d, spaceId) }
}
