#!/usr/bin/env bun
/** Machine state belongs in the per-user state root, never inside the checkout. */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FROZEN_STATE_NAMES } from '../shared/brand.ts'
import { resolveStatePaths, type StateEnvironment } from '../shared/state-directory.ts'

export type MachineStatePath = {
  path: string
  tracked: boolean
}

export type MachineStateFinding = {
  path: string
  reason: string
}

const runsPath = `orchestrator/${FROZEN_STATE_NAMES.runsDirectory}`
const orchestratorDatabase = `orchestrator/${FROZEN_STATE_NAMES.orchestratorDatabase}`
const hubDatabase = `hub/${FROZEN_STATE_NAMES.hubDatabase}`
const rootDatabases = new Set([
  FROZEN_STATE_NAMES.orchestratorDatabase,
  FROZEN_STATE_NAMES.hubDatabase,
])
const concernDatabases = new Set(
  [orchestratorDatabase, hubDatabase].flatMap((path) => [path, `${path}-wal`, `${path}-shm`]),
)
const exactStatePaths = new Map([
  ['hub/.serve', 'serve lifecycle state'],
  ['orchestrator/.last-wake', 'wake state'],
  ['orchestrator/spawn-fallback.log', 'spawn fallback log'],
])
const trackedDatabase = /(?:^|\/)[^/]+\.db(?:-wal|-shm)?$/
const databaseBackup = /(?:^|\/)[^/]+\.db\.backup-.+$/

function machineStateReason(path: string, tracked: boolean): string | undefined {
  if (path === runsPath || path.startsWith(`${runsPath}/`)) return 'orchestrator run artifact'
  if (concernDatabases.has(path) || rootDatabases.has(path)) return 'legacy database state'
  if (tracked && trackedDatabase.test(path)) return 'tracked database state'
  if (databaseBackup.test(path)) return 'database backup state'
  if (path === 'hub/.serve' || path.startsWith('hub/.serve/')) return 'serve lifecycle state'
  return exactStatePaths.get(path)
}

/** Decide only from repository-relative paths and their tracked status. */
export function decideMachineState(paths: MachineStatePath[]): MachineStateFinding[] {
  const findings = new Map<string, MachineStateFinding>()
  for (const candidate of paths) {
    const path = candidate.path.replace(/^\.\//, '').replaceAll('\\', '/')
    if (!path || path.split('/').includes('node_modules') || findings.has(path)) continue

    const reason = machineStateReason(path, candidate.tracked)
    if (reason) findings.set(path, { path, reason })
  }
  return [...findings.values()]
}

const exactLegacyPaths = [
  runsPath,
  ...concernDatabases,
  ...rootDatabases,
  ...exactStatePaths.keys(),
]

function gitPaths(root: string, argv: string[], tracked: boolean): MachineStatePath[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z', ...argv], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`could not inspect checkout paths: ${result.stderr.toString().trim()}`)
  }
  return result.stdout
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((path) => ({ path, tracked }))
}

function checkoutPaths(root: string): MachineStatePath[] {
  return [
    ...gitPaths(root, ['--cached'], true),
    ...gitPaths(root, ['--others', '--exclude-standard'], false),
    ...gitPaths(root, ['--others', '--ignored', '--exclude-standard'], false),
    ...exactLegacyPaths
      .filter((path) => existsSync(resolve(root, path)))
      .map((path) => ({ path, tracked: false })),
  ]
}

function destination(path: string, env: StateEnvironment): string {
  const state = resolveStatePaths(env)
  if (path === FROZEN_STATE_NAMES.orchestratorDatabase) return state.orchestratorDatabase
  if (path === FROZEN_STATE_NAMES.hubDatabase) return state.hubDatabase
  if (path === orchestratorDatabase || path.startsWith(`${orchestratorDatabase}-`)) {
    return `${state.orchestratorDatabase}${path.slice(orchestratorDatabase.length)}`
  }
  if (path === hubDatabase || path.startsWith(`${hubDatabase}-`)) {
    return `${state.hubDatabase}${path.slice(hubDatabase.length)}`
  }
  if (path === runsPath || path.startsWith(`${runsPath}/`)) {
    return join(state.orchestratorRuns, path.slice(runsPath.length))
  }
  if (path === 'hub/.serve' || path.startsWith('hub/.serve/')) {
    return join(state.hubDirectory, path.slice('hub/'.length))
  }
  if (path.startsWith('orchestrator/')) {
    return join(state.orchestratorDirectory, path.slice('orchestrator/'.length))
  }
  return join(state.root, path)
}

if (import.meta.main) {
  const root = resolve(new URL('..', import.meta.url).pathname)
  const findings = decideMachineState(checkoutPaths(root))
  if (findings.length) {
    console.error('machine state check failed: state belongs outside the checkout')
    for (const finding of findings) {
      console.error(
        `${finding.path}: ${finding.reason}; move it to ${destination(finding.path, process.env)} or delete it if it was committed by mistake`,
      )
    }
    process.exit(1)
  }
  console.log('machine state check passed')
}
