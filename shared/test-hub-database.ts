import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function gitEnvironment(): NodeJS.ProcessEnv {
  const query = spawnSync('git', ['rev-parse', '--local-env-vars'], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    encoding: 'utf8',
  })
  if (query.status !== 0) {
    throw new Error(
      `test process cannot resolve live hub database: git rev-parse --local-env-vars failed with exit ${query.status ?? 'unknown'}`,
    )
  }
  const names = query.stdout.split(/\s+/).filter(Boolean)
  if (!names.includes('GIT_DIR')) {
    throw new Error(
      'test process cannot resolve live hub database: git rev-parse --local-env-vars did not list GIT_DIR',
    )
  }
  const env = { ...process.env }
  for (const name of names) delete env[name]
  delete env.ORCH_GUARDED_GIT_COMMON_DIR
  delete env.ORCH_ALLOWED_GIT_REF
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  return env
}

function liveHubDatabase(checkout: string): string {
  const commonDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: checkout,
    env: gitEnvironment(),
    encoding: 'utf8',
  })
  if (commonDir.status !== 0 || !commonDir.stdout.trim()) {
    throw new Error(`test process cannot resolve live hub database for checkout ${checkout}`)
  }
  return join(dirname(commonDir.stdout.trim()), 'hub', 'hub.db')
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Refuse any test process state in which hub would open the live task board. */
export function createTestHubDatabaseGuard(checkout: string, liveStorePath?: string): () => void {
  const liveStore = canonicalPath(liveStorePath ?? liveHubDatabase(checkout))
  return () => {
    const configured = process.env.HUB_DB
    const resolved = configured
      ? canonicalPath(configured)
      : configured === ''
        ? '<empty>'
        : '<unset>'
    if (configured && resolved !== liveStore) return
    throw new Error(
      `test process refuses hub database: HUB_DB resolved ${resolved}; live store is ${liveStore}\n` +
        'invariant: A test suite never falls back to the live hub database.\n' +
        'cleared by: set HUB_DB to a scratch store before importing hub/src/db.ts',
    )
  }
}
