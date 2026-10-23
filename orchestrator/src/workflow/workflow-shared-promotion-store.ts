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
import type { StepCatalogueDefinition } from './step-catalogue-definition.ts'
import type { WorkflowDefinition } from './workflow-definition.ts'
import {
  SHARED_WORKFLOW_PROMOTION_REASON,
  sharedWorkflowPromotionDisposition,
  sharedWorkflowPromotionSpaces,
  type WorkflowCatalogueBlock,
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
  preflight(
    definition: WorkflowDefinition,
    spaceId: string | null,
    catalogue: StepCatalogueDefinition,
  ): void
  catalogue: CataloguePromotionPorts
  author(): string
  missingCatalogueRefusal: string
}

export type CataloguePromotionPorts = {
  draftLocal(version: StoredPromotionVersion): number
  promoteLocal(version: number, reason: string): void
  preflight(definition: StepCatalogueDefinition, spaceId: string | null): void
  author(): string
}

type HostedRow = Record<string, unknown>
type HostedSpaceSnapshot = {
  spaceId: string
  rows: Map<RecordWorkflowTable, HostedRow[]>
  versions: StoredPromotionVersion[]
  catalogueVersions: StoredPromotionVersion[]
}

type SharedWorkflowPromotionInput<Row extends WorkflowPromotionVersion> = {
  slug: string
  targetVersion: number
  sourceSpace: string
  targetSpaces: readonly (string | null)[]
  versions: readonly Row[]
  draftVersion(spaceId: string | null, version: Row): Promise<number>
  promoteSpace(spaceId: string | null): Promise<void>
}

async function promoteSharedWorkflowSpaces<Row extends WorkflowPromotionVersion>(
  input: SharedWorkflowPromotionInput<Row>,
): Promise<WorkflowPromotionSpaceDecision> {
  const decision = sharedWorkflowPromotionSpaces(
    input.versions,
    input.targetVersion,
    input.sourceSpace,
    input.targetSpaces,
  )
  const source = input.versions
    .filter((row) => row.spaceId === input.sourceSpace && row.n <= input.targetVersion)
    .sort((left, right) => left.n - right.n)
  for (const spaceId of decision.changed) {
    const present = new Set(
      input.versions.filter((row) => row.spaceId === spaceId).map((row) => row.n),
    )
    for (const version of source.filter((row) => !present.has(row.n))) {
      const written = await input.draftVersion(spaceId, version)
      if (written !== version.n)
        throw new Error(
          `refusing shared workflow promotion for "${input.slug}": space ${spaceId ?? 'local'} wrote version ${written} while copying version ${version.n}; refresh and retry`,
        )
    }
    await input.promoteSpace(spaceId)
  }
  return decision
}

const storedVersions = (slug: string, d: Database): StoredPromotionVersion[] =>
  d
    .query<StoredPromotionVersion, [string]>(
      `SELECT w.space_id spaceId,v.n,v.status,v.author,v.definition,v.reason FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? ORDER BY w.space_id,v.n`,
    )
    .all(slug)

const storedCatalogueVersions = (d: Database): StoredPromotionVersion[] =>
  d
    .query<StoredPromotionVersion, []>(
      `SELECT c.space_id spaceId,v.n,v.status,v.author,v.definition,v.reason FROM step_catalogue_version v JOIN step_catalogue c ON c.id=v.catalogue_id WHERE c.slug='shared' ORDER BY c.space_id,v.n`,
    )
    .all()

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

async function hostedSnapshot(spaceId: string, slug: string | null): Promise<HostedSpaceSnapshot> {
  const rows = new Map<RecordWorkflowTable, HostedRow[]>()
  try {
    for (const table of RECORD_WORKFLOW_TABLES) rows.set(table, await hostedRows(spaceId, table))
  } catch (error) {
    throw new Error(
      `refusing shared workflow promotion: could not read authoritative workflow state for space ${spaceId}: ${error instanceof Error ? error.message : String(error)}; refresh and retry`,
    )
  }
  const identity =
    slug === null ? undefined : rows.get('workflow')!.find((row) => row.slug === slug)
  const catalogue = rows.get('step_catalogue')!.find((row) => row.slug === 'shared')
  const versionRows = identity
    ? rows.get('workflow_version')!.filter((row) => row.ownerId === identity.id)
    : []
  const catalogueVersionRows = catalogue
    ? rows.get('step_catalogue_version')!.filter((row) => row.ownerId === catalogue.id)
    : []
  const versionsFor = (items: HostedRow[]): StoredPromotionVersion[] =>
    items.map((row) => ({
      spaceId,
      n: Number(row.n),
      status: String(row.status) as StoredPromotionVersion['status'],
      author: String(row.author),
      definition: String(row.definition),
      reason: String(row.reason),
    }))
  return {
    spaceId,
    rows,
    versions: versionsFor(versionRows),
    catalogueVersions: versionsFor(catalogueVersionRows),
  }
}

