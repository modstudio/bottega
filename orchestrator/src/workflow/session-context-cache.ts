// concern: workflows
/** Persists per-project hosted autonomy context kept current by autonomy resolvers. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { concernStateDirectory, type StateEnvironment } from '../../../shared/state-directory.ts'
import { writeCacheFile } from '../config/atomic-cache-file.ts'

export type { StateEnvironment } from '../../../shared/state-directory.ts'

import {
  type AutonomySettings,
  autonomySettingsForStorage,
  validateStoredAutonomySettings,
} from './autonomy.ts'

export type CachedSessionContext = {
  version: 1
  resolvedAt: string
  project: string
  hosted: { user: AutonomySettings; space: AutonomySettings }
}

const cacheDirectory = (env: StateEnvironment) =>
  join(concernStateDirectory('orchestrator', env), 'autonomy-context')

// Base64url has no ".", so a project cache name cannot collide with user.display.json.
const cachePath = (project: string, env: StateEnvironment) =>
  join(cacheDirectory(env), `${Buffer.from(project).toString('base64url')}.json`)

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedHostedSettings(value: unknown): AutonomySettings | null {
  if (!object(value) || Object.hasOwn(value, 'shipTo')) return null
  try {
    return validateStoredAutonomySettings(value, 'cached hosted autonomy').settings
  } catch {
    return null
  }
}

function normalizedCache(value: unknown, project: string): CachedSessionContext | null {
  if (!object(value) || value.version !== 1 || value.project !== project) return null
  if (
    typeof value.resolvedAt !== 'string' ||
    Number.isNaN(Date.parse(value.resolvedAt)) ||
    new Date(value.resolvedAt).toISOString() !== value.resolvedAt
  )
    return null
  if (!object(value.hosted)) return null
  const user = normalizedHostedSettings(value.hosted.user)
  const space = normalizedHostedSettings(value.hosted.space)
  if (!user || !space) return null
  return {
    version: 1,
    resolvedAt: value.resolvedAt,
    project,
    hosted: { user, space },
  }
}

export function readSessionContextCache(
  project: string,
  env: StateEnvironment,
): CachedSessionContext | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath(project, env), 'utf8'))
    return normalizedCache(parsed, project)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

export function writeSessionContextCache(value: CachedSessionContext, env: StateEnvironment): void {
  const target = cachePath(value.project, env)
  const stored = {
    ...value,
    hosted: {
      user: autonomySettingsForStorage(value.hosted.user),
      space: autonomySettingsForStorage(value.hosted.space),
    },
  }
  writeCacheFile(target, stored)
}
