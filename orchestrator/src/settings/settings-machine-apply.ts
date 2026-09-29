// concern: settings-machine-apply
/** Applies hosted user settings and canon to this machine. Must not know CLI grammar or scheduling. */
import type { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRunsDirectory, resolveStatePaths } from '../../../shared/state-directory.ts'
import {
  applyUserCanonHomePlans,
  collectUserCanonHome,
  planUserCanonHome,
  type UserCanonHomePlan,
  userCanonHomePlanDrift,
  userCanonHomesFromEnvironment,
} from '../canon/user-canon-home-files.ts'
import { db } from '../database/db.ts'
import { getDoc, listDocs, signedInDocOwner } from '../doc/docs.ts'
import { tryKernelLease } from '../project/project-lock.ts'
import { pullRecordCache } from '../record/record-cache.ts'
import { isOrchWorkerProcess } from '../run/run-process.ts'
import { parseStoredOwnedSettings, SETTINGS_SCOPE, SETTINGS_SLUG } from './settings.ts'
import {
  readSettingsEnv,
  selectedSettingsEnvironment,
  userSettingsEnvPath,
} from './settings-env.ts'
import { claudeHomeFromEnvironment, readSettingsFile, userSettingsPath } from './settings-files.ts'
import { renderOwnedSettingsFile } from './settings-render.ts'
import { applySettingsWrite, planSettingsWrite } from './settings-write.ts'

export type MachineSettingsApplyResult = {
  target: string
  outcome: 'applied' | 'current' | 'refused' | 'skipped'
  detail?: string
  changed: boolean
}

type Dependencies = {
  environment: NodeJS.ProcessEnv
  pull(): Promise<unknown>
  workerProcess(): boolean
  owner(): Promise<string>
  local: Database
  runsDirectory: string
  applySettings: typeof applySettingsWrite
  applyCanon: typeof applyUserCanonHomePlans
}

function dependencies(overrides: Partial<Dependencies>): Dependencies {
  const local = overrides.local ?? db(true)
  return {
    environment: process.env,
    pull: () => pullRecordCache(local),
    workerProcess: () => isOrchWorkerProcess(process.env, process.pid),
    owner: signedInDocOwner,
    local,
    runsDirectory: resolveRunsDirectory(process.env),
    applySettings: applySettingsWrite,
    applyCanon: applyUserCanonHomePlans,
    ...overrides,
  }
}

function refusal(target: string, error: unknown): MachineSettingsApplyResult {
  return {
    target,
    outcome: 'refused',
    detail: error instanceof Error ? error.message : String(error),
    changed: false,
  }
}

function applyUserSettings(
  owner: string,
  check: boolean,
  deps: Dependencies,
): MachineSettingsApplyResult {
  const home = claudeHomeFromEnvironment(deps.environment)
  const path = userSettingsPath(home)
  const target = `settings ${path}`
  try {
    const row = getDoc(SETTINGS_SCOPE, null, SETTINGS_SLUG, owner)
    if (!row) throw new Error('refusing settings render: no settings row for user')
    const parsed = readSettingsFile(path)
    const owned = parseStoredOwnedSettings(row.body)
    const secretsPath = userSettingsEnvPath(home)
    const secrets = readSettingsEnv(secretsPath)
    const removed = parsed.envKeys.filter((name) => !(owned.envKeys ?? []).includes(name))
    const unprotected = removed.filter((name) => !secrets.has(name))
    if (unprotected.length) {
      throw new Error(
        `refusing settings write: env key(s) exist only in ${path}: ${unprotected.join(', ')}\n` +
          'cleared by: run `orch settings env import --user` first',
      )
    }
    const environment = selectedSettingsEnvironment(secretsPath, owned.envKeys ?? [])
    const rendered = renderOwnedSettingsFile(parsed.text, owned, environment)
    const plan = planSettingsWrite(path, rendered)
    if (plan.currentText === plan.renderedText) {
      return { target, outcome: 'current', changed: false }
    }
    if (check) return { target, outcome: 'applied', detail: 'would apply', changed: true }
    const result = deps.applySettings(plan, deps.environment)
    return {
      target,
      outcome: 'applied',
      detail: result.backup ? `backup ${result.backup}` : 'created new file',
      changed: true,
    }
  } catch (error) {
    return refusal(target, error)
  }
}

