import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { replicatedRecordId } from '../../../shared/record-id.ts'
import { activeRecordSpace, cachedProjectSpaces } from '../project-space.ts'
import { readRecordInstallBinding } from '../record/install-binding.ts'

function composingSpaces(d: Database): string[] {
  const values = new Set<string>()
  const active = activeRecordSpace(d)
  if (active) values.add(active)
  for (const value of Object.values(cachedProjectSpaces(d))) if (value) values.add(value)
  return [...values]
}

export function workflowUuidReferenceOrphanCounts(d: Database): string[] {
  const checks = [
    ['workflow_version.workflow_id', 'workflow_version', 'workflow_id', 'workflow', 'id'],
    [
      'workflow_event.workflow_version_record_id',
      'workflow_event',
      'workflow_id',
      'workflow',
      'id',
    ],
    [
      'step_catalogue_version.catalogue_id',
      'step_catalogue_version',
      'catalogue_id',
      'step_catalogue',
      'id',
    ],
    [
      'step_catalogue_event.catalogue_version_record_id',
      'step_catalogue_event',
      'catalogue_id',
      'step_catalogue',
      'id',
    ],
    ['workflow_obligation.cursor_id', 'workflow_obligation', 'cursor_id', 'workflow_cursor', 'id'],
    ['workflow_step_text.cursor_id', 'workflow_step_text', 'cursor_id', 'workflow_cursor', 'id'],
  ] as const
  const findings = checks.flatMap(([label, child, column, parent, key]) => {
    const n = (
      d
        .query(
          `SELECT COUNT(*) n FROM ${child} c WHERE NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.${key}=c.${column})`,
        )
        .get() as { n: number }
    ).n
    return n ? [`${label}=${n}`] : []
  })
  for (const [label, sql] of [
    [
      'workflow_event.workflow_version_record_id',
      'SELECT COUNT(*) n FROM workflow_event e WHERE NOT EXISTS (SELECT 1 FROM workflow_version v WHERE v.workflow_id=e.workflow_id AND v.n=e.version_n)',
    ],
    [
      'step_catalogue_event.catalogue_version_record_id',
      'SELECT COUNT(*) n FROM step_catalogue_event e WHERE NOT EXISTS (SELECT 1 FROM step_catalogue_version v WHERE v.catalogue_id=e.catalogue_id AND v.n=e.version_n)',
    ],
    [
      'workflow_cursor.workflow_version_record_id',
      'SELECT COUNT(*) n FROM workflow_cursor c WHERE NOT EXISTS (SELECT 1 FROM workflow w JOIN workflow_version v ON v.workflow_id=w.id WHERE w.slug=c.workflow_slug AND v.n=c.workflow_version)',
    ],
    [
      'workflow_cursor.catalogue_version_record_id',
      "SELECT COUNT(*) n FROM workflow_cursor c WHERE NOT EXISTS (SELECT 1 FROM step_catalogue s JOIN step_catalogue_version v ON v.catalogue_id=s.id WHERE s.slug='shared' AND v.n=c.catalogue_version)",
    ],
    [
      'question.workflow_cursor_id',
      'SELECT COUNT(*) n FROM question q WHERE q.workflow_cursor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workflow_cursor c WHERE c.id=q.workflow_cursor_id)',
    ],
    [
      'operator_notification.item_id',
      "SELECT COUNT(*) n FROM operator_notification n WHERE n.kind='workflow' AND NOT EXISTS (SELECT 1 FROM workflow_cursor c WHERE c.id=n.item_id)",
    ],
  ] as const) {
    const n = (d.query(sql).get() as { n: number }).n
    if (n) findings.push(`${label}=${n}`)
  }
  return [...new Set(findings)]
}

type StaleCopyPreflight = { conflicts: string[]; supersededEvents: string[] }

