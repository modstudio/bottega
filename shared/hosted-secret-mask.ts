// concern: hosted-secret-mask
/** The single declaration and masking decision for hosted free-text writes. */
import { redactSecretShaped } from './secret-shaped.ts'

export const HOSTED_WRITE_SECRET_LEAVES = {
  'hub.note.create': ['text', 'area', 'anchor'],
  'hub.note.outside-create': ['text', 'area', 'anchor'],
  'hub.note.reap': ['stale.*.stale_reason', 'annotated.*.area', 'annotated.*.anchors'],
  'hub.note.mirror': ['notes.*.text', 'notes.*.area', 'notes.*.stale_reason', 'notes.*.anchors'],
  'hub.note.promote': ['title'],
  'hub.task.create': ['title', 'body'],
  'hub.task.document-create': ['title', 'body'],
  'hub.change.push': [
    '*.row.title',
    '*.row.body',
    '*.row.text',
    '*.row.area',
    '*.row.stale_reason',
    '*.row.anchors',
  ],
  'record.context-item.put': ['body', 'source', 'target'],
  'record.question.write': [
    'question.question',
    'question.answer',
    'question.answerBasis',
    'question.replacement',
    'question.overturnReason',
  ],
  'record.task-flow.write': ['texts.*.body', 'rows.*.body'],
  'record.workflow-version.write': [
    'definition',
    'author',
    'reason',
    'workflow_version.*.definition',
    'workflow_version.*.author',
    'workflow_version.*.reason',
  ],
  'record.doc.put': ['title', 'body'],
  'record.doc.import': ['doc.title', 'doc.body', 'revisions.*.title', 'revisions.*.body'],
  'record.doc.canon-import': ['rows.*.title', 'rows.*.body'],
} as const

export type HostedWriteRoute = keyof typeof HOSTED_WRITE_SECRET_LEAVES

/** Hosted routes known to accept declared free text; the guard keeps this table and leaves paired. */
export const HOSTED_FREE_TEXT_WRITE_ROUTES: readonly {
  method: 'POST' | 'PUT'
  path: string
  declaration: HostedWriteRoute
}[] = [
  { method: 'POST', path: '/v1/notes', declaration: 'hub.note.create' },
  { method: 'POST', path: '/v1/notes/outside', declaration: 'hub.note.outside-create' },
  { method: 'POST', path: '/v1/notes/:id/promote', declaration: 'hub.note.promote' },
  { method: 'POST', path: '/v1/notes/reap', declaration: 'hub.note.reap' },
  { method: 'PUT', path: '/v1/notes/mirror', declaration: 'hub.note.mirror' },
  { method: 'POST', path: '/v1/tasks', declaration: 'hub.task.create' },
  {
    method: 'POST',
    path: '/v1/tasks/:key/documents',
    declaration: 'hub.task.document-create',
  },
  { method: 'POST', path: '/v1/changes', declaration: 'hub.change.push' },
  { method: 'PUT', path: '/v1/context-items', declaration: 'record.context-item.put' },
  { method: 'POST', path: '/v1/questions/:intent', declaration: 'record.question.write' },
  { method: 'POST', path: '/v1/task-flow/:intent', declaration: 'record.task-flow.write' },
  {
    method: 'POST',
    path: '/v1/workflow-catalogue/draft',
    declaration: 'record.workflow-version.write',
  },
  {
    method: 'POST',
    path: '/v1/workflow-catalogue/import/v2',
    declaration: 'record.workflow-version.write',
  },
  { method: 'PUT', path: '/v1/docs', declaration: 'record.doc.put' },
  { method: 'POST', path: '/v1/docs/import', declaration: 'record.doc.import' },
  { method: 'POST', path: '/v1/docs/canon/import', declaration: 'record.doc.canon-import' },
]

const DECLARED_HOSTED_WRITE_ROUTES = new Set(
  HOSTED_FREE_TEXT_WRITE_ROUTES.map((route) => route.declaration),
)

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function maskAt(value: unknown, parts: readonly string[], index = 0): void {
  if (index >= parts.length) return
  const part = parts[index]!
  if (part === '*') {
    const children = Array.isArray(value) ? value : isObject(value) ? Object.values(value) : []
    for (const child of children) maskAt(child, parts, index + 1)
    return
  }
  if (!isObject(value)) return
  const child = value[part]
  if (index === parts.length - 1) {
    if (typeof child === 'string')
      value[part] = redactSecretShaped(child, {
        precision: 'high',
        exemptEvidenceTokens: true,
      }).text
    return
  }
  maskAt(child, parts, index + 1)
}

/** Clones a validated write value and masks only its route's declared high-precision leaves. */
export function maskHostedWrite<T>(route: HostedWriteRoute, value: T): T {
  if (!DECLARED_HOSTED_WRITE_ROUTES.has(route))
    throw new Error(`hosted free-text write route ${route} has no route declaration`)
  const masked = clone(value)
  for (const leaf of HOSTED_WRITE_SECRET_LEAVES[route]) maskAt(masked, leaf.split('.'))
  return masked
}
