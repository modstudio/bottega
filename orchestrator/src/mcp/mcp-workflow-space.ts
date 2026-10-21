import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { activeRecordSpace, effectiveProjectSpace } from '../project-space.ts'
import { productionWorkflows } from '../workflow/workflows.ts'

export function resolveMcpWorkflowSpace(cwd: string, d: Database = db()) {
  const project = projectAt(cwd, d)
  const spaceId = project ? effectiveProjectSpace(d, project.name) : activeRecordSpace(d)
  return { spaceId, workflows: productionWorkflows(d, spaceId) }
}
