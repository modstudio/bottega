// concern: workflow-shared-promotion-store
/** Applies shared workflow promotion decisions to local and hosted catalogue stores. */
import type { Database } from 'bun:sqlite'
import { sessionId } from '../database/db.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { applyWorkflowWriteResponse } from '../record/record-cache-workflow.ts'
import {
  promoteSharedWorkflowSpaces,
  type WorkflowPromotionSpaceDecision,
  type WorkflowPromotionVersion,
} from './workflow-shared-promotion.ts'

type StoredPromotionVersion = WorkflowPromotionVersion & {
  definition: string
  reason: string
}
type PromotionPorts = {
  draftLocal(version: StoredPromotionVersion): number
  promoteLocal(): void
  preflight(definition: unknown, spaceId: string): void
  author(): string
}

const storedVersions = (slug: string, d: Database): StoredPromotionVersion[] =>
  d
    .query<StoredPromotionVersion, [string]>(
      `SELECT w.space_id spaceId,v.n,v.status,v.author,v.definition,v.reason FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? ORDER BY w.space_id,v.n`,
    )
    .all(slug)

async function draftHosted(
  slug: string,
  spaceId: string,
  version: StoredPromotionVersion,
  d: Database,
): Promise<number> {
  const result = await recordApiClient().draftWorkflow!(
    {
      kind: 'workflow',
      slug,
      event: 'import',
      definition: version.definition,
      author: version.author,
      reason: version.reason,
      sessionId: sessionId(),
    },
    { destinationSpaceId: spaceId },
  )
  await applyWorkflowWriteResponse(d, 'workflow', result)
  return result.versions.at(-1)!.n
}

export async function promoteHostedWorkflowSpace(
  slug: string,
  n: number,
  reason: string,
  spaceId: string,
  d: Database,
  ports: Pick<PromotionPorts, 'preflight' | 'author'>,
): Promise<void> {
  const target = d
    .query<{ definition: string }, [string, string, number]>(
      `SELECT v.definition FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? AND w.space_id=? AND v.n=?`,
    )
    .get(slug, spaceId, n)!
  ports.preflight(JSON.parse(target.definition), spaceId)
  const current = d
    .query<{ n: number }, [string, string]>(
      `SELECT v.n FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? AND w.space_id=? AND v.status='production'`,
    )
    .get(slug, spaceId)
  const result = await recordApiClient().promoteWorkflow!(
    {
      kind: 'workflow',
      slug,
      n,
      expectedProductionVersion: current?.n ?? null,
      author: ports.author(),
      reason: reason.trim(),
      sessionId: sessionId(),
    },
    { destinationSpaceId: spaceId },
  )
  await applyWorkflowWriteResponse(d, 'workflow', result)
}

export async function promoteSharedWorkflow(
  slug: string,
  n: number,
  reason: string,
  sourceSpace: string,
  seedAuthor: string,
  d: Database,
  ports: PromotionPorts,
): Promise<WorkflowPromotionSpaceDecision> {
  const versions = storedVersions(slug, d)
  return promoteSharedWorkflowSpaces({
    slug,
    targetVersion: n,
    sourceSpace,
    seedAuthor,
    versions,
    draftVersion: (spaceId, version) =>
      spaceId === null
        ? Promise.resolve(ports.draftLocal(version as StoredPromotionVersion))
        : draftHosted(slug, spaceId, version as StoredPromotionVersion, d),
    promoteSpace: async (spaceId) => {
      if (spaceId === null) ports.promoteLocal()
      else await promoteHostedWorkflowSpace(slug, n, reason, spaceId, d, ports)
    },
  })
}
