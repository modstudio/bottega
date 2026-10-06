// concern: doc-subjects
/** Lists and renders valid document subjects from the local register and static catalogues. */
import { DOC_SCOPE_SUBJECT_KIND, DOC_SCOPES, type DocScope } from '../../../shared/docs.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'

export function docSubjects(): {
  project: string[]
  stack: string[]
  agent: string[]
  job: string[]
} {
  return {
    project: (db().query('SELECT name FROM project ORDER BY name').all() as { name: string }[]).map(
      (row) => row.name,
    ),
    stack: (
      db()
        .query('SELECT DISTINCT stack FROM project WHERE stack IS NOT NULL ORDER BY stack')
        .all() as { stack: string }[]
    ).map((row) => row.stack),
    agent: Object.keys(AGENTS).sort(),
    job: Object.keys(JOBS).sort(),
  }
}

export function validDocSubjects(scope: DocScope): string {
  const subjectKind = DOC_SCOPE_SUBJECT_KIND[scope]
  if (subjectKind === null) return '(none)'
  const values =
    subjectKind === 'project'
      ? docSubjects().project
      : subjectKind === 'stack'
        ? docSubjects().stack
        : Object.keys(subjectKind === 'agent' ? AGENTS : JOBS).sort()
  return values.join(', ') || '(none)'
}

export function validateHistoricDocAddress(scope: string, slug: string): asserts scope is DocScope {
  if (!DOC_SCOPES.includes(scope as DocScope)) {
    throw new Error(`unknown doc scope "${scope}"; valid scopes: ${DOC_SCOPES.join(', ')}`)
  }
  if (scope === 'canon') {
    if (!slug || slug.startsWith('/') || slug.includes('..')) {
      throw new Error('invalid canon slug; use a repository-relative canon mirror path')
    }
    return
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug.length > 64) {
    throw new Error(
      'invalid slug; use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit',
    )
  }
}
