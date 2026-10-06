/**
 * Operator document scopes and how each scope is addressed.
 *
 * The scope list is shared by the orchestrator schema and validation, hub's
 * tRPC boundary, and hub's Docs view. Keeping the subject kind beside it makes
 * the other half of a document address change with the scope instead of
 * drifting independently.
 */
export const DOC_SCOPES = [
  'project',
  'machine',
  'agent',
  'job',
  'global',
  'stack',
  'resume',
  'canon',
  'settings',
] as const
export type DocScope = (typeof DOC_SCOPES)[number]
export const FILING_DOC_SCOPES = DOC_SCOPES.filter(
  (scope): scope is Exclude<DocScope, 'canon' | 'settings'> =>
    scope !== 'canon' && scope !== 'settings',
) as [Exclude<DocScope, 'canon' | 'settings'>, ...Exclude<DocScope, 'canon' | 'settings'>[]]
export type FilingDocScope = (typeof FILING_DOC_SCOPES)[number]

export type DocSubjectKind = 'project' | 'stack' | 'agent' | 'job'

export const DOC_SCOPE_SUBJECT_KIND = {
  project: 'project',
  machine: null,
  agent: 'agent',
  job: 'job',
  global: null,
  stack: 'stack',
  resume: 'project',
  canon: 'project',
  settings: 'project',
} as const satisfies Record<DocScope, DocSubjectKind | null>

export function docScopeHasProjectSubject(scope: string): boolean {
  return DOC_SCOPE_SUBJECT_KIND[scope as DocScope] === 'project'
}

export function resolveDocSubject(
  scope: DocScope,
  explicit: string | undefined,
  fallback: string | null,
): string | null {
  const kind = DOC_SCOPE_SUBJECT_KIND[scope]
  if (kind === null) {
    if (explicit !== undefined) throw new Error(`${scope} docs take no subject; remove --subject`)
    return null
  }
  const subject = explicit ?? fallback
  if (!subject) throw new Error(`${scope} docs require --subject`)
  return subject
}

export const DOC_SCOPE_ALLOWS_OWNER = {
  project: false,
  machine: false,
  agent: false,
  job: false,
  global: false,
  stack: false,
  resume: false,
  canon: true,
  settings: true,
} as const satisfies Record<DocScope, boolean>
