// concern: doc-lint
/** Gathers registered checkout trees for the pure stored-document lint decision. */
import { existsSync } from 'node:fs'
import { canonGitRoot, collectCanonLintInput } from '../canon/canon-files.ts'
import { projects } from '../project/projects.ts'
import {
  type DocLintFinding,
  type DocReferenceProject,
  docHasRepositoryReferences,
  lintDoc,
} from './doc-lint.ts'

type StoredDoc = { scope: string; subject: string | null; slug: string; body: string }

export function storedDocsHaveRepositoryReferences(docs: Pick<StoredDoc, 'body'>[]): boolean {
  return docs.some((doc) => docHasRepositoryReferences(doc.body))
}

export function collectDocReferenceProjects(): DocReferenceProject[] {
  return projects().map((project) => ({
    name: project.name,
    stack: project.stack,
    checkout: existsSync(project.path) ? collectCanonLintInput(canonGitRoot(project.path)) : null,
  }))
}

export function lintStoredDoc(
  doc: StoredDoc,
  referenceProjects?: DocReferenceProject[],
): DocLintFinding[] {
  if (doc.scope === 'resume' || doc.scope === 'canon') return []
  return lintDoc({
    ...doc,
    ...(docHasRepositoryReferences(doc.body)
      ? { referenceProjects: referenceProjects ?? collectDocReferenceProjects() }
      : {}),
  })
}
