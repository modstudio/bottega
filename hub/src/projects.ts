import { dirname, resolve } from 'node:path'
import { trackerSourceFor, type TrackerProject } from '../../shared/trackers.ts'
import { projectList, type OrchProject } from './orch.ts'

export type { StatusCategory, TrackerSettings } from '../../shared/trackers.ts'

export type Project = string

export type RegisteredProject = OrchProject & TrackerProject

let cache: RegisteredProject[] | null = null

/** Forget the register after an orchestrator write so the next read sees it. */
export function refreshProjects(): void {
  cache = null
}

/** The project register published by orchestrator, read once per process. */
export function projects(): RegisteredProject[] {
  if (cache) return cache
  cache = projectList()
  return cache
}

export const projectNames = () => projects().map((project) => project.name)

export type TrackerPresentation = {
  state: 'not-configured' | 'configured' | 'unusable'
  label: string
  error: string | null
}

/** Describe whether the register row can actually produce a tracker source. */
export function trackerPresentation(project: TrackerProject): TrackerPresentation {
  const tracker = project.settings.tracker
  if (!tracker) return { state: 'not-configured', label: 'none', error: null }
  try {
    trackerSourceFor(project)
    const kind = tracker.kind || tracker.protocol || 'configured'
    const label =
      tracker.kind && tracker.protocol && tracker.kind !== tracker.protocol
        ? `${tracker.kind} (${tracker.protocol})`
        : kind
    return { state: 'configured', label, error: null }
  } catch (cause) {
    return {
      state: 'unusable',
      label: tracker.kind || tracker.protocol || 'tracker',
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/** The common parent of every main checkout, for numbered-clone attribution. */
export function projectRoot(): string | null {
  const overridden = process.env.HUB_PROJECT_ROOT
  if (overridden) return resolve(overridden)
  const paths = projects().map((project) => resolve(project.path))
  if (!paths.length) return null
  let parent = dirname(paths[0]!)
  while (!paths.every((path) => path === parent || path.startsWith(parent + '/'))) {
    const next = dirname(parent)
    if (next === parent) return parent
    parent = next
  }
  return parent
}

export function projectColor(project: Project, dark = false): string | null {
  const settings = projects().find((candidate) => candidate.name === project)?.settings
  return (dark ? settings?.colorDark : settings?.color) ?? null
}
