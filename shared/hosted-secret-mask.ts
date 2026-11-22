// concern: hosted-secret-mask
/** The single deny-list declaration and masking decision for hosted writes. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { PLATFORM_SLUG } from './brand.ts'
import { redactSecretShaped } from './secret-shaped.ts'

type Exclusion = { path: string; reason: string }
type RouteEntry = {
  kind: 'mask' | 'refuse' | 'no-free-text'
  method: 'POST' | 'PUT' | 'PATCH'
  path: string
  reason?: string
  declaration?: HostedWriteRoute
  exclusions?: readonly Exclusion[]
}

const timestamp = (path: string): Exclusion => ({ path, reason: 'validated timestamp' })
const enumValue = (path: string): Exclusion => ({ path, reason: 'validated enum or state' })
const slug = (path: string): Exclusion => ({ path, reason: 'validated identifier slug' })

/**
 * The only exceptions to recursive hosted masking. Defaults apply everywhere; each route-specific
 * structured string that does not follow the naming convention has a one-line reason here.
 */
const HOSTED_SECRET_EXCLUSIONS = {
  defaults: [
    { suffix: 'id', reason: 'identifier' },
    { suffix: 'key', reason: 'identifier or lookup key' },
    { suffix: 'hash', reason: 'integrity hash' },
    { suffix: 'sha', reason: 'integrity hash' },
    { suffix: 'digest', reason: 'integrity digest' },
    { suffix: 'revision', reason: 'optimistic-concurrency revision' },
    { suffix: 'tokens', reason: 'token count' },
    { suffix: 'tokenCount', reason: 'token count' },
  ],
  routes: {
    'hub.note.create': [slug('project'), enumValue('status')],
    'hub.note.outside-create': [slug('project')],
    'hub.note.reap': [timestamp('cutoff'), timestamp('stale.*.at')],
    'hub.note.mirror': [
      slug('notes.*.project'),
      enumValue('notes.*.status'),
      timestamp('notes.*.created_at'),
      timestamp('notes.*.updated_at'),
      timestamp('notes.*.deleted_at'),
    ],
    'hub.note.promote': [],
    'hub.task.create': [slug('project'), enumValue('status')],
    'hub.task.document-create': [],
    'hub.change.push': [
      enumValue('*.table'),
      enumValue('*.op'),
      timestamp('*.at'),
      slug('*.row.project'),
      enumValue('*.row.status'),
      timestamp('*.row.created_at'),
      timestamp('*.row.updated_at'),
      timestamp('*.row.deleted_at'),
    ],
    'record.context-item.put': [
      enumValue('holderKind'),
      slug('slug'),
      enumValue('kind'),
      { path: 'url', reason: 'service URL used as an identifier' },
    ],
    'record.sync': [
      timestamp('machine.seenAt'),
      enumValue('rows.*.kind'),
      slug('rows.*.spaceHint'),
    ],
    'record.question.write': [
      enumValue('question.kind'),
      enumValue('question.askedVia'),
      enumValue('question.answeredByKind'),
      enumValue('question.answererKind'),
      enumValue('question.answerChannel'),
      enumValue('question.filedAs'),
      enumValue('audit.action'),
      enumValue('audits.*.action'),
      timestamp('question.**.*At'),
      timestamp('audit.at'),
      timestamp('audits.*.at'),
    ],
    'record.task-flow.write': [
      enumValue('**.state'),
      slug('**.slug'),
      slug('**.workflow'),
      enumValue('**.mode'),
      enumValue('**.autonomy'),
      enumValue('**.enforcement'),
      timestamp('**.at'),
      timestamp('**.*At'),
    ],
    'record.workflow-version.write': [
      enumValue('kind'),
      slug('slug'),
      enumValue('event'),
      enumValue('status'),
      enumValue('**.event'),
      enumValue('**.status'),
      slug('**.slug'),
      timestamp('**.at'),
      timestamp('**.*At'),
    ],
    'record.doc.put': [
      enumValue('scope'),
      slug('subject'),
      slug('slug'),
      enumValue('delivery'),
      enumValue('status'),
      enumValue('kind'),
      enumValue('form'),
      enumValue('op'),
      enumValue('generator'),
      slug('projectName'),
      { path: 'sourceFiles.*', reason: 'source file path used as an identifier' },
      timestamp('at'),
    ],
    'record.doc.import': [
      enumValue('doc.scope'),
      slug('doc.subject'),
      slug('doc.slug'),
      enumValue('doc.delivery'),
      enumValue('doc.status'),
      enumValue('doc.kind'),
      enumValue('doc.form'),
      slug('doc.projectName'),
      { path: 'doc.sourceFiles.*', reason: 'source file path used as an identifier' },
      timestamp('doc.*At'),
      enumValue('revisions.*.scope'),
      slug('revisions.*.subject'),
      slug('revisions.*.slug'),
      enumValue('revisions.*.op'),
      enumValue('revisions.*.delivery'),
      enumValue('revisions.*.status'),
      enumValue('revisions.*.kind'),
      enumValue('revisions.*.form'),
      { path: 'revisions.*.sourceFiles.*', reason: 'source file path used as an identifier' },
      timestamp('revisions.*.at'),
    ],
    'record.doc.canon-import': [
      slug('rows.*.slug'),
      enumValue('address.kind'),
      slug('address.subject'),
    ],
  },
  tables: {
    hub_note: ['project_name', 'project', 'promoted_task', 'hidden_reason'],
    hub_task: [
      'project_name',
      'key',
      'project',
      'status',
      'status_category',
      'parent_key',
      'source',
    ],
    hub_task_comment: ['project_name', 'task_key', 'actor_user_id', 'run_id'],
    hub_task_document: ['project_name', 'task_key', 'role', 'version'],
    context_item: ['holder_kind', 'holder_id', 'slug', 'kind'],
    question: [
      'workflow_key',
      'workflow_step_slug',
      'asked_via',
      'kind',
      'answered_by_kind',
      'answerer_kind',
      'answer_channel',
      'filed_as',
      'filed_ref',
      'jev_model',
    ],
    workflow_step_text: ['step_slug'],
    workflow_text_copy: ['task_document_reference'],
    workflow_version: ['status'],
    workflow_event: ['event'],
    step_catalogue_version: ['status'],
    step_catalogue_event: ['event'],
    board_message: [
      'author_session',
      'author_harness',
      'kind',
      'purpose',
      'audience',
      'hidden_reason',
    ],
    board_message_tag: ['kind', 'origin'],
    doc: [
      'scope',
      'subject',
      'slug',
      'delivery',
      'audiences',
      'status',
      'kind',
      'form',
      'source_files',
      'checked_against_commit',
      'replacement_slug',
    ],
    doc_revision: [
      'scope',
      'subject',
      'slug',
      'op',
      'delivery',
      'audiences',
      'status',
      'kind',
      'form',
      'related_subject_ids',
      'source_files',
      'checked_against_commit',
      'replacement_slug',
    ],
  },
} as const

