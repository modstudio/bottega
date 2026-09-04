import { dirname, resolve } from 'node:path'
import type { TrackerProject, TrackerSettings } from '../../shared/trackers.ts'

export type { StatusCategory, TrackerSettings } from '../../shared/trackers.ts'

export type Project = string

export type RegisteredProject = TrackerProject & {
  id: number
  name: Project
  path: string
  stack: string | null
  canon: boolean
  settings: {
    color?: string
    colorDark?: string
    envPrefix?: string
    keyPrefixes?: string[]
    tracker?: TrackerSettings
    [key: string]: unknown
  }
}

const ORCH = process.env.HUB_ORCH ?? new URL('../../bin/orch', import.meta.url).pathname
let cache: RegisteredProject[] | null = null

/** Forget the register after an orchestrator write so the next read sees it. */
export function refreshProjects(): void {
  cache = null
}

/** The project register published by orchestrator, read once per process. */
export function projects(): RegisteredProject[] {
  if (cache) return cache
  const proc = Bun.spawnSync([ORCH, 'project', 'list', '--json'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  const stdout = new TextDecoder().decode(proc.stdout)
  const stderr = new TextDecoder().decode(proc.stderr).trim()
  if (proc.exitCode !== 0) throw new Error(`could not read project register: ${stderr}`)
  let value: unknown
  try { value = JSON.parse(stdout) }
  catch (error) { throw new Error(`invalid project register JSON: ${String(error)}`) }
  if (!Array.isArray(value)) throw new Error('invalid project register: expected an array')
  cache = value as RegisteredProject[]
  return cache
}

export const projectNames = () => projects().map((project) => project.name)

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