const STALE_COPY_CONFIGS = [
  {
    owner: 'workflow',
    version: 'workflow_version',
    event: 'workflow_event',
    foreign: 'workflow_id',
    kind: 'workflow',
  },
  {
    owner: 'step_catalogue',
    version: 'step_catalogue_version',
    event: 'step_catalogue_event',
    foreign: 'catalogue_id',
    kind: 'step_catalogue',
  },
] as const

type StaleCopyConfig = (typeof STALE_COPY_CONFIGS)[number]

type LegacyVersionRow = {
  owner_id: number
  record_id: string
  slug: string
  version_record_id: string
  n: number
  definition: string
  status: 'draft' | 'production' | 'retired'
  author: string
  reason: string
  created_at: string
  promoted_at: string | null
  retired_at: string | null
}

const VERSION_CONTENT_FIELDS = ['n', 'definition', 'reason'] as const

const STATUS_ORDER: Record<LegacyVersionRow['status'], number> = {
  draft: 0,
  production: 1,
  retired: 2,
}

function differingVersionFields(local: LegacyVersionRow, hosted: LegacyVersionRow): string[] {
  const differences: string[] = VERSION_CONTENT_FIELDS.filter(
    (field) => local[field] !== hosted[field],
  )
  if (STATUS_ORDER[local.status] > STATUS_ORDER[hosted.status]) differences.push('status-ahead')
  return differences
}

function legacyVersions(d: Database, config: StaleCopyConfig): LegacyVersionRow[] {
  return d
    .query<LegacyVersionRow, []>(
      `SELECT o.id owner_id,o.record_id,o.slug,v.record_id version_record_id,v.n,v.definition,
              v.status,v.author,v.reason,v.created_at,v.promoted_at,v.retired_at
         FROM ${config.owner} o JOIN ${config.version} v ON v.${config.foreign}=o.id
        WHERE o.space_id IS NULL ORDER BY o.slug,v.n`,
    )
    .all()
}

function hostedVersion(
  d: Database,
  config: StaleCopyConfig,
  where: string,
  values: [string, string, string] | [string, string, number],
): LegacyVersionRow | null {
  return d
    .query<LegacyVersionRow, typeof values>(
      `SELECT h.id owner_id,h.record_id,h.slug,hv.record_id version_record_id,hv.n,hv.definition,
              hv.status,hv.author,hv.reason,hv.created_at,hv.promoted_at,hv.retired_at
         FROM ${config.owner} h JOIN ${config.version} hv ON hv.${config.foreign}=h.id
        WHERE h.space_id=? AND ${where}`,
    )
    .get(...values)
}

function unmatchedDerivedEvent(
  d: Database,
  config: StaleCopyConfig,
  local: LegacyVersionRow,
  hosted: LegacyVersionRow,
  space: string,
): string | null {
  const events = d
    .query<{ record_id: string; event: string }, [number, number]>(
      `SELECT record_id,event FROM ${config.event} WHERE ${config.foreign}=? AND version_n=? AND space_id IS NULL ORDER BY record_id`,
    )
    .all(local.owner_id, local.n)
  return (
    events.find(
      ({ event }) =>
        !d
          .query(
            `SELECT 1 FROM ${config.event} WHERE ${config.foreign}=? AND version_n=? AND event=? AND space_id=?`,
          )
          .get(hosted.owner_id, hosted.n, event, space),
    )?.record_id ?? null
  )
}

function supersededEventReport(
  d: Database,
  config: StaleCopyConfig,
  row: LegacyVersionRow,
): string {
  const eventCount = d
    .query<{ n: number }, [number, number]>(
      `SELECT COUNT(*) n FROM ${config.event} WHERE ${config.foreign}=? AND version_n=? AND space_id IS NULL`,
    )
    .get(row.owner_id, row.n)!.n
  return `${config.version}:${row.slug}@${row.n}:${row.version_record_id} supersedes ${eventCount} NULL-space event${eventCount === 1 ? '' : 's'}`
}