export type HostedWriteRoute = keyof typeof HOSTED_SECRET_EXCLUSIONS.routes

const recordWriteRoutes = `
POST /v1/catalogues/ensure-built-ins
POST /v1/config-access/grant
POST /v1/config-access/withdraw
POST /v1/config/data-keys
POST /v1/config/data-keys/:dekId/retire
POST /v1/config/data-keys/:dekId/wraps
POST /v1/config/join/nameplates
POST /v1/config/join/nameplates/:nameplate/failure
POST /v1/config/join/nameplates/:nameplate/messages
POST /v1/config/machine-keys/:keyId/claim
POST /v1/config/machine-keys/:keyId/claim-challenge
POST /v1/config/machine-keys/:keyId/revoke
POST /v1/config/trust-log
POST /v1/docs/:id/consume
POST /v1/docs/:id/restore
POST /v1/docs/canon/import
POST /v1/docs/import
POST /v1/docs/rename-subject
POST /v1/lens-catalogue/import
POST /v1/machine/retire
POST /v1/members/permission
POST /v1/moderation/hide
POST /v1/moderation/unhide
POST /v1/outside-blocks
POST /v1/outside-intake
POST /v1/outside-intake/pause
POST /v1/outside-intake/resume
POST /v1/port-catalogue/import
POST /v1/port-catalogue/write
POST /v1/projects/:id/purge
POST /v1/projects/:id/retire
POST /v1/questions/:intent
POST /v1/runs/:id/unvoid
POST /v1/runs/:id/void
POST /v1/settings/auto-mode
POST /v1/settings/permission
POST /v1/subjects/:id/define
POST /v1/subjects/:id/rename
POST /v1/subjects/:id/retire
POST /v1/subjects/reorder
POST /v1/sync
POST /v1/task-flow/abandon
POST /v1/task-flow/adopt
POST /v1/task-flow/advance
POST /v1/task-flow/attach-text
POST /v1/task-flow/await-ruling
POST /v1/task-flow/compose
POST /v1/task-flow/copy-text
POST /v1/task-flow/delete-text
POST /v1/task-flow/handoff
POST /v1/task-flow/import
POST /v1/task-flow/presence
POST /v1/task-flow/repin
POST /v1/task-flow/stage-summaries
POST /v1/task-flow/stage-update
POST /v1/workflow-catalogue/draft
POST /v1/workflow-catalogue/import/v2
POST /v1/workflow-catalogue/promote
POST /v1/workflow-catalogue/retire
PUT /v1/active-space
PUT /v1/config/credential-preferences
PUT /v1/config/entries/:key
PUT /v1/config/machine-keys/:keyId
PUT /v1/config/secrets/:key
PUT /v1/context-items
PUT /v1/docs
PUT /v1/docs/order
PUT /v1/lens-catalogue/lenses
PUT /v1/lens-catalogue/profiles
PUT /v1/lens-catalogue/selections
PUT /v1/machine/name
PUT /v1/projects
PUT /v1/runs/:id/score
PUT /v1/snapshots/:kind
PUT /v1/subjects`

