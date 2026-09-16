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
] as const
export type DocScope = (typeof DOC_SCOPES)[number]

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
} as const satisfies Record<DocScope, DocSubjectKind | null>
