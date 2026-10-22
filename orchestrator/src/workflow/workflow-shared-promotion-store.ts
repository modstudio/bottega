// concern: workflow-shared-promotion-store
/** Reads hosted workflow state and applies single-space or shared promotions. */
import type { Database } from 'bun:sqlite'
import { sessionId } from '../database/db.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import {
  applyWorkflowCatalogueRow,
  applyWorkflowWriteResponse,
} from '../record/record-cache-workflow.ts'
import { recordMemberships } from '../record/record-space.ts'
import {
  RECORD_WORKFLOW_TABLES,
  type RecordWorkflowTable,
} from '../record/record-workflow-contract.ts'
import type { WorkflowDefinition } from './workflow-definition.ts'
import {
  promoteSharedWorkflowSpaces,
  SHARED_WORKFLOW_PROMOTION_REASON,
  type WorkflowPromotionEvent,
  type WorkflowPromotionSpaceDecision,
  type WorkflowPromotionVersion,
} from './workflow-shared-promotion.ts'

type StoredPromotionVersion = WorkflowPromotionVersion & {
  definition: string
  reason: string
}
type PromotionPorts = {
  draftLocal(version: StoredPromotionVersion): number
  promoteLocal(reason: string): void
  preflight(definition: WorkflowDefinition, spaceId: string): void
  author(): string
}

type HostedRow = Record<string, unknown>
type HostedSpaceSnapshot = {
  spaceId: string
  rows: Map<RecordWorkflowTable, HostedRow[]>
  versions: StoredPromotionVersion[]
  events: WorkflowPromotionEvent[]
}

const storedVersions = (slug: string, d: Database): StoredPromotionVersion[] =>
  d
    .query<StoredPromotionVersion, [string]>(
      `SELECT w.space_id spaceId,v.n,v.status,v.author,v.definition,v.reason FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? ORDER BY w.space_id,v.n`,
    )
    .all(slug)

const storedEvents = (slug: string, d: Database): WorkflowPromotionEvent[] =>
  d
    .query<WorkflowPromotionEvent, [string]>(
      `SELECT w.space_id spaceId,e.event,e.author,e.reason FROM workflow_event e JOIN workflow w ON w.id=e.workflow_id WHERE w.slug=? ORDER BY w.space_id,e.id`,
    )
    .all(slug)

async function hostedRows(spaceId: string, table: RecordWorkflowTable): Promise<HostedRow[]> {
  const rows: HostedRow[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await recordApiClient().listWorkflowCatalogue!(
      table,
      { limit: 100, cursor },
      { destinationSpaceId: spaceId },
    )
    rows.push(...page.items)
    if (!page.nextCursor) return rows
    cursor = page.nextCursor
  }
}

async function hostedSnapshot(spaceId: string, slug: string): Promise<HostedSpaceSnapshot> {
  const rows = new Map<RecordWorkflowTable, HostedRow[]>()
  try {
    for (const table of RECORD_WORKFLOW_TABLES) rows.set(table, await hostedRows(spaceId, table))
  } catch (error) {
    throw new Error(
      `refusing shared workflow promotion: could not read authoritative workflow state for space ${spaceId}: ${error instanceof Error ? error.message : String(error)}; refresh and retry`,
    )
  }
  const identity = rows.get('workflow')!.find((row) => row.slug === slug)
  if (!identity) return { spaceId, rows, versions: [], events: [] }
  const versionRows = rows.get('workflow_version')!.filter((row) => row.ownerId === identity.id)
  const versionIds = new Set(versionRows.map((row) => row.id))
  return {
    spaceId,
    rows,
    versions: versionRows.map((row) => ({
      spaceId,
      n: Number(row.n),
      status: String(row.status) as StoredPromotionVersion['status'],
      author: String(row.author),
      definition: String(row.definition),
      reason: String(row.reason),
    })),
    events: rows
      .get('workflow_event')!
      .filter((row) => versionIds.has(row.ownerVersionId))
      .map((row) => ({
        spaceId,
        event: String(row.event),
        author: String(row.author),
        reason: String(row.reason),
      })),
  }
}

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
  expectedProductionVersion?: number | null,
): Promise<void> {
  const target = d
    .query<{ definition: string }, [string, string, number]>(
      `SELECT v.definition FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? AND w.space_id=? AND v.n=?`,
    )
    .get(slug, spaceId, n)!
  ports.preflight(JSON.parse(target.definition) as WorkflowDefinition, spaceId)
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
      expectedProductionVersion:
        expectedProductionVersion === undefined ? (current?.n ?? null) : expectedProductionVersion,
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
  const membershipList = await recordMemberships(recordApiClient())
  const spaceIds = membershipList.memberships.map((membership) => membership.spaceId)
  if (sourceSpace && !spaceIds.includes(sourceSpace)) spaceIds.unshift(sourceSpace)
  const snapshots = await Promise.all(spaceIds.map((spaceId) => hostedSnapshot(spaceId, slug)))
  for (const snapshot of snapshots)
    for (const table of RECORD_WORKFLOW_TABLES)
      for (const row of snapshot.rows.get(table)!) applyWorkflowCatalogueRow(d, table, row)
  const versions = [
    ...storedVersions(slug, d).filter((row) => row.spaceId === null),
    ...snapshots.flatMap((snapshot) => snapshot.versions),
  ]
  const events = [
    ...storedEvents(slug, d).filter((event) => event.spaceId === null),
    ...snapshots.flatMap((snapshot) => snapshot.events),
  ]
  const sharedReason = `${SHARED_WORKFLOW_PROMOTION_REASON} ${reason.trim()}`
  return promoteSharedWorkflowSpaces({
    slug,
    targetVersion: n,
    sourceSpace,
    seedAuthor,
    versions,
    events,
    targetSpaces: [null, ...spaceIds],
    draftVersion: (spaceId, version) =>
      spaceId === null
        ? Promise.resolve(ports.draftLocal(version))
        : draftHosted(slug, spaceId, version, d),
    promoteSpace: async (spaceId) => {
      if (spaceId === null) ports.promoteLocal(sharedReason)
      else {
        const expectedProductionVersion = versions.find(
          (version) => version.spaceId === spaceId && version.status === 'production',
        )?.n
        await promoteHostedWorkflowSpace(
          slug,
          n,
          sharedReason,
          spaceId,
          d,
          ports,
          expectedProductionVersion ?? null,
        )
      }
    },
  })
}