const boardRefusalRoutes = `
POST /v1/board/messages/:id/replies
PUT /v1/board/messages`

const boardNoFreeTextRoutes = `
POST /v1/board/claims/:id/release
POST /v1/board/claims/:id/renew
POST /v1/board/claims/release-task
POST /v1/board/messages/:id/accept
POST /v1/board/messages/:id/filing-lease
POST /v1/board/messages/:id/filing-lease/complete
POST /v1/board/messages/:id/filing-lease/fail
POST /v1/board/messages/:id/withdraw
PUT /v1/board/claims
PUT /v1/board/receipts
PUT /v1/board/successor`

const route = (line: string, kind: RouteEntry['kind'], reason?: string): RouteEntry => {
  const [method, path] = line.trim().split(' ') as [RouteEntry['method'], string]
  return { method, path, kind, ...(reason ? { reason } : {}) }
}
const lines = (value: string) => value.trim().split('\n').filter(Boolean)

const targetDeclarations: Record<string, HostedWriteRoute> = {
  'POST /v1/sync': 'record.sync',
  'POST /v1/questions/:intent': 'record.question.write',
  'PUT /v1/context-items': 'record.context-item.put',
  'PUT /v1/docs': 'record.doc.put',
  'POST /v1/docs/import': 'record.doc.import',
  'POST /v1/docs/canon/import': 'record.doc.canon-import',
  'POST /v1/workflow-catalogue/draft': 'record.workflow-version.write',
  'POST /v1/workflow-catalogue/import/v2': 'record.workflow-version.write',
  'POST /v1/workflow-catalogue/promote': 'record.workflow-version.write',
  'POST /v1/workflow-catalogue/retire': 'record.workflow-version.write',
}

const recordEntries = lines(recordWriteRoutes).map((line) => {
  const entry = route(line, 'mask')
  const declaration = line.startsWith('POST /v1/task-flow/')
    ? 'record.task-flow.write'
    : targetDeclarations[line]
  return declaration ? { ...entry, declaration } : entry
})

