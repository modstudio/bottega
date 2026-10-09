// concern: doc-canon-tree
/** Selects the repository tree used to validate a command-line document write. */
import { existsSync, realpathSync } from 'node:fs'
import { gitToplevel, mainCheckoutOf } from '../../../shared/git.ts'
import { type Project, projectByName, projects } from '../project/projects.ts'
import { type CanonWriteTree, docWriteProjectName } from './doc-write-allowed.ts'

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
 * Without --cwd, only canon needs an explicit selection because its write gate
 * consumes tree facts. With --cwd, every project-subject document uses that
 * checkout and refuses a tree belonging to another project.
 */
export function selectCanonWriteTree(input: {
  scope: string
  subject: string | null
  cwd?: string
}): SelectedCanonWriteTree | undefined {
  const projectName = docWriteProjectName(input.scope, input.subject)
  if (!projectName) {
    if (input.cwd) throw new Error('refusing --cwd: this document has no project')
    return undefined
  }
  const subjectProject = projectByName(projectName)
  if (!subjectProject) return undefined
  if (!input.cwd)
    return input.scope === 'canon'
      ? { project: subjectProject, root: subjectProject.path }
      : undefined
  if (!existsSync(input.cwd))
    throw new Error(
      `refusing --cwd ${input.cwd}: it is not a worktree of project ${subjectProject.name}`,
    )

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
        `refusing --cwd for project ${other.name}: document project is ${subjectProject.name}`,
      )
    }
  }
  throw new Error(
    `refusing --cwd ${input.cwd}: it is not a worktree of project ${subjectProject.name}`,
  )
}
