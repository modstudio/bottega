// concern: doc-lint
/** Gathers registered checkout trees for the pure stored-document lint decision. */
import { existsSync } from 'node:fs'
import type { DocKind } from '../../../shared/docs.ts'
import { inspectionGitEnv } from '../../../shared/git.ts'
import { canonGitRoot, collectCanonLintInput } from '../canon/canon-files.ts'
import { type Project, projects } from '../project/projects.ts'
import {
  type DocLintFinding,
  type DocReferenceProject,
  docHasRepositoryReferences,
  docLintRefusal,
  introducedDocFindings,
  lintDoc,
} from './doc-lint.ts'
import type { CanonWriteTree } from './doc-write-allowed.ts'

type StoredDoc = {
  scope: string
  subject: string | null
  slug: string
  body: string
  kind: DocKind
}

const checkoutCache = new Map<string, DocReferenceProject['checkout']>()

export function storedDocsHaveRepositoryReferences(docs: Pick<StoredDoc, 'body'>[]): boolean {
  return docs.some((doc) => docHasRepositoryReferences(doc.body))
}

function targetProjects(
  doc: Pick<StoredDoc, 'scope' | 'subject'> & { owner?: string | null },
): Project[] {
  const registered = projects()
  if (doc.scope === 'canon') {
    if (doc.owner) return registered
    if (doc.subject) return registered.filter(({ name }) => name === doc.subject)
    return registered.filter(({ settings }) => settings.managedContext === true)
  }
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
  doc: Pick<StoredDoc, 'scope' | 'subject'> & { owner?: string | null },
  selectedTree?: CanonWriteTree,
): DocReferenceProject[] {
  return targetProjects(doc).map((project) => {
    const path = selectedTree?.project.name === project.name ? selectedTree.root : project.path
    if (!existsSync(path)) return { name: project.name, stack: project.stack, checkout: null }
    try {
      const root = canonGitRoot(path)
      const head = gitHead(root)
      const cacheKey = `${root}\0${head}`
      let checkout = checkoutCache.get(cacheKey)
      if (checkout === undefined) {
        checkout = collectCanonLintInput(root)
        checkoutCache.set(cacheKey, checkout)
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

export function storedDocLintRefusal(
  next: Omit<StoredDoc, 'kind'> & { kind?: StoredDoc['kind'] },
  current: StoredDoc | null,
): string | null {
  const doc = { ...next, kind: next.kind ?? current?.kind ?? 'working' }
  const findings = lintStoredDoc(doc)
  const introduced = current ? introducedDocFindings(lintStoredDoc(current), findings) : findings
  return docLintRefusal(doc, introduced)
}