const machineJoinMessageRoute = 'POST /v1/config/join/nameplates/:nameplate/messages'
const classifiedRecordEntries = recordEntries.map((entry) =>
  `${entry.method} ${entry.path}` === machineJoinMessageRoute
    ? {
        ...entry,
        kind: 'no-free-text' as const,
        declaration: undefined,
        reason: 'validated PAKE shares or authenticated ciphertext encoded as base64url',
      }
    : entry,
)

const hubEntries: RouteEntry[] = [
  { kind: 'mask', method: 'POST', path: '/v1/notes', declaration: 'hub.note.create' },
  {
    kind: 'mask',
    method: 'POST',
    path: '/v1/notes/outside',
    declaration: 'hub.note.outside-create',
  },
  { kind: 'mask', method: 'POST', path: '/v1/notes/:id/promote', declaration: 'hub.note.promote' },
  { kind: 'mask', method: 'POST', path: '/v1/notes/reap', declaration: 'hub.note.reap' },
  { kind: 'mask', method: 'PUT', path: '/v1/notes/mirror', declaration: 'hub.note.mirror' },
  { kind: 'mask', method: 'POST', path: '/v1/tasks', declaration: 'hub.task.create' },
  {
    kind: 'mask',
    method: 'POST',
    path: '/v1/tasks/:key/documents',
    declaration: 'hub.task.document-create',
  },
  { kind: 'mask', method: 'POST', path: '/v1/changes', declaration: 'hub.change.push' },
  {
    kind: 'no-free-text',
    method: 'POST',
    path: '/v1/tasks/lookup',
    reason: 'lookup identifiers only',
  },
  {
    kind: 'no-free-text',
    method: 'POST',
    path: '/v1/tasks/presence',
    reason: 'presence identifiers only',
  },
  { kind: 'mask', method: 'POST', path: '/v1/sends' },
  { kind: 'mask', method: 'PUT', path: '/v1/sends/mirror' },
  { kind: 'mask', method: 'POST', path: '/v1/report-subscriptions' },
  { kind: 'mask', method: 'PUT', path: '/v1/report-subscriptions/:id' },
  { kind: 'mask', method: 'POST', path: '/v1/operator-waiting-emails' },
  {
    kind: 'no-free-text',
    method: 'POST',
    path: '/v1/report-unsubscribe/:space/:token',
    reason: 'signed path identifiers and no body',
  },
  {
    kind: 'no-free-text',
    method: 'POST',
    path: '/unsubscribe/:space/:token',
    reason: 'signed path identifiers and no body',
  },
]

/** Fail-closed route inventory compared with both deployed apps by the gate. */
export const HOSTED_WRITE_ROUTE_ENTRIES: readonly RouteEntry[] = [
  ...classifiedRecordEntries,
  ...lines(boardRefusalRoutes).map((line) =>
    route(line, 'refuse', 'board secret policy refuses the request'),
  ),
  ...lines(boardNoFreeTextRoutes).map((line) =>
    route(line, 'no-free-text', 'identifiers, revisions, booleans, or timestamps only'),
  ),
  ...hubEntries,
]

type HostedMaskWarning = { path: string; rule: string }
const warnings = new AsyncLocalStorage<HostedMaskWarning[]>()

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function defaultExcluded(name: string): boolean {
  const parts = words(name),
    last = parts.at(-1)
  return (
    last === 'id' ||
    last === 'key' ||
    last === 'hash' ||
    last === 'sha' ||
    last === 'digest' ||
    last === 'revision' ||
    last === 'tokens' ||
    (last === 'count' && parts.at(-2) === 'token')
  )
}

function pathMatches(pattern: string, path: readonly string[]): boolean {
  const wanted = pattern.split('.')
  const visit = (wi: number, pi: number): boolean => {
    if (wi === wanted.length) return pi === path.length
    if (wanted[wi] === '**') return visit(wi + 1, pi) || (pi < path.length && visit(wi, pi + 1))
    if (pi === path.length) return false
    return (wanted[wi] === '*' || wanted[wi] === path[pi]) && visit(wi + 1, pi + 1)
  }
  return visit(0, 0)
}