function applyUserCanon(
  owner: string,
  check: boolean,
  deps: Dependencies,
): MachineSettingsApplyResult[] {
  const rows = listDocs({ scope: 'canon', subject: null, owner })
  const homes = userCanonHomesFromEnvironment(deps.environment, deps.runsDirectory).filter(
    (home) => home.installed,
  )
  const planned: Array<{ target: string; plan?: UserCanonHomePlan; error?: unknown }> = homes.map(
    (home) => {
      const target = `canon ${home.mapping.harness} ${home.path}`
      try {
        return {
          target,
          plan: planUserCanonHome({ home, rows, files: collectUserCanonHome(home) }),
        }
      } catch (error) {
        return { target, error }
      }
    },
  )
  if (planned.some((item) => item.error !== undefined)) {
    return planned.map((item) =>
      item.error === undefined
        ? {
            target: item.target,
            outcome: 'refused',
            detail: 'not written: canon batch refused',
            changed: false,
          }
        : refusal(item.target, item.error),
    )
  }
  const plans = planned.map((item) => item.plan!)
  const drift = new Map(planned.map((item) => [item.target, userCanonHomePlanDrift(item.plan!)]))
  if (check) {
    return planned.map((item) => ({
      target: item.target,
      outcome: drift.get(item.target)! > 0 ? 'applied' : 'current',
      detail: drift.get(item.target)! > 0 ? 'would apply' : undefined,
      changed: drift.get(item.target)! > 0,
    }))
  }
  try {
    const applied = deps.applyCanon(plans, deps.environment)
    let backupOffset = 0
    return planned.map((item) => {
      const changed = drift.get(item.target)! > 0
      if (!changed) return { target: item.target, outcome: 'current', changed: false }
      const backupCount =
        item.plan!.deletes.length +
        item.plan!.adopts.length +
        item.plan!.writes.filter((write) => write.existing).length
      const backups = applied.backups.slice(backupOffset, backupOffset + backupCount)
      backupOffset += backupCount
      return {
        target: item.target,
        outcome: 'applied',
        detail: backups.length ? `backup ${backups.join(', ')}` : 'created new file',
        changed: true,
      }
    })
  } catch (error) {
    return planned.map((item) => refusal(item.target, error))
  }
}

export async function applyMachineSettings(
  input: { check: boolean },
  overrides: Partial<Dependencies> = {},
): Promise<MachineSettingsApplyResult[]> {
  const workerProcess =
    overrides.workerProcess ?? (() => isOrchWorkerProcess(process.env, process.pid))
  if (workerProcess()) {
    throw new Error(
      'refusing settings apply from an orch worker run; an operator must run orch settings apply',
    )
  }
  const deps = dependencies({ ...overrides, workerProcess })
  const stateDirectory = resolveStatePaths(deps.environment).orchestratorDirectory
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  const lease = tryKernelLease(join(stateDirectory, 'settings-apply.lock'), true)
  if (!lease) {
    return [{ target: 'settings apply', outcome: 'skipped', changed: false }]
  }
  try {
    await deps.pull()
    const owner = await deps.owner()
    return [
      applyUserSettings(owner, input.check, deps),
      ...applyUserCanon(owner, input.check, deps),
    ]
  } finally {
    lease.release()
  }
}

export function printMachineSettingsApplyResults(
  results: MachineSettingsApplyResult[],
  log: (...values: unknown[]) => void,
): void {
  for (const result of results) {
    if (result.outcome === 'skipped') {
      log('settings apply already running; skipped')
      continue
    }
    const status = result.outcome === 'current' ? 'already current' : result.outcome
    const detail = result.detail?.replaceAll('\n', '; ')
    log(`${result.target}: ${status}${detail ? `; ${detail}` : ''}`)
  }
}
