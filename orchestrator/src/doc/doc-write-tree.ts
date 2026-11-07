// concern: doc-write-tree
/** Selects the repository tree used to validate a command-line document write. */
import { existsSync, realpathSync } from 'node:fs'
import { gitToplevel, mainCheckoutOf } from '../../../shared/git.ts'
import { type Project, projectByName, projects } from '../project/projects.ts'
import { type CanonWriteTree, docWriteProjectName } from './doc-write-allowed.ts'

export type SelectedDocWriteTree = CanonWriteTree & { project: Project }

export function decideDocWriteTree(input: {
  shellCheckout: { repositoryIdentity: string | null; toplevel: string | null }
  subjectProject: { repositoryIdentity: string | null; registeredCheckout: string }
}): string {
  const { shellCheckout, subjectProject } = input
  return shellCheckout.toplevel &&
    shellCheckout.repositoryIdentity &&
    subjectProject.repositoryIdentity &&
    shellCheckout.repositoryIdentity === subjectProject.repositoryIdentity
    ? shellCheckout.toplevel
    : subjectProject.registeredCheckout
}

export async function withDocWriteTreeRemedy<T>(
  tree: SelectedDocWriteTree | undefined,
  cwdParameter: '--cwd' | 'cwd',
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (
      tree &&
      error instanceof Error &&
      (error.message.startsWith('refusing canon write;') ||
        error.message.startsWith('refusing canon removal;'))
    ) {
      throw new Error(
        `${error.message}; judged against ${tree.root}; pass ${cwdParameter} <checkout> to validate against another checkout of ${tree.project.name}`,
      )
    }
    throw error
  }
}

function repositoryIdentity(path: string): string | null {
  const main = mainCheckoutOf(path)
  if (!main) return null
  try {
    return realpathSync(main)
  } catch {
    return null
  }
}

function registeredRepositoryIdentity(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * Without --cwd, only canon needs an explicit selection because its write gate
 * consumes tree facts. With --cwd, every project-subject document uses that
 * checkout and refuses a tree belonging to another project.
 */
export function selectDocWriteTree(input: {
  scope: string
  subject: string | null
  cwd?: string
  shellCwd?: string
}): SelectedDocWriteTree | undefined {
  const projectName = docWriteProjectName(input.scope, input.subject)
  if (!projectName) {
    if (input.cwd) throw new Error('refusing --cwd: this document has no project')
    return undefined
  }
  const subjectProject = projectByName(projectName)
  if (!subjectProject) return undefined
  if (!input.cwd) {
    if (input.scope !== 'canon') return undefined
    const shellCwd = input.shellCwd ?? process.cwd()
    let shellCheckout: { repositoryIdentity: string | null; toplevel: string | null }
    try {
      shellCheckout = {
        repositoryIdentity: repositoryIdentity(shellCwd),
        toplevel: gitToplevel(shellCwd),
      }
    } catch {
      shellCheckout = { repositoryIdentity: null, toplevel: null }
    }
    return {
      project: subjectProject,
      root: decideDocWriteTree({
        shellCheckout,
        subjectProject: {
          repositoryIdentity: registeredRepositoryIdentity(subjectProject.path),
          registeredCheckout: subjectProject.path,
        },
      }),
    }
  }
  if (!existsSync(input.cwd))
    throw new Error(
      `refusing --cwd ${input.cwd}: it is not a worktree of project ${subjectProject.name}`,
    )

  const requestedIdentity = repositoryIdentity(input.cwd)
  const subjectIdentity = registeredRepositoryIdentity(subjectProject.path)
  if (requestedIdentity && subjectIdentity && requestedIdentity === subjectIdentity) {
    return { project: subjectProject, root: gitToplevel(input.cwd) ?? subjectProject.path }
  }

  if (requestedIdentity) {
    const other = projects().find(
      (project) =>
        project.name !== subjectProject.name &&
        registeredRepositoryIdentity(project.path) === requestedIdentity,
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