async function draftHosted(
  slug: string,
  spaceId: string,
  version: StoredPromotionVersion,
  d: Database,
  kind: 'workflow' | 'step_catalogue' = 'workflow',
): Promise<number> {
  const result = await recordApiClient().draftWorkflow!(
    {
      kind,
      slug,
      event: 'import',
      definition: version.definition,
      author: version.author,
      reason: version.reason,
      sessionId: sessionId(),
    },
    { destinationSpaceId: spaceId },
  )
  await applyWorkflowWriteResponse(d, kind, result)
  return result.versions.at(-1)!.n
}

async function promoteHostedCatalogueSpace(
  n: number,
  reason: string,
  spaceId: string,
  d: Database,
  ports: Pick<CataloguePromotionPorts, 'author'>,
  expectedProductionVersion: number | null,
): Promise<void> {
  const result = await recordApiClient().promoteWorkflow!(
    {
      kind: 'step_catalogue',
      slug: 'shared',
      n,
      expectedProductionVersion,
      author: ports.author(),
      reason: reason.trim(),
      sessionId: sessionId(),
    },
    { destinationSpaceId: spaceId },
  )
  await applyWorkflowWriteResponse(d, 'step_catalogue', result)
}

async function applySharedCataloguePromotion(
  n: number,
  reason: string,
  sourceSpace: string,
  targetSpaces: readonly (string | null)[],
  versions: readonly StoredPromotionVersion[],
  d: Database,
  ports: CataloguePromotionPorts,
): Promise<WorkflowPromotionSpaceDecision> {
  const decision = sharedWorkflowPromotionSpaces(versions, n, sourceSpace, targetSpaces)
  const sourceTarget = versions.find(
    (version) => version.spaceId === sourceSpace && version.n === n,
  )
  if (!sourceTarget)
    throw new Error(`step catalogue has no version ${n} in hosted space ${sourceSpace}`)
  for (const spaceId of decision.changed) {
    const disposition = sharedWorkflowPromotionDisposition(spaceId, versions, sourceSpace)
    const target = `space ${spaceId ?? 'local'} catalogue ${disposition} planned version ${n}`
    try {
      ports.preflight(JSON.parse(sourceTarget.definition), spaceId)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `refusing shared workflow promotion for "shared step catalogue": ${target} cannot carry the workflow: ${reason}`,
      )
    }
  }
  return promoteSharedWorkflowSpaces({
    slug: 'shared step catalogue',
    targetVersion: n,
    sourceSpace,
    versions,
    targetSpaces,
    draftVersion: (spaceId, version) =>
      spaceId === null
        ? Promise.resolve(ports.draftLocal(version))
        : draftHosted('shared', spaceId, version, d, 'step_catalogue'),
    promoteSpace: async (spaceId) => {
      if (spaceId === null) ports.promoteLocal(n, reason)
      else {
        const expected = versions.find(
          (version) => version.spaceId === spaceId && version.status === 'production',
        )?.n
        await promoteHostedCatalogueSpace(n, reason, spaceId, d, ports, expected ?? null)
      }
    },
  })
}

/** A null slug gathers catalogue state without selecting a workflow. */
async function sharedPromotionState(slug: string | null, sourceSpace: string, d: Database) {
  const membershipList = await recordMemberships(recordApiClient())
  const spaceIds = membershipList.memberships.map((membership) => membership.spaceId)
  if (!spaceIds.includes(sourceSpace)) spaceIds.unshift(sourceSpace)
  const snapshots = await Promise.all(spaceIds.map((spaceId) => hostedSnapshot(spaceId, slug)))
  for (const snapshot of snapshots)
    for (const table of RECORD_WORKFLOW_TABLES)
      for (const row of snapshot.rows.get(table)!) applyWorkflowCatalogueRow(d, table, row)
  return { spaceIds, snapshots }
}

export async function promoteSharedStepCatalogue(
  n: number,
  reason: string,
  sourceSpace: string,
  d: Database,
  ports: CataloguePromotionPorts,
): Promise<WorkflowPromotionSpaceDecision> {
  const { spaceIds, snapshots } = await sharedPromotionState(null, sourceSpace, d)
  const versions = [
    ...storedCatalogueVersions(d).filter((row) => row.spaceId === null),
    ...snapshots.flatMap((snapshot) => snapshot.catalogueVersions),
  ]
  return applySharedCataloguePromotion(
    n,
    `${SHARED_WORKFLOW_PROMOTION_REASON} ${reason.trim()}`,
    sourceSpace,
    [null, ...spaceIds],
    versions,
    d,
    ports,
  )
}

