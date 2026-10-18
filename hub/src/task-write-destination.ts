import { resolveHostedUrl } from './hosted-url.ts'
import { declaredProjectSpace, projectWriteDecisionFor } from './hosted-write-mode.ts'
import { readInstallBinding } from './install-binding.ts'
import { projects } from './projects.ts'
import type { TaskFetch } from './task-client.ts'

export type HostedTaskWriteOptions = {
  baseUrl?: string
  token?: string | null
  fetch?: TaskFetch
}

export type TaskWriteMode = 'hosted-configured' | 'local-authoritative'

export function registeredTaskProject(name: string) {
  const project = projects().find((candidate) => candidate.name === name)
  if (!project) throw new Error(`unknown project '${name}'`)
  return project
}

export function hostedTaskWriteOptions(projectName: string, options?: HostedTaskWriteOptions) {
  const recordSpace = declaredProjectSpace(registeredTaskProject(projectName).settings.space)
  return recordSpace ? { ...options, recordSpace } : options
}

export function taskWriteMode(projectName: string, hosted?: HostedTaskWriteOptions): TaskWriteMode {
  const decision = projectWriteDecisionFor(
    registeredTaskProject(projectName),
    readInstallBinding(),
    hosted?.baseUrl ?? resolveHostedUrl(),
  )
  if (decision.mode === 'refused') throw new Error(decision.reason)
  return decision.mode
}
