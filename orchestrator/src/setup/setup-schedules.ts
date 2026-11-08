import { startBoundedSync } from '../../../shared/bounded-process.ts'
// concern: setup-schedules
/** Renders and installs the worker-capable distribution's scheduled maintenance agents. */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readInstallAsset } from '../../../shared/embedded-assets.ts'
import { installationIdentity } from '../../../shared/install-root.ts'
import { renderLaunchAgentTemplate } from '../../../shared/launch-agent-render.ts'
import {
  gatherLaunchAgentSkipFacts,
  type LaunchAgentSkipFacts,
  launchAgentSkipReason,
} from '../../../shared/launch-agent-skip.ts'
import type { MachineLevel } from '../../../shared/machine-config.ts'
import {
  RECORD_SYNC_PENDING_MARKER,
  recordSyncQueueDirectory,
  resolveStateRoot,
  STATE_HOME_ENV,
} from '../../../shared/state-directory.ts'
import { plistStandardOutPath } from './launchd-owners.ts'

export const MAINTENANCE_SCHEDULE_LABELS = [
  'com.user.orch-sweep',
  'com.user.orch-record-sync',
] as const

export type MaintenanceScheduleLabel = (typeof MAINTENANCE_SCHEDULE_LABELS)[number]

const maintenanceScheduleLabels = new Set<string>(MAINTENANCE_SCHEDULE_LABELS)

export function isMaintenanceScheduleLabel(label: string): label is MaintenanceScheduleLabel {
  return maintenanceScheduleLabels.has(label)
}

export type ScheduleSetupFact = {
  label: MaintenanceScheduleLabel
  installed: boolean
  loaded: boolean
  plistMatches: boolean
}

export type ScheduleRenderValues = {
  bottegaBin: string
  home: string
  stateHomeEnvironment: string
  stateHome: string
}

export type ScheduleApplyResult = {
  label: MaintenanceScheduleLabel
  status: 'applied' | 'unchanged' | 'skipped'
  reason?: string
}

export type MaintenanceSchedulePlanItem = {
  label: MaintenanceScheduleLabel
  skipReason: string | null
}

/** Apply the shared skip ruling to the canonical setup label set. */
export function maintenanceSchedulePlan(
  skipFacts: LaunchAgentSkipFacts,
): MaintenanceSchedulePlanItem[] {
  return MAINTENANCE_SCHEDULE_LABELS.map((label) => ({
    label,
    skipReason: launchAgentSkipReason(label, skipFacts),
  }))
}

/** Return the release-owned schedules required at this machine's setup level. */
export function requiredMaintenanceLabels(
  skipFacts: LaunchAgentSkipFacts,
  level: MachineLevel,
): MaintenanceScheduleLabel[] {
  if (level !== 'full') return []
  return maintenanceSchedulePlan(skipFacts).flatMap(({ label, skipReason }) =>
    skipReason ? [] : [label],
  )
}

const templatePath = (label: MaintenanceScheduleLabel): string =>
  `ops/launchd/${label}.plist.template`

/** Replace the complete placeholder vocabulary shared by the two maintenance templates. */
export function renderMaintenanceSchedule(template: string, values: ScheduleRenderValues): string {
  const recordSyncQueue = recordSyncQueueDirectory({ [STATE_HOME_ENV]: values.stateHome })
  return renderLaunchAgentTemplate(template, {
    __BOTTEGA_BIN__: values.bottegaBin,
    __HOME__: values.home,
    __STATE_HOME_ENV__: values.stateHomeEnvironment,
    __STATE_HOME__: values.stateHome,
    __RECORD_SYNC_QUEUE__: recordSyncQueue,
    __RECORD_SYNC_MARKER__: RECORD_SYNC_PENDING_MARKER,
  })
}

function scheduleValues(): ScheduleRenderValues {
  return {
    bottegaBin: process.execPath,
    home: homedir(),
    stateHomeEnvironment: STATE_HOME_ENV,
    stateHome: resolveStateRoot(process.env),
  }
}