type SpaceMatch =
  | { kind: 'matched'; report?: string }
  | { kind: 'different'; fields: string[] }
  | { kind: 'conflict'; value: string }
  | { kind: 'none' }

function matchVersionInSpace(
  d: Database,
  config: StaleCopyConfig,
  row: LegacyVersionRow,
  space: string,
): SpaceMatch {
  const derived = hostedVersion(d, config, 'h.record_id=? AND hv.record_id=?', [
    space,
    replicatedRecordId(space, config.kind, row.record_id),
    replicatedRecordId(space, `${config.kind}_version`, row.version_record_id),
  ])
  if (derived) {
    const fields = [
      ...(derived.slug !== row.slug ? ['slug'] : []),
      ...differingVersionFields(row, derived),
    ]
    if (fields.length) return { kind: 'different', fields }
    const event = unmatchedDerivedEvent(d, config, row, derived, space)
    return event
      ? { kind: 'conflict', value: `${config.event}:${row.slug}@${row.n}:${event}` }
      : { kind: 'matched' }
  }

  const content = hostedVersion(d, config, 'h.slug=? AND hv.n=?', [space, row.slug, row.n])
  if (!content) return { kind: 'none' }
  const fields = differingVersionFields(row, content)
  return fields.length
    ? { kind: 'different', fields }
    : { kind: 'matched', report: supersededEventReport(d, config, row) }
}

function routedVersionConflict(
  d: Database,
  cursorNumber: number,
  config: StaleCopyConfig,
  slug: string,
  n: number,
  space: string,
): string | null {
  const prefix = `workflow_cursor:${cursorNumber}`
  const legacy = legacyVersions(d, config).find((row) => row.slug === slug && row.n === n)
  if (!legacy) {
    const present = hostedVersion(d, config, 'h.slug=? AND hv.n=?', [space, slug, n])
    return present ? null : prefix
  }
  const result = matchVersionInSpace(d, config, legacy, space)
  if (result.kind === 'matched') return null
  if (result.kind === 'different')
    return `${prefix} ${config.version} differs in ${[...result.fields].sort().join(',')}`
  if (result.kind === 'conflict') return `${prefix} ${result.value}`
  return prefix
}

function workflowCursorResolutionConflicts(d: Database): string[] {
  if (!readRecordInstallBinding(d).bound) return []
  const routes = cachedProjectSpaces(d)
  return d
    .query<
      {
        number: number
        project: string
        workflow_slug: string
        workflow_version: number
        catalogue_version: number
      },
      []
    >(
      'SELECT id number,project,workflow_slug,workflow_version,catalogue_version FROM workflow_cursor ORDER BY id',
    )
    .all()
    .flatMap((cursor) => {
      const space = routes[cursor.project]
      if (typeof space !== 'string') return [`workflow_cursor:${cursor.number}`]
      return [
        routedVersionConflict(
          d,
          cursor.number,
          STALE_COPY_CONFIGS[0],
          cursor.workflow_slug,
          cursor.workflow_version,
          space,
        ),
        routedVersionConflict(
          d,
          cursor.number,
          STALE_COPY_CONFIGS[1],
          'shared',
          cursor.catalogue_version,
          space,
        ),
      ].filter((conflict): conflict is string => conflict !== null)
    })
}

function preflightVersion(
  d: Database,
  config: StaleCopyConfig,
  row: LegacyVersionRow,
  spaces: readonly string[],
): { conflict?: string; report?: string } {
  const differences = new Set<string>()
  for (const space of spaces) {
    const result = matchVersionInSpace(d, config, row, space)
    if (result.kind === 'matched') return { report: result.report }
    if (result.kind === 'conflict') return { conflict: result.value }
    if (result.kind === 'different') for (const field of result.fields) differences.add(field)
  }
  const suffix = differences.size ? ` differs in ${[...differences].sort().join(',')}` : ''
  return { conflict: `${config.version}:${row.slug}@${row.n}:${row.version_record_id}${suffix}` }
}

