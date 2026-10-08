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
export const DOC_AUDIENCES = ['user', 'technical'] as const
export type DocAudience = (typeof DOC_AUDIENCES)[number]
export const DOC_STATUSES = ['draft', 'current', 'superseded', 'archived'] as const
export type DocStatus = (typeof DOC_STATUSES)[number]
export const DOC_KINDS = ['working', 'article'] as const
export type DocKind = (typeof DOC_KINDS)[number]
export const DOC_SUMMARY_MAX_LENGTH = 160

/** Derive the short catalogue copy from the first prose paragraph in a markdown body. */
export function docSummary(body: string): string {
  const withoutFrontmatter = body.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '')
  const lines = withoutFrontmatter.split(/\r?\n/)
  let inFence = false
  const paragraphs: string[] = []
  let current: string[] = []
  const finish = () => {
    if (current.length) paragraphs.push(current.join(' '))
    current = []
  }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      finish()
      inFence = !inFence
      continue
    }
    if (inFence || /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)/.test(line)) {
      finish()
      continue
    }
    if (!line.trim()) {
      finish()
      continue
    }
    current.push(line.trim())
  }
  finish()
  const prose = paragraphs[0]
  if (!prose) return ''
  const plain = prose
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/\\([\\`*_{}[\]()#+.!>-])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= DOC_SUMMARY_MAX_LENGTH) return plain
  const cut = plain.slice(0, DOC_SUMMARY_MAX_LENGTH + 1)
  const boundary = cut.lastIndexOf(' ')
  return `${cut.slice(0, boundary > 0 ? boundary : DOC_SUMMARY_MAX_LENGTH).trimEnd()}…`
}
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
