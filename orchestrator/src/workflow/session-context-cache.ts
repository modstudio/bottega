// concern: workflows
/** Persists the last complete architect-session autonomy slice. */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { RELEASE_AUTONOMY_VALUES } from '../../../shared/release-autonomy.ts'
import { concernStateDirectory, type StateEnvironment } from '../../../shared/state-directory.ts'
import {
  type AutonomySettings,
  type AutonomyStage,
  type AutonomyValue,
  autonomyStages,
  autonomyValues,
  type ReleaseValue,
  type StageAutonomyValue,
  validateAutonomySettings,
} from './autonomy.ts'

export type CachedSessionContext = {
  version: 1
  resolvedAt: string
  project: string
  hosted: { user: AutonomySettings; space: AutonomySettings }
  rulings: { value: 'agent' | 'user'; scope: string }
  stages: (
    | {
        stage: AutonomyStage
        agreed: true
        value: StageAutonomyValue
        scope: string
        steps: number
      }
    | {
        stage: AutonomyStage
        agreed: false
        values: { value: AutonomyValue; scope: string; steps: number }[]
      }
  )[]
  release: {
    value: ReleaseValue
    scope: string
    landing: string | null
    production: string | null
  }
  warnings?: string[]
}

const cacheDirectory = (env: StateEnvironment) =>
  join(concernStateDirectory('orchestrator', env), 'autonomy-context')

const cachePath = (project: string, env: StateEnvironment) =>
  join(cacheDirectory(env), `${Buffer.from(project).toString('base64url')}.json`)

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validHostedSettings(value: unknown): value is AutonomySettings {
  if (!object(value)) return false
  try {
    if (
      value.release !== undefined &&
      !RELEASE_AUTONOMY_VALUES.includes(value.release as ReleaseValue)
    ) {
      const { release: _release, ...settings } = value
      validateAutonomySettings(settings, 'cached hosted autonomy')
    } else validateAutonomySettings(value, 'cached hosted autonomy')
    return true
  } catch {
    return false
  }
}

function validCache(value: unknown, project: string): value is CachedSessionContext {
  if (!object(value) || value.version !== 1 || value.project !== project) return false
  if (
    typeof value.resolvedAt !== 'string' ||
    Number.isNaN(Date.parse(value.resolvedAt)) ||
    new Date(value.resolvedAt).toISOString() !== value.resolvedAt
  )
    return false
  if (
    !object(value.hosted) ||
    !validHostedSettings(value.hosted.user) ||
    !validHostedSettings(value.hosted.space) ||
    !object(value.rulings) ||
    !Array.isArray(value.stages) ||
    !object(value.release)
  )
    return false
  if (!['agent', 'user'].includes(String(value.rulings.value))) return false
  if (typeof value.rulings.scope !== 'string') return false
  if (
    typeof value.release.value !== 'string' ||
    !RELEASE_AUTONOMY_VALUES.includes(value.release.value as ReleaseValue) ||
    typeof value.release.scope !== 'string'
  )
    return false
  if (value.release.landing !== null && typeof value.release.landing !== 'string') return false
  if (value.release.production !== null && typeof value.release.production !== 'string')
    return false
  if (
    value.warnings !== undefined &&
    (!Array.isArray(value.warnings) || value.warnings.some((item) => typeof item !== 'string'))
  )
    return false
  return value.stages.every((stage) => {
    if (
      !object(stage) ||
      typeof stage.stage !== 'string' ||
      !autonomyStages.includes(stage.stage as AutonomyStage) ||
      typeof stage.agreed !== 'boolean'
    )
      return false
    if (stage.agreed)
      return (
        typeof stage.value === 'string' &&
        [...autonomyValues, 'per step'].includes(stage.value) &&
        typeof stage.scope === 'string' &&
        typeof stage.steps === 'number'
      )
    return (
      Array.isArray(stage.values) &&
      stage.values.every(
        (item) =>
          object(item) &&
          typeof item.value === 'string' &&
          autonomyValues.includes(item.value as AutonomyValue) &&
          typeof item.scope === 'string' &&
          typeof item.steps === 'number',
      )
    )
  })
}

export function readSessionContextCache(
  project: string,
  env: StateEnvironment,
): CachedSessionContext | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath(project, env), 'utf8'))
    return validCache(parsed, project) ? parsed : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

export function writeSessionContextCache(value: CachedSessionContext, env: StateEnvironment): void {
  const directory = cacheDirectory(env)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const target = cachePath(value.project, env)
  const temporary = join(directory, `.${basename(target)}.tmp-${process.pid}-${randomUUID()}`)
  let descriptor: number | null = null
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporary, target)
    const directoryDescriptor = openSync(directory, constants.O_RDONLY)
    try {
      fsyncSync(directoryDescriptor)
    } finally {
      closeSync(directoryDescriptor)
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor)
    rmSync(temporary, { force: true })
  }
}
