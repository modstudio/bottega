// concern: doc-lint
/** Gathers registered checkout trees for the pure stored-document lint decision. */
import { existsSync } from 'node:fs'
import { inspectionGitEnv } from '../../../shared/git.ts'
import { canonGitRoot, collectCanonLintInput } from '../canon/canon-files.ts'
import { type Project, projects } from '../project/projects.ts'
import {
  type DocLintFinding,
  type DocReferenceProject,
  docHasRepositoryReferences,
  lintDoc,
} from './doc-lint.ts'

type StoredDoc = { scope: string; subject: string | null; slug: string; body: string }

const checkoutCache = new Map<string, DocReferenceProject['checkout']>()

export function storedDocsHaveRepositoryReferences(docs: Pick<StoredDoc, 'body'>[]): boolean {
  return docs.some((doc) => docHasRepositoryReferences(doc.body))
}

function targetProjects(doc: Pick<StoredDoc, 'scope' | 'subject'>): Project[] {
  const registered = projects()
  if (doc.scope === 'project') return registered.filter(({ name }) => name === doc.subject)
  if (doc.scope === 'stack') return registered.filter(({ stack }) => stack === doc.subject)
  return registered
}

function gitHead(root: string): string {
  const result = Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: inspectionGitEnv(),
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(detail || 'git rev-parse HEAD failed')
  }
  return result.stdout.toString().trim()
}

export function collectDocReferenceProjects(
  doc: Pick<StoredDoc, 'scope' | 'subject'>,
): DocReferenceProject[] {
  return targetProjects(doc).map((project) => {
    if (!existsSync(project.path))
      return { name: project.name, stack: project.stack, checkout: null }
    try {
      const root = canonGitRoot(project.path)
      const head = gitHead(root)
      let checkout = checkoutCache.get(head)
      if (checkout === undefined) {
        checkout = collectCanonLintInput(root)
        checkoutCache.set(head, checkout)
      }
      return { name: project.name, stack: project.stack, checkout }
    } catch (error) {
      return {
        name: project.name,
        stack: project.stack,
        checkout: null,
        unavailable: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

export function lintStoredDoc(
  doc: StoredDoc,
  referenceProjects?: DocReferenceProject[],
): DocLintFinding[] {
  if (doc.scope === 'resume' || doc.scope === 'canon') return []
  return lintDoc({
    ...doc,
    ...(docHasRepositoryReferences(doc.body)
      ? { referenceProjects: referenceProjects ?? collectDocReferenceProjects(doc) }
      : {}),
  })
}
