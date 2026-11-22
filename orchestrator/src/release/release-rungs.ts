// concern: tracked release rungs
/** Reads, compares, and generates the release-rung snapshot used by tag CI. */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveInstallRoot } from '../../../shared/install-root.ts'
import { projectByName } from '../project/projects.ts'
import type { RequiredReleaseRung } from './release-required.ts'

const RELEASE_RUNGS_FILE = 'scripts/quality/release-rungs.json'
const RELEASE_RUNGS_GENERATOR = `${PLATFORM_SLUG} release rungs --write`

type TrackedReleaseRung = Pick<RequiredReleaseRung, 'name' | 'branch'> & {
  live: string
  requiredWhenChanged?: readonly string[]
  entryPoints?: readonly string[]
  onDemand?: boolean
}

export type TrackedReleaseRungs = { rungs: TrackedReleaseRung[] }

export type ReleaseRungsDriftDecision =
  | { status: 'match'; message: string }
  | { status: 'different'; message: string }
  | { status: 'unverified'; message: string }

function normalizeRung(rung: TrackedReleaseRung): TrackedReleaseRung {
  return {
    name: rung.name,
    branch: rung.branch,
    live: rung.live,
    ...(rung.requiredWhenChanged ? { requiredWhenChanged: [...rung.requiredWhenChanged] } : {}),
    ...(rung.entryPoints ? { entryPoints: [...rung.entryPoints] } : {}),
    ...(rung.onDemand !== undefined ? { onDemand: rung.onDemand } : {}),
  }
}

export function releaseRungsFromRegister(
  rungs: readonly RequiredReleaseRung[],
): TrackedReleaseRungs {
  return {
    rungs: rungs.map((rung) => {
      if (!rung.live) {
        throw new Error(
          `release rung ${rung.name} does not declare a commit live probe; add release.rungs[].live before generating ${RELEASE_RUNGS_FILE}`,
        )
      }
      return normalizeRung({
        name: rung.name,
        branch: rung.branch,
        live: rung.live,
        requiredWhenChanged: rung.requiredWhenChanged,
        entryPoints: rung.entryPoints,
        onDemand: rung.onDemand,
      })
    }),
  }
}

function serialized(rungs: TrackedReleaseRungs): string {
  return `${JSON.stringify({ rungs: rungs.rungs.map(normalizeRung) }, null, 2)}\n`
}

/** Compare plain snapshot values, retaining an unavailable register as a distinct outcome. */
export function releaseRungsDriftDecision(
  tracked: TrackedReleaseRungs,
  register: { ok: true; rungs: TrackedReleaseRungs } | { ok: false; error: string },
): ReleaseRungsDriftDecision {
  if (!register.ok) {
    return {
      status: 'unverified',
      message: `release rungs comparison was not run because the project register could not be read: ${register.error}`,
    }
  }
  if (serialized(tracked) === serialized(register.rungs)) {
    return { status: 'match', message: 'tracked release rungs match the project register' }
  }
  return {
    status: 'different',
    message: `tracked release rungs differ from the project register; run ${RELEASE_RUNGS_GENERATOR}, then retry`,
  }
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error(`${field} must be an array of strings`)
  return value
}

function parseRung(value: unknown, index: number): TrackedReleaseRung {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`rungs[${index}] must be an object`)
  const rung = value as Record<string, unknown>
  const allowed = new Set([
    'name',
    'branch',
    'live',
    'requiredWhenChanged',
    'entryPoints',
    'onDemand',
  ])
  const extra = Object.keys(rung).find((key) => !allowed.has(key))
  if (extra) throw new Error(`rungs[${index}].${extra} is not a tracked release-rung field`)
  for (const field of ['name', 'branch', 'live'] as const) {
    if (typeof rung[field] !== 'string' || !rung[field])
      throw new Error(`rungs[${index}].${field} must be a non-empty string`)
  }
  if (rung.onDemand !== undefined && typeof rung.onDemand !== 'boolean')
    throw new Error(`rungs[${index}].onDemand must be a boolean`)
  return normalizeRung({
    name: rung.name as string,
    branch: rung.branch as string,
    live: rung.live as string,
    requiredWhenChanged: stringArray(
      rung.requiredWhenChanged,
      `rungs[${index}].requiredWhenChanged`,
    ),
    entryPoints: stringArray(rung.entryPoints, `rungs[${index}].entryPoints`),
    onDemand: rung.onDemand as boolean | undefined,
  })
}

export function parseReleaseRungs(source: string): TrackedReleaseRungs {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('must contain an object')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'rungs') || !Array.isArray(record.rungs))
    throw new Error('must contain only a rungs array')
  return { rungs: record.rungs.map(parseRung) }
}

export function readTrackedReleaseRungs(root: string): TrackedReleaseRungs {
  const file = join(root, RELEASE_RUNGS_FILE)
  try {
    return parseReleaseRungs(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(
      `cannot read ${RELEASE_RUNGS_FILE}: ${error instanceof Error ? error.message : String(error)}; run ${RELEASE_RUNGS_GENERATOR}, then retry`,
    )
  }
}

export function registeredReleaseRungs():
  | { ok: true; rungs: TrackedReleaseRungs }
  | { ok: false; error: string } {
  try {
    const project = projectByName(PLATFORM_SLUG)
    if (!project) return { ok: false, error: `project ${PLATFORM_SLUG} is not registered` }
    return {
      ok: true,
      rungs: releaseRungsFromRegister(project.settings.release?.rungs ?? []),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function writeRegisteredReleaseRungs(
  fromDirectory = process.cwd(),
  environment: Record<string, string | undefined> = process.env,
): string {
  const registered = registeredReleaseRungs()
  if (!registered.ok) throw new Error(`cannot generate release rungs: ${registered.error}`)
  const root = resolveInstallRoot(fromDirectory, environment)
  writeFileSync(join(root, RELEASE_RUNGS_FILE), serialized(registered.rungs))
  return RELEASE_RUNGS_FILE
}
