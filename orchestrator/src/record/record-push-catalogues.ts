// concern: record-push-catalogues
/** Plans and performs the one-time null-space catalogue backfill. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { replicatedRecordId } from '../../../shared/record-id.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { db } from '../database/db.ts'
import { normalizePortBaselineScannedAt } from '../porting/porting-date.ts'
import { projects } from '../project/projects.ts'
import { activeRecordSpace, cachedProjectSpaces } from '../project-space.ts'
import type { RecordApiClient } from './record-api-client.ts'
import { recordApiClient } from './record-api-client.ts'
import type { RecordIdentity } from './record-auth.ts'
import { pullRecordCache } from './record-cache.ts'
import type { RecordLensImportInput } from './record-lens-contract.ts'
import type { RecordPortImportInput } from './record-port-contract.ts'
import {
  declaredRecordSpace,
  noActiveRecordSpaceRefusal,
  projectRecordDestination,
} from './record-project-destination.ts'
import { syncRecord } from './record-sync.ts'
import type { RecordWorkflowImportInput } from './record-workflow-contract.ts'

type Presentation = { log(value: string): void }
type Plan = {
  lens: Map<string, RecordLensImportInput>
  workflow: Map<string, RecordWorkflowImportInput>
  ports: Map<string, RecordPortImportInput>
  skipped: Array<{ kind: string; id: string; reason: string }>
}
type LensPlanRows = {
  lenses: Record<string, unknown>[]
  revisions: Record<string, unknown>[]
  selections: Record<string, unknown>[]
  selectionRevisions: Record<string, unknown>[]
  profiles: Record<string, unknown>[]
  profileRevisions: Record<string, unknown>[]
}
const iso = () => new Date().toISOString()
const forEachValue = <T>(values: readonly T[], use: (value: T) => void) => values.forEach(use)

type ProjectRoutes = ReadonlyMap<string, string | null>

function cachedProjectRoutes(local: Database): Map<string, string | null> {
  const cache = cachedProjectSpaces(local)
  const registered = local.query('SELECT name FROM project').all() as { name: string }[]
  return new Map(
    registered.flatMap((project) => {
      const value = cache[project.name]
      return typeof value === 'string' || value === null ? [[project.name, value]] : []
    }),
  )
}

function currentProjectRoutes(
  local: Database,
  identity: RecordIdentity,
  activeSpaceId: string,
): Map<string, string | null> {
  const memberships = parseRecordSpaceMemberships(identity.memberships)
  return new Map(
    [...projects(undefined, local), ...projects({ retired: true }, local)].map((project) => {
      const destination = projectRecordDestination(
        project.name,
        declaredRecordSpace(project.settings),
        activeSpaceId,
        memberships,
      )
      return [project.name, 'refused' in destination ? null : destination.spaceId]
    }),
  )
}

function routedProjects(local: Database, routes: ProjectRoutes): Map<string, Set<string>> {
  const routed = new Map<string, Set<string>>()
  const rows = local.query('SELECT record_id,name FROM project ORDER BY name').all() as {
    record_id: string
    name: string
  }[]
  for (const row of rows) {
    const space = routes.get(row.name)
    if (!space) continue
    const projectIds = routed.get(space) ?? new Set<string>()
    projectIds.add(row.record_id)
    routed.set(space, projectIds)
  }
  return routed
}

function lensPlanRows(local: Database): LensPlanRows {
  const lenses = local
      .query(
        'SELECT record_id,id,title,question,excludes,slots,version,enabled,requires_execution FROM lens WHERE space_id IS NULL',
      )
      .all() as Record<string, unknown>[],
    revisions = local
      .query(
        `SELECT record_id,lens_record_id,version,prior_body,reason,session_id,at FROM lens_revision WHERE space_id IS NULL`,
      )
      .all() as Record<string, unknown>[],
    selections = local
      .query(
        `SELECT record_id,project_record_id,lens_record_id,axis,profile_name,selected_version,selection_version FROM project_lens_profile WHERE space_id IS NULL`,
      )
      .all() as Record<string, unknown>[],
    selectionRevisions = local
      .query(
        `SELECT r.record_id,r.selection_record_id,r.prior_profile_name,r.prior_selected_version,r.reason,r.session_id,r.at,s.project_record_id
         FROM project_lens_profile_revision r JOIN project_lens_profile s ON s.record_id=r.selection_record_id WHERE r.space_id IS NULL`,
      )
      .all() as Record<string, unknown>[],
    profiles = (
      local
        .query(
          `SELECT record_id,lens_record_id,axis,name,version,current_version_id,body,enabled FROM lens_profile WHERE space_id IS NULL`,
        )
        .all() as Record<string, unknown>[]
    ).filter(
      (profile) =>
        Boolean(profile.enabled) ||
        selections.some(
          (selection) =>
            selection.axis === profile.axis &&
            selection.profile_name === profile.name &&
            (selection.lens_record_id == null ||
              selection.lens_record_id === profile.lens_record_id),
        ),
    ),
    profileIds = new Set(profiles.map((profile) => String(profile.record_id))),
    profileRevisions = (
      local
        .query(
          `SELECT record_id,profile_record_id,version,prior_body,reason,session_id,at FROM lens_profile_revision WHERE space_id IS NULL`,
        )
        .all() as Record<string, unknown>[]
    ).filter((revision) => profileIds.has(String(revision.profile_record_id)))
  return {
    lenses,
    revisions,
    selections,
    selectionRevisions,
    profiles,
    profileRevisions,
  }
}

function lensSpacePlan(
  spaceId: string,
  projectIds: Set<string>,
  rows: LensPlanRows,
  now: string,
): RecordLensImportInput {
  const { lenses, revisions, selections, selectionRevisions, profiles, profileRevisions } = rows
  const inSpace = selections.filter((row) => projectIds.has(String(row.project_record_id)))
  const selectionIds = new Set(inSpace.map((row) => String(row.record_id)))
  return {
    dryRun: false,
    lens: lenses.map((r) => ({
      id: replicatedRecordId(spaceId, 'lens', String(r.record_id)),
      spaceId,
      key: String(r.id),
      title: String(r.title),
      question: String(r.question),
      excludes: String(r.excludes),
      slots: String(r.slots),
      version: Number(r.version),
      enabled: Boolean(r.enabled),
      requiresExecution: Boolean(r.requires_execution),
      updatedAt: now,
    })),
    lens_revision: revisions.map((r) => ({
      id: replicatedRecordId(spaceId, 'lens_revision', String(r.record_id)),
      spaceId,
      lensId: replicatedRecordId(spaceId, 'lens', String(r.lens_record_id)),
      version: Number(r.version),
      priorBody: String(r.prior_body),
      reason: String(r.reason),
      sessionId: r.session_id == null ? null : String(r.session_id),
      at: String(r.at),
    })),
    lens_profile: profiles.map((r) => ({
      id: replicatedRecordId(spaceId, 'lens_profile', String(r.record_id)),
      spaceId,
      lensId: replicatedRecordId(spaceId, 'lens', String(r.lens_record_id)),
      axis: r.axis as 'framework' | 'architecture',
      name: String(r.name),
      version: Number(r.version),
      currentVersionId:
        r.current_version_id == null
          ? null
          : replicatedRecordId(spaceId, 'lens_profile_revision', String(r.current_version_id)),
      body: String(r.body),
      enabled: Boolean(r.enabled),
      updatedAt: now,
    })),
    lens_profile_revision: profileRevisions.map((r) => ({
      id: replicatedRecordId(spaceId, 'lens_profile_revision', String(r.record_id)),
      spaceId,
      profileId: replicatedRecordId(spaceId, 'lens_profile', String(r.profile_record_id)),
      version: Number(r.version),
      priorBody: String(r.prior_body),
      reason: String(r.reason),
      sessionId: r.session_id == null ? null : String(r.session_id),
      at: String(r.at),
    })),
    project_lens_profile: inSpace.map((r) => ({
      id: replicatedRecordId(spaceId, 'project_lens_profile', String(r.record_id)),
      spaceId,
      projectId: String(r.project_record_id),
      lensId:
        r.lens_record_id == null
          ? null
          : replicatedRecordId(spaceId, 'lens', String(r.lens_record_id)),
      axis: r.axis as 'framework' | 'architecture',
      profileName: String(r.profile_name),
      selectedVersion: r.selected_version == null ? null : Number(r.selected_version),
      selectionVersion: Number(r.selection_version),
      updatedAt: now,
    })),
    project_lens_profile_revision: selectionRevisions
      .filter((r) => selectionIds.has(String(r.selection_record_id)))
      .map((r) => ({
        id: replicatedRecordId(spaceId, 'project_lens_profile_revision', String(r.record_id)),
        spaceId,
        selectionId: replicatedRecordId(
          spaceId,
          'project_lens_profile',
          String(r.selection_record_id),
        ),
        priorProfileName: r.prior_profile_name == null ? null : String(r.prior_profile_name),
        priorSelectedVersion:
          r.prior_selected_version == null ? null : Number(r.prior_selected_version),
        reason: String(r.reason),
        sessionId: r.session_id == null ? null : String(r.session_id),
        at: String(r.at),
      })),
  }
}

function lensPlan(
  local: Database,
  routed: Map<string, Set<string>>,
): Map<string, RecordLensImportInput> {
  const rows = lensPlanRows(local)
  const now = iso()
  const plans = new Map<string, RecordLensImportInput>()
  for (const [spaceId, projectIds] of routed) {
    const plan = lensSpacePlan(spaceId, projectIds, rows, now)
    if (catalogueRowCount(plan)) plans.set(spaceId, plan)
  }
  for (const [spaceId, plan] of plans) if (!catalogueRowCount(plan)) plans.delete(spaceId)
  return plans
}

function workflowSpacePlan(local: Database, spaceId: string): RecordWorkflowImportInput {
  const now = iso()
  const kind = (name: 'workflow' | 'step_catalogue') => {
    const foreign = name === 'workflow' ? 'workflow_record_id' : 'catalogue_record_id'
    const eventForeign =
      name === 'workflow' ? 'workflow_version_record_id' : 'catalogue_version_record_id'
    const identities = (
      local.query(`SELECT * FROM ${name} WHERE space_id IS NULL`).all() as Record<string, unknown>[]
    ).map((r) => ({
      id: replicatedRecordId(spaceId, name, String(r.record_id)),
      spaceId,
      slug: String(r.slug),
      generation: 1,
      createdAt: String(r.created_at),
      updatedAt: now,
    }))
    const versions = (
      local
        .query(
          `SELECT v.*,i.record_id owner_record_id FROM ${name}_version v JOIN ${name} i ON i.record_id=v.${foreign} WHERE v.space_id IS NULL AND v.superseded_at IS NULL`,
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: replicatedRecordId(spaceId, `${name}_version`, String(r.record_id)),
      spaceId,
      ownerId: replicatedRecordId(spaceId, name, String(r.owner_record_id)),
      n: Number(r.n),
      status: r.status as 'draft' | 'production' | 'retired',
      definition: String(r.definition),
      author: String(r.author),
      reason: String(r.reason),
      createdAt: String(r.created_at),
      promotedAt: r.promoted_at == null ? null : String(r.promoted_at),
      retiredAt: r.retired_at == null ? null : String(r.retired_at),
      updatedAt: now,
    }))
    const events = (
      local
        .query(
          `SELECT e.*,v.record_id version_record_id FROM ${name}_event e JOIN ${name}_version v ON v.record_id=e.${eventForeign} WHERE e.space_id IS NULL AND v.superseded_at IS NULL`,
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: replicatedRecordId(spaceId, `${name}_event`, String(r.record_id)),
      spaceId,
      ownerVersionId: replicatedRecordId(spaceId, `${name}_version`, String(r.version_record_id)),
      event: r.event as 'set' | 'fork' | 'import' | 'promote' | 'retire',
      author: String(r.author),
      reason: String(r.reason),
      sessionId: r.session_id == null ? null : String(r.session_id),
      at: String(r.at),
    }))
    return { identities, versions, events }
  }
  const step = kind('step_catalogue'),
    workflow = kind('workflow')
  return {
    dryRun: false,
    step_catalogue: step.identities,
    step_catalogue_version: step.versions,
    step_catalogue_event: step.events,
    workflow: workflow.identities,
    workflow_version: workflow.versions,
    workflow_event: workflow.events,
  }
}

function emptyPort(): RecordPortImportInput {
  return {
    dryRun: false,
    replace: false,
    port_doctrine: [],
    port_pair: [],
    port_baseline: [],
    port_ref: [],
    port_ref_source: [],
    port_skip: [],
  }
}

type PortPlanContext = {
  routes: ProjectRoutes
  plans: Map<string, RecordPortImportInput>
  pairSpace: Map<string, string>
  refSpace: Map<string, string>
  skipped: Plan['skipped']
  now: string
}

function addPortPair(r: Record<string, unknown>, context: PortPlanContext): void {
  const source = context.routes.get(String(r.source_name))
  const target = context.routes.get(String(r.target_name))
  if (!source) {
    context.skipped.push({
      kind: 'port_pair',
      id: String(r.record_id),
      reason:
        source === undefined
          ? `source project route unknown, run \`${PLATFORM_SLUG} record sync\``
          : 'source project has no hosted space',
    })
    return
  }
  if (!target) {
    context.skipped.push({
      kind: 'port_pair',
      id: String(r.record_id),
      reason:
        target === undefined
          ? `target project route unknown, run \`${PLATFORM_SLUG} record sync\``
          : 'target project has no hosted space',
    })
    return
  }
  const plan = context.plans.get(target) ?? emptyPort()
  context.plans.set(target, plan)
  context.pairSpace.set(String(r.record_id), target)
  plan.port_pair.push({
    id: String(r.record_id),
    spaceId: target,
    sourceProjectId: String(r.source_project_record_id),
    targetProjectId: String(r.target_project_record_id),
    createdAt: String(r.created_at),
  })
}

function addPortBaseline(r: Record<string, unknown>, context: PortPlanContext): void {
  const space = context.pairSpace.get(String(r.pair_record_id))
  if (!space) {
    context.skipped.push({
      kind: 'port_baseline',
      id: String(r.record_id),
      reason: 'pair was skipped',
    })
    return
  }
  context.plans.get(space)!.port_baseline.push({
    id: String(r.record_id),
    spaceId: space,
    pairId: String(r.pair_record_id),
    sourceCommit: r.source_commit == null ? null : String(r.source_commit),
    scannedAt: normalizePortBaselineScannedAt(r.scanned_at == null ? null : String(r.scanned_at)),
    version: Number(r.version),
    updatedAt: context.now,
  })
}

function addPortRef(r: Record<string, unknown>, context: PortPlanContext): void {
  const space = context.routes.get(String(r.project_name))
  if (!space) {
    context.skipped.push({
      kind: 'port_ref',
      id: String(r.record_id),
      reason:
        space === undefined
          ? `target project route unknown, run \`${PLATFORM_SLUG} record sync\``
          : 'target project has no hosted space',
    })
    return
  }
  const plan = context.plans.get(space) ?? emptyPort()
  context.plans.set(space, plan)
  context.refSpace.set(String(r.record_id), space)
  plan.port_ref.push({
    id: String(r.record_id),
    spaceId: space,
    taskKey: String(r.task_key),
    targetProjectId: String(r.target_project_record_id),
    note: String(r.note),
    createdAt: String(r.created_at),
    resolvedAt: r.resolved_at == null ? null : String(r.resolved_at),
    deletedAt: null,
    version: Number(r.version),
    updatedAt: context.now,
  })
}

function addPortRefSource(r: Record<string, unknown>, context: PortPlanContext): void {
  const space = context.refSpace.get(String(r.ref_record_id))
  if (!space) {
    context.skipped.push({
      kind: 'port_ref_source',
      id: String(r.record_id),
      reason: 'ref was skipped',
    })
    return
  }
  const source = context.routes.get(String(r.source_name))
  if (!source) {
    context.skipped.push({
      kind: 'port_ref_source',
      id: String(r.record_id),
      reason:
        source === undefined
          ? `source project route unknown, run \`${PLATFORM_SLUG} record sync\``
          : 'source project has no hosted space',
    })
    return
  }
  context.plans.get(space)!.port_ref_source.push({
    id: String(r.record_id),
    spaceId: space,
    refId: String(r.ref_record_id),
    sourceProjectId: String(r.source_project_record_id),
    commits: String(r.commits),
    paths: String(r.paths),
    note: String(r.note),
    deletedAt: null,
    updatedAt: context.now,
  })
}

function addPortSkip(r: Record<string, unknown>, context: PortPlanContext): void {
  const space = context.pairSpace.get(String(r.pair_record_id))
  if (!space) {
    context.skipped.push({
      kind: 'port_skip',
      id: String(r.record_id),
      reason: 'pair was skipped',
    })
    return
  }
  context.plans.get(space)!.port_skip.push({
    id: String(r.record_id),
    spaceId: space,
    pairId: String(r.pair_record_id),
    candidate: String(r.candidate),
    reason: String(r.reason),
    skippedAt: String(r.skipped_at),
  })
}

function portPlan(
  local: Database,
  activeSpaceId: string,
  routes: ProjectRoutes,
  skipped: Plan['skipped'],
) {
  const plans = new Map<string, RecordPortImportInput>(),
    active = emptyPort(),
    now = iso()
  active.port_doctrine = (
    local
      .query(
        'SELECT record_id,number,title,body,created_at,retired_at,version FROM port_doctrine WHERE space_id IS NULL',
      )
      .all() as Record<string, unknown>[]
  ).map((r) => ({
    id: String(r.record_id),
    spaceId: activeSpaceId,
    number: Number(r.number),
    title: String(r.title),
    body: String(r.body),
    createdAt: String(r.created_at),
    retiredAt: r.retired_at == null ? null : String(r.retired_at),
    version: Number(r.version),
    updatedAt: String(r.created_at),
  }))
  if (active.port_doctrine.length) plans.set(activeSpaceId, active)
  const pairSpace = new Map<string, string>(),
    refSpace = new Map<string, string>()
  const context: PortPlanContext = {
    routes,
    plans,
    pairSpace,
    refSpace,
    skipped,
    now,
  }
  forEachValue(
    local
      .query(
        `SELECT pp.record_id,pp.source_project_record_id,pp.target_project_record_id,pp.created_at,sp.name source_name,tp.name target_name
         FROM port_pair pp JOIN project sp ON sp.record_id=pp.source_project_record_id JOIN project tp ON tp.record_id=pp.target_project_record_id WHERE pp.space_id IS NULL`,
      )
      .all() as Record<string, unknown>[],
    (r) => addPortPair(r, context),
  )
  forEachValue(
    local
      .query(
        `SELECT record_id,pair_record_id,source_commit,scanned_at,version FROM port_baseline WHERE space_id IS NULL`,
      )
      .all() as Record<string, unknown>[],
    (r) => addPortBaseline(r, context),
  )
  forEachValue(
    local
      .query(
        `SELECT pr.record_id,pr.task_key,pr.target_project_record_id,pr.note,pr.created_at,pr.resolved_at,pr.version,p.name project_name
         FROM port_ref pr JOIN project p ON p.record_id=pr.target_project_record_id WHERE pr.space_id IS NULL`,
      )
      .all() as Record<string, unknown>[],
    (r) => addPortRef(r, context),
  )
  forEachValue(
    local
      .query(
        `SELECT s.record_id,s.ref_record_id,s.source_project_record_id,s.commits,s.paths,s.note,p.name source_name
         FROM port_ref_source s JOIN project p ON p.record_id=s.source_project_record_id WHERE s.space_id IS NULL`,
      )
      .all() as Record<string, unknown>[],
    (r) => addPortRefSource(r, context),
  )
  forEachValue(
    local
      .query(
        `SELECT record_id,pair_record_id,candidate,reason,skipped_at FROM port_skip WHERE space_id IS NULL`,
      )
      .all() as Record<string, unknown>[],
    (r) => addPortSkip(r, context),
  )
  return plans
}

function planCataloguePush(local: Database, activeSpaceId: string, routes: ProjectRoutes): Plan {
  const skipped: Plan['skipped'] = [],
    routed = routedProjects(local, routes)
  return {
    lens: lensPlan(local, routed),
    workflow: new Map(
      [...routed.keys()].map((spaceId) => [spaceId, workflowSpacePlan(local, spaceId)]),
    ),
    ports: portPlan(local, activeSpaceId, routes, skipped),
    skipped,
  }
}

const catalogueRowCount = (value: object) =>
  Object.values(value).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0)
function logPlan(plan: Plan, presentation: Presentation, prefix = ''): void {
  const spaces = new Set([...plan.lens.keys(), ...plan.workflow.keys(), ...plan.ports.keys()])
  for (const spaceId of spaces) {
    presentation.log(
      `${prefix}space ${spaceId} — lens: ${catalogueRowCount(plan.lens.get(spaceId) ?? {})}; workflow: ${catalogueRowCount(plan.workflow.get(spaceId) ?? {})}; port: ${catalogueRowCount(plan.ports.get(spaceId) ?? {})}`,
    )
  }
  if (!plan.lens.size && !plan.ports.size)
    presentation.log(`${prefix}nothing to push for lens and port catalogues`)
  presentation.log(`${prefix}skipped: ${plan.skipped.length}`)
}

async function importWorkflowPlans(
  plans: Plan['workflow'],
  importCatalogue: NonNullable<RecordApiClient['importWorkflowCatalogue']>,
  presentation: Presentation,
): Promise<void> {
  for (const [spaceId, workflow] of plans) {
    const result = await importCatalogue(workflow, { destinationSpaceId: spaceId })
    for (const outcome of result.outcomes)
      presentation.log(`workflow ${spaceId} ${outcome.kind} ${outcome.slug}: ${outcome.outcome}`)
    presentation.log(
      `workflow ${spaceId}: inserted ${result.inserted}, already present ${result.alreadyPresent}, skipped ${result.skipped.length}`,
    )
  }
}

export async function pushCataloguesCommand(
  options: { dryRun: boolean },
  presentation: Presentation,
  dependencies: {
    local?: Database
    client?: RecordApiClient
    sync?: typeof syncRecord
  } = {},
): Promise<void> {
  const local = dependencies.local ?? db()
  const localActive = activeRecordSpace(local)
  if (options.dryRun) {
    if (!localActive) throw new Error(noActiveRecordSpaceRefusal())
    const plan = planCataloguePush(local, localActive, cachedProjectRoutes(local))
    logPlan(plan, presentation, 'dry run ')
    for (const skip of plan.skipped)
      presentation.log(`skipped ${skip.kind} ${skip.id}: ${skip.reason}`)
    return
  }
  const client = dependencies.client ?? recordApiClient()
  const identity = await client.whoami(),
    active = identity.activeSpaceId ?? localActive
  if (!active) throw new Error(noActiveRecordSpaceRefusal())
  const plan = planCataloguePush(local, active, currentProjectRoutes(local, identity, active))
  logPlan(plan, presentation)
  for (const skip of plan.skipped)
    presentation.log(`skipped ${skip.kind} ${skip.id}: ${skip.reason}`)
  if (!client.importLensCatalogue || !client.importWorkflowCatalogue || !client.importPortCatalogue)
    throw new Error(
      'record API does not support catalogue imports; deploy the matching record API, then retry',
    )
  for (const [spaceId, lens] of plan.lens) {
    const result = await client.importLensCatalogue(
      { ...lens, dryRun: options.dryRun },
      { destinationSpaceId: spaceId },
    )
    presentation.log(
      `lens ${spaceId}: inserted ${result.inserted}, already present ${result.alreadyPresent}, skipped ${result.skipped.length}`,
    )
  }
  await importWorkflowPlans(plan.workflow, client.importWorkflowCatalogue, presentation)
  for (const [spaceId, port] of plan.ports) {
    const result = await client.importPortCatalogue(
      { ...port, dryRun: options.dryRun },
      { destinationSpaceId: spaceId },
    )
    for (const skip of result.skipped) presentation.log(`skipped port ${skip.id}: ${skip.reason}`)
    presentation.log(
      `port ${spaceId}: inserted ${result.inserted}, already present ${result.alreadyPresent}, skipped ${result.skipped.length}`,
    )
  }
  if (!client.sync)
    throw new Error('record API does not support sync; deploy the matching record API, then retry')
  await (dependencies.sync ?? syncRecord)({
    local,
    client: client as RecordApiClient & {
      sync: NonNullable<RecordApiClient['sync']>
    },
  })
  if (dependencies.client) await pullRecordCache(local)
}