async function promoteHostedWorkflowSpace(
  slug: string,
  n: number,
  reason: string,
  spaceId: string,
  d: Database,
  ports: Pick<PromotionPorts, 'author'>,
  expectedProductionVersion: number | null,
): Promise<void> {
  const target = d
    .query<{ present: number }, [string, string, number]>(
      `SELECT 1 AS present FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? AND w.space_id=? AND v.n=?`,
    )
    .get(slug, spaceId, n)
  if (!target) throw new Error(`workflow "${slug}" has no version ${n} in hosted space ${spaceId}`)
  const result = await recordApiClient().promoteWorkflow!(
    {
      kind: 'workflow',
      slug,
      n,
      expectedProductionVersion,
      author: ports.author(),
      reason: reason.trim(),
      sessionId: sessionId(),
    },
    { destinationSpaceId: spaceId },
  )
  await applyWorkflowWriteResponse(d, 'workflow', result)
}

function preflightSharedWorkflowTargets(input: {
  slug: string
  definition: WorkflowDefinition
  sourceSpace: string
  spaces: readonly (string | null)[]
  catalogueVersions: readonly StoredPromotionVersion[]
  sourceCatalogue: StoredPromotionVersion
  ports: Pick<PromotionPorts, 'preflight' | 'missingCatalogueRefusal'>
}): WorkflowCatalogueBlock[] {
  const blocked: WorkflowCatalogueBlock[] = []
  for (const spaceId of input.spaces) {
    const disposition = sharedWorkflowPromotionDisposition(
      spaceId,
      input.catalogueVersions,
      input.sourceSpace,
    )
    const catalogue =
      disposition === 'follower'
        ? input.sourceCatalogue
        : input.catalogueVersions.find(
            (version) => version.spaceId === spaceId && version.status === 'production',
          )
    const target = `space ${spaceId ?? 'local'} catalogue ${disposition} planned version ${catalogue?.n ?? 'none'}`
    if (!catalogue)
      throw new Error(
        `refusing shared workflow promotion for "${input.slug}": ${target} cannot carry the workflow: ${input.ports.missingCatalogueRefusal}`,
      )
    try {
      input.ports.preflight(input.definition, spaceId, JSON.parse(catalogue.definition))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (disposition !== 'follower') {
        blocked.push({
          space: spaceId ?? 'local',
          disposition,
          plannedVersion: catalogue.n,
          reason,
        })
        continue
      }
      throw new Error(
        `refusing shared workflow promotion for "${input.slug}": ${target} cannot carry the workflow: ${reason}`,
      )
    }
  }
  return blocked
}

export async function promoteSharedWorkflow(
  slug: string,
  n: number,
  reason: string,
  sourceSpace: string,
  d: Database,
  ports: PromotionPorts,
): Promise<WorkflowPromotionSpaceDecision> {
  const { spaceIds, snapshots } = await sharedPromotionState(slug, sourceSpace, d)
  const versions = [
    ...storedVersions(slug, d).filter((row) => row.spaceId === null),
    ...snapshots.flatMap((snapshot) => snapshot.versions),
  ]
  const sharedReason = `${SHARED_WORKFLOW_PROMOTION_REASON} ${reason.trim()}`
  const targetSpaces = [null, ...spaceIds]
  const workflowDecision = sharedWorkflowPromotionSpaces(versions, n, sourceSpace, targetSpaces)
  const catalogueVersions = [
    ...storedCatalogueVersions(d).filter((row) => row.spaceId === null),
    ...snapshots.flatMap((snapshot) => snapshot.catalogueVersions),
  ]
  const sourceCatalogue = catalogueVersions.find(
    (version) => version.spaceId === sourceSpace && version.status === 'production',
  )
  if (!sourceCatalogue) throw new Error(ports.missingCatalogueRefusal)
  const workflowTarget = versions.find(
    (version) => version.spaceId === sourceSpace && version.n === n,
  )
  if (!workflowTarget)
    throw new Error(`workflow "${slug}" has no version ${n} in hosted space ${sourceSpace}`)
  const blockedByCatalogue = preflightSharedWorkflowTargets({
    slug,
    definition: JSON.parse(workflowTarget.definition) as WorkflowDefinition,
    sourceSpace,
    spaces: workflowDecision.changed,
    catalogueVersions,
    sourceCatalogue,
    ports,
  })
  await applySharedCataloguePromotion(
    sourceCatalogue.n,
    sharedReason,
    sourceSpace,
    targetSpaces,
    catalogueVersions,
    d,
    ports.catalogue,
  )
  const promoted = await promoteSharedWorkflowSpaces({
    slug,
    targetVersion: n,
    sourceSpace,
    versions,
    targetSpaces: targetSpaces.filter(
      (spaceId) => !blockedByCatalogue.some((blocked) => blocked.space === (spaceId ?? 'local')),
    ),
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
  return { ...promoted, ...(blockedByCatalogue.length ? { blockedByCatalogue } : {}) }
}
