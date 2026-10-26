// concern: tracked recipe teardown main-stack lease
/** Starts the worktree stack for teardown and releases only services that invocation started. */

import { projectAt } from '../project/projects.ts'
import { ensureProjectMainStack, stopMainStackServices } from '../resources/main-stack.ts'
import type { Worktree } from '../worktree/worktree-types.ts'

export type TrackedTeardownMainStack = {
  project: ReturnType<typeof projectAt>
  startedServices: string[]
}

export function startTrackedTeardownMainStack(worktree: Worktree): TrackedTeardownMainStack {
  const project = projectAt(worktree.repoRoot)
  if (!project) return { project, startedServices: [] }
  try {
    // Teardown releases what worktree provisioning created, so it uses the same main-stack
    // declaration instead of requiring a second project setting.
    const startedServices = ensureProjectMainStack(project, 'worktree-create').startedServices
    return { project, startedServices }
  } catch (error) {
    throw new Error(
      `recipe teardown could not start its declared main stack: ${(error as Error).message}`,
    )
  }
}

export function stopTrackedTeardownMainStack(started: TrackedTeardownMainStack): {
  failure: string | null
  note: string | null
} {
  if (!started.project) return { failure: null, note: null }
  try {
    const stopped = stopMainStackServices({
      projectId: started.project.recordId,
      projectName: started.project.name,
      projectPath: started.project.path,
      consumer: 'worktree-create',
      startedServices: started.startedServices,
      ...(started.project.settings.mainStack?.worktreeComposeProjectPrefix !== undefined
        ? {
            worktreeComposeProjectPrefix:
              started.project.settings.mainStack.worktreeComposeProjectPrefix,
          }
        : {}),
    })
    return {
      failure: null,
      note: stopped.outcome === 'deferred' ? (stopped.detail ?? null) : null,
    }
  } catch (error) {
    return { failure: (error as Error).message, note: null }
  }
}
