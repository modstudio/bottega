// concern: doc-canon-tree
/** Selects the repository tree used by command-line canon writes. */
import { existsSync, realpathSync } from 'node:fs'
import { gitToplevel, mainCheckoutOf } from '../../../shared/git.ts'
import { type Project, projectByName, projects } from '../project/projects.ts'
import type { CanonWriteTree } from './doc-write-allowed.ts'

export type SelectedCanonWriteTree = CanonWriteTree & { project: Project }

function repositoryIdentity(path: string): string | null {
  const main = mainCheckoutOf(path)
  if (!main) return null
  try {
    return realpathSync(main)
  } catch {
    return null
  }
}

/**
 * A cwd affects only project-subject canon. An unrelated or non-repository cwd
 * falls back to the registered checkout; another registered repository refuses.
 */
export function selectCanonWriteTree(input: {
  scope: string
  subject: string | null
  cwd?: string
}): SelectedCanonWriteTree | null {
  if (input.scope !== 'canon' || !input.subject) return null
  const subjectProject = projectByName(input.subject)
  if (!subjectProject) return null
  if (!input.cwd || !existsSync(input.cwd))
    return { project: subjectProject, root: subjectProject.path }

  const requestedIdentity = repositoryIdentity(input.cwd)
  const subjectIdentity = repositoryIdentity(subjectProject.path)
  if (requestedIdentity && subjectIdentity && requestedIdentity === subjectIdentity) {
    return { project: subjectProject, root: gitToplevel(input.cwd) ?? subjectProject.path }
  }

  if (requestedIdentity) {
    const other = projects().find(
      (project) =>
        project.name !== subjectProject.name &&
        repositoryIdentity(project.path) === requestedIdentity,
    )
    if (other) {
      throw new Error(
        `refusing --cwd for project ${other.name}: canon subject is project ${subjectProject.name}`,
      )
    }
  }
  return { project: subjectProject, root: subjectProject.path }
}