export function workflowStaleCopyPreflight(d: Database): StaleCopyPreflight {
  if (!readRecordInstallBinding(d).bound) return { conflicts: [], supersededEvents: [] }
  const spaces = composingSpaces(d)
  const conflicts: string[] = []
  const supersededEvents: string[] = []
  for (const config of STALE_COPY_CONFIGS) {
    for (const row of legacyVersions(d, config)) {
      const result = preflightVersion(d, config, row, spaces)
      if (result.conflict) conflicts.push(result.conflict)
      if (result.report) supersededEvents.push(result.report)
    }
  }
  return { conflicts, supersededEvents }
}

type StoredEvidence = { value?: unknown }
type StoredClosedStep = {
  evidence?: unknown
  deferred?: unknown
  satisfied?: unknown
}

function integerReference(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

function evidenceAttachmentIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const reference = (item as StoredEvidence).value
    if (typeof reference !== 'string') return []
    const match = /^attached-text:(\d+)$/.exec(reference)
    return match ? [Number(match[1])] : []
  })
}

function rewriteEvidence(value: unknown, textIds: ReadonlyMap<number, string>): unknown {
  if (!Array.isArray(value)) return value
  return value.map((item) => {
    if (!item || typeof item !== 'object') return item
    const evidence = item as StoredEvidence
    if (typeof evidence.value !== 'string') return item
    const match = /^attached-text:(\d+)$/.exec(evidence.value)
    if (!match) return item
    return { ...evidence, value: `attached-text:${textIds.get(Number(match[1]))!}` }
  })
}

function structuredObligationIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const step = item as StoredClosedStep
    const deferred =
      step.deferred && typeof step.deferred === 'object'
        ? integerReference((step.deferred as { id?: unknown }).id)
        : null
    const satisfied = integerReference(step.satisfied)
    return [deferred, satisfied].filter((id): id is number => id !== null)
  })
}

function rewriteClosedSteps(
  value: unknown,
  textIds: ReadonlyMap<number, string>,
  obligationIds: ReadonlyMap<number, string>,
): unknown {
  if (!Array.isArray(value)) return value
  return value.map((item) => {
    if (!item || typeof item !== 'object') return item
    const step = item as StoredClosedStep
    const deferred =
      step.deferred && typeof step.deferred === 'object'
        ? (step.deferred as Record<string, unknown>)
        : null
    const deferredId = integerReference(deferred?.id)
    const satisfiedId = integerReference(step.satisfied)
    return {
      ...step,
      ...(step.evidence === undefined ? {} : { evidence: rewriteEvidence(step.evidence, textIds) }),
      ...(deferredId === null
        ? {}
        : { deferred: { ...deferred, id: obligationIds.get(deferredId)! } }),
      ...(satisfiedId === null ? {} : { satisfied: obligationIds.get(satisfiedId)! }),
    }
  })
}

function workflowAttachmentReferenceConflicts(d: Database): string[] {
  const known = new Set(
    d
      .query<{ id: number }, []>('SELECT id FROM workflow_step_text')
      .all()
      .map((row) => row.id),
  )
  const knownObligations = new Set(
    d
      .query<{ id: number }, []>('SELECT id FROM workflow_obligation')
      .all()
      .map((row) => row.id),
  )
  const cursorConflicts = d
    .query<{ id: number; closed: string }, []>('SELECT id,closed FROM workflow_cursor ORDER BY id')
    .all()
    .flatMap((cursor) => {
      const parsed = JSON.parse(cursor.closed) as unknown
      const ids = Array.isArray(parsed)
        ? parsed.flatMap((item) =>
            item && typeof item === 'object'
              ? evidenceAttachmentIds((item as StoredClosedStep).evidence)
              : [],
          )
        : []
      const obligations = structuredObligationIds(parsed)
      return ids.some((id) => !known.has(id)) || obligations.some((id) => !knownObligations.has(id))
        ? [`workflow_cursor:${cursor.id}`]
        : []
    })
  const obligationConflicts = d
    .query<{ cursor_id: number; satisfied_evidence: string }, []>(
      'SELECT cursor_id,satisfied_evidence FROM workflow_obligation WHERE satisfied_evidence IS NOT NULL ORDER BY cursor_id',
    )
    .all()
    .flatMap((obligation) => {
      const ids = evidenceAttachmentIds(JSON.parse(obligation.satisfied_evidence) as unknown)
      return ids.some((id) => !known.has(id)) ? [`workflow_cursor:${obligation.cursor_id}`] : []
    })
  return [...new Set([...cursorConflicts, ...obligationConflicts])]
}

