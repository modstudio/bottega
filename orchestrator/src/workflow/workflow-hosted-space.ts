// concern: workflows
/** Resolves a workflow write's already-validated destination. */
import type { Database } from 'bun:sqlite'

export function workflowHostedSpace(
  d: Database,
  project?: string,
  destinationSpaceId?: string,
  projectSpace: (d: Database, project: string) => string | null = () => '',
): string {
  const spaceId = project ? projectSpace(d, project) : destinationSpaceId
  if (!spaceId) throw new Error('workflow write has no record space')
  return spaceId
}