function renderedSchedule(label: MaintenanceScheduleLabel): string {
  const identity = installationIdentity(import.meta.dir, {})
  const relative = templatePath(label)
  return renderMaintenanceSchedule(
    readInstallAsset(relative, join(identity.root, relative)),
    scheduleValues(),
  )
}

function launchctlPath(): string | null {
  return Bun.which('launchctl')
}

function launchctlLoaded(launchctl: string, uid: number, label: string): boolean {
  return (
    startBoundedSync([launchctl, 'print', `gui/${uid}/${label}`], { budget: 'process-table' })
      .exitCode === 0
  )
}

/** Gather the two facts the pure setup planner needs for each release-owned schedule. */
export function gatherScheduleSetupFacts(): ScheduleSetupFact[] {
  if (process.platform !== 'darwin') return []
  const launchctl = launchctlPath()
  const uid = process.getuid?.()
  const values = scheduleValues()
  return MAINTENANCE_SCHEDULE_LABELS.map((label) => {
    const target = join(values.home, 'Library', 'LaunchAgents', `${label}.plist`)
    const expected = renderedSchedule(label)
    const installed = existsSync(target)
    return {
      label,
      installed,
      loaded: launchctl !== null && uid !== undefined && launchctlLoaded(launchctl, uid, label),
      plistMatches: installed && readFileSync(target, 'utf8') === expected,
    }
  })
}

async function waitUntilUnloaded(launchctl: string, uid: number, label: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!launchctlLoaded(launchctl, uid, label)) return
    await Bun.sleep(250)
  }
  throw new Error(`launchctl did not unload ${label}`)
}

async function bootstrapWithRetry(launchctl: string, uid: number, target: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = startBoundedSync([launchctl, 'bootstrap', `gui/${uid}`, target], {
      budget: 'process-table',
    })
    if (result.exitCode === 0) return
    if (attempt === 19) {
      const detail = `${result.stdout.toString()}${result.stderr.toString()}`.trim()
      throw new Error(`launchctl could not bootstrap ${target}${detail ? `: ${detail}` : ''}`)
    }
    await Bun.sleep(250)
  }
}

/** Install the release-owned schedules through launchctl, preserving per-label skip rulings. */
export async function applyMaintenanceSchedules(): Promise<ScheduleApplyResult[]> {
  const launchctl = launchctlPath()
  const uid = process.getuid?.()
  if (!launchctl || uid === undefined) throw new Error('launchctl is unavailable')
  const values = scheduleValues()
  const agents = join(values.home, 'Library', 'LaunchAgents')
  await mkdir(agents, { recursive: true })
  await mkdir(recordSyncQueueDirectory(process.env), { recursive: true })
  const skipFacts = gatherLaunchAgentSkipFacts()
  const results: ScheduleApplyResult[] = []
  for (const item of maintenanceSchedulePlan(skipFacts)) {
    if (item.skipReason) {
      results.push({ label: item.label, status: 'skipped', reason: item.skipReason })
      continue
    }
    results.push(await applyMaintenanceSchedule(item.label, launchctl, uid, agents))
  }
  return results
}

async function applyMaintenanceSchedule(
  label: MaintenanceScheduleLabel,
  launchctl: string,
  uid: number,
  agents: string,
): Promise<ScheduleApplyResult> {
  const rendered = renderedSchedule(label)
  const target = join(agents, `${label}.plist`)
  const logPath = plistStandardOutPath(rendered)
  if (!logPath) throw new Error(`${label} template has no StandardOutPath`)
  await mkdir(dirname(logPath), { recursive: true })
  let current: string | null = null
  try {
    current = await readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const loaded = launchctlLoaded(launchctl, uid, label)
  if (current === rendered && loaded) return { label, status: 'unchanged' }
  if (loaded) {
    startBoundedSync([launchctl, 'bootout', `gui/${uid}/${label}`], { budget: 'process-table' })
    await waitUntilUnloaded(launchctl, uid, label)
  }
  await rm(target, { force: true })
  await writeFile(target, rendered, 'utf8')
  await bootstrapWithRetry(launchctl, uid, target)
  return { label, status: 'applied' }
}