function rewriteWorkflowAttachmentReferences(d: Database): void {
  const ids = new Map(
    d
      .query<{ id: number; record_id: string }, []>('SELECT id,record_id FROM workflow_step_text')
      .all()
      .map((row) => [row.id, row.record_id]),
  )
  const obligationIds = new Map(
    d
      .query<{ id: number; record_id: string }, []>('SELECT id,record_id FROM workflow_obligation')
      .all()
      .map((row) => [row.id, row.record_id]),
  )
  for (const cursor of d
    .query<{ id: number; closed: string }, []>('SELECT id,closed FROM workflow_cursor')
    .all()) {
    const parsed = JSON.parse(cursor.closed) as unknown
    const rewritten = JSON.stringify(rewriteClosedSteps(parsed, ids, obligationIds))
    if (rewritten !== cursor.closed)
      d.query('UPDATE workflow_cursor SET closed=? WHERE id=?').run(rewritten, cursor.id)
  }
  for (const obligation of d
    .query<{ id: number; satisfied_evidence: string }, []>(
      'SELECT id,satisfied_evidence FROM workflow_obligation WHERE satisfied_evidence IS NOT NULL',
    )
    .all()) {
    const parsed = JSON.parse(obligation.satisfied_evidence) as unknown
    const rewritten = JSON.stringify(rewriteEvidence(parsed, ids))
    if (rewritten !== obligation.satisfied_evidence)
      d.query('UPDATE workflow_obligation SET satisfied_evidence=? WHERE id=?').run(
        rewritten,
        obligation.id,
      )
  }
}

export function prepareWorkflowUuidMigration(d: Database): void {
  const staleCopyPreflight = workflowStaleCopyPreflight(d)
  if (staleCopyPreflight.conflicts.length) {
    throw new Error(
      `refusing workflow UUID-key migration: bound store has NULL-space workflow rows without equivalent hosted twins (${staleCopyPreflight.conflicts.join(', ')})\n` +
        `cleared by: reconcile the named rows with the hosted record, then run \`${PLATFORM_SLUG} machine migrate\``,
    )
  }
  const cursorResolutionConflicts = workflowCursorResolutionConflicts(d)
  if (cursorResolutionConflicts.length)
    throw new Error(
      `refusing workflow UUID-key migration: cursors would not resolve after NULL-space deletion (${cursorResolutionConflicts.join(', ')})\n` +
        `cleared by: restore the named cursor's project route and hosted workflow rows, then run \`${PLATFORM_SLUG} machine migrate\``,
    )
  for (const report of staleCopyPreflight.supersededEvents)
    console.error(`workflow UUID migration: ${report}`)
  const referenceConflicts = workflowAttachmentReferenceConflicts(d)
  if (referenceConflicts.length)
    throw new Error(
      `refusing workflow UUID-key migration: structured workflow evidence names missing rows (${referenceConflicts.join(', ')})\n` +
        `cleared by: restore or remove the named cursor's structured reference, then run \`${PLATFORM_SLUG} machine migrate\``,
    )
  rewriteWorkflowAttachmentReferences(d)
}