function walk(value: unknown, path: string[], exclusions: readonly Exclusion[]): void {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) walk(child, [...path, String(index)], exclusions)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, name]
    if (typeof child !== 'string') {
      walk(child, childPath, exclusions)
      continue
    }
    const wildcardPath = childPath.map((part) => (/^\d+$/.test(part) ? '*' : part))
    if (defaultExcluded(name) || exclusions.some((entry) => pathMatches(entry.path, wildcardPath)))
      continue
    const result = redactSecretShaped(child, { precision: 'high', exemptEvidenceTokens: true })
    ;(value as Record<string, unknown>)[name] = result.text
    for (const rule of result.rules) warnings.getStore()?.push({ path: childPath.join('.'), rule })
  }
}

function maskSyncSerializedPayloads(value: unknown, exclusions: readonly Exclusion[]): void {
  if (!value || typeof value !== 'object') return
  const rows = (value as { rows?: unknown }).rows
  if (!Array.isArray(rows)) return
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object') continue
    const payload = (row as { payload?: unknown }).payload
    if (typeof payload !== 'string') continue
    try {
      const parsed = JSON.parse(payload) as unknown
      walk(parsed, ['rows', String(index), 'payload'], exclusions)
      ;(row as { payload: string }).payload = JSON.stringify(parsed)
    } catch {
      // The sync contract reports malformed serialized payloads after masking the string itself.
    }
  }
}

/** Clones a validated write value and masks every non-excluded string leaf. */
export function maskHostedWrite<T>(route: HostedWriteRoute, value: T): T {
  const masked = structuredClone(value)
  if (route === 'record.sync')
    maskSyncSerializedPayloads(masked, HOSTED_SECRET_EXCLUSIONS.routes[route])
  walk(masked, [], HOSTED_SECRET_EXCLUSIONS.routes[route])
  return masked
}

function routePathMatches(template: string, actual: string): boolean {
  const expected = template.split('/'),
    received = actual.split('/')
  return (
    expected.length === received.length &&
    expected.every((part, index) => part.startsWith(':') || part === received[index])
  )
}

/** Resolves the fail-closed policy row for one hosted route. */
export function hostedWriteRouteEntry(method: string, path: string): RouteEntry | undefined {
  return HOSTED_WRITE_ROUTE_ENTRIES.find(
    (candidate) => candidate.method === method && routePathMatches(candidate.path, path),
  )
}

/** Applies the fail-closed route declaration to a parsed request payload. */
export function maskHostedRoutePayload<T>(method: string, path: string, value: T): T {
  const entry = hostedWriteRouteEntry(method, path)
  if (!entry) throw new Error(`hosted write route ${method} ${path} has no secret policy entry`)
  if (entry.kind !== 'mask') return value
  if (entry.declaration) return maskHostedWrite(entry.declaration, value)
  const masked = structuredClone(value)
  walk(masked, [], entry.exclusions ?? [])
  return masked
}

/** Adds operator-visible, value-free warnings to a hosted write response. */
export async function withHostedMaskWarnings(run: () => Promise<Response>): Promise<Response> {
  const observed: HostedMaskWarning[] = []
  const response = await warnings.run(observed, run)
  if (!observed.length) return response
  const headers = new Headers(response.headers)
  headers.set(
    'warning',
    observed.map(({ path, rule }) => `299 ${PLATFORM_SLUG} "masked ${path} (${rule})"`).join(', '),
  )
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function isHostedAuditColumnExcluded(table: string, name: string): boolean {
  const explicit =
    HOSTED_SECRET_EXCLUSIONS.tables[table as keyof typeof HOSTED_SECRET_EXCLUSIONS.tables]
  return defaultExcluded(name) || Boolean(explicit?.includes(name as never))
}
