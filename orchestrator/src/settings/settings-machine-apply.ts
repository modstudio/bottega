// concern: settings-machine-apply
/** Applies hosted user settings and canon to this machine. Must not know CLI grammar or scheduling. */
import type { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MCP_SERVER_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readMachinePermissions, readMachineValue } from '../../../shared/machine-config.ts'
import {
  resolveOrchestratorDatabase,
  resolveRunsDirectory,
  resolveStatePaths,
} from '../../../shared/state-directory.ts'
import {
  applyUserCanonHomePlans,
  collectUserCanonHome,
  decideUserCanonHomePlanApplication,
  emptyHostedUserCanonStoreRefusal,
  emptyUserCanonStoreRefusal,
  planUserCanonHome,
  type UserCanonHomePlan,
  userCanonHomePlanDrift,
  userCanonHomesFromEnvironment,
} from '../canon/user-canon-home-files.ts'
import { db } from '../database/db.ts'
import { getDocStore as getDoc, listDocsStore as listDocs } from '../doc/doc-read-store.ts'
import { readHostedUserSettingsDocuments, signedInDocOwner } from '../doc/docs.ts'
import { tryKernelLease } from '../project/project-lock.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { isOrchWorkerProcess } from '../run/run-process.ts'
import {
  type ClaudeMcpRegistrationAsyncPort,
  mutateClaudeMcpRegistration,
  reconcileClaudeMcpRegistration,
  reconcileClaudeMcpRegistrationAsync,
  runSetupCommand,
  runSetupCommandAsync,
  stableMcpServers,
} from '../setup/setup-mcp.ts'
import {
  ownedEnvironmentNames,
  parseStoredOwnedSettings,
  SETTINGS_SCOPE,
  SETTINGS_SLUG,
  type SubagentHooksChoice,
  subagentBlockingOn,
} from './settings.ts'
import {
  readSettingsEnv,
  selectedSettingsEnvironment,
  userSettingsEnvPath,
} from './settings-env.ts'
import {
  claudeHomeFromEnvironment,
  tryReadSettingsFile,
  userSettingsPath,
} from './settings-files.ts'
import { type SupersededProfileHook, withMachineProductHooks } from './settings-machine-hooks.ts'
import {
  readClaudeMcpPlacement,
  reconcileClaudeMcpPlacementPlanAsync,
  writeClaudeMcpPlacement,
} from './settings-machine-mcp-placement.ts'
import { registeredProjectScopeFact } from './settings-machine-projects.ts'
import { resolveMachineHookRuntime } from './settings-machine-runtime.ts'
import { decideMachineSettingsScope } from './settings-machine-scope.ts'
import { assertCurrentMachineHomeWriteAuthority } from './settings-machine-write-authority.ts'
import { mergeMachinePermissionOverlay } from './settings-permission-overlay.ts'
import {
  parseSettingsFile,
  renderedSettingsEnvironment,
  renderOwnedSettingsFile,
} from './settings-render.ts'
import {
  applySettingsWrite,
  planSettingsWrite,
  writeNewSettingsFileAtomically,
} from './settings-write.ts'

export type MachineSettingsApplyResult = {
  target: string
  outcome: 'applied' | 'current' | 'refused' | 'skipped'
  condition?: 'no-settings-row' | 'empty-user-canon-store'
  detail?: string
  changed: boolean
  superseded?: SupersededProfileHook[]
  subagentHooksRemoved?: boolean
  subagentHooks?: SubagentHooksChoice
}

export function settingsApplyResultWaitsForSignIn(result: MachineSettingsApplyResult): boolean {
  return result.condition === 'no-settings-row' || result.condition === 'empty-user-canon-store'
}

export type SettingsApplyDecision = {
  action: 'continue' | 'wait-for-sign-in' | 'refuse'
  refused: MachineSettingsApplyResult[]
}

export function settingsApplyDecision(
  sessionPresent: boolean,
  results: readonly MachineSettingsApplyResult[],
): SettingsApplyDecision {
  const refused = results.filter((result) => result.outcome === 'refused')
  if (refused.length === 0) return { action: 'continue', refused }
  if (!sessionPresent && refused.every(settingsApplyResultWaitsForSignIn)) {
    return { action: 'wait-for-sign-in', refused }
  }
  return { action: 'refuse', refused }
}

export const SETTINGS_APPLY_LOCK_TARGET = 'settings apply'

export function settingsApplyLockSkipped(result: MachineSettingsApplyResult): boolean {
  return result.target === SETTINGS_APPLY_LOCK_TARGET && result.outcome === 'skipped'
}

type Dependencies = {
  environment: NodeJS.ProcessEnv
  workerProcess(): boolean
  owner(): Promise<string>
  local: Database
  runsDirectory: string
  applySettings: typeof applySettingsWrite
  applyCanon: typeof applyUserCanonHomePlans
  projectPaths(): string[]
  projectFact: typeof registeredProjectScopeFact
  claudeMcpPort(): ClaudeMcpRegistrationAsyncPort | null
  reconcileMcp: typeof reconcileClaudeMcpRegistration
  reconcileMcpAsync: typeof reconcileClaudeMcpRegistrationAsync
  mutateMcp: typeof mutateClaudeMcpRegistration
  readMcpPlacement: typeof readClaudeMcpPlacement
  writeMcpPlacement: typeof writeClaudeMcpPlacement
}

type UserSettingsDocuments = {
  source: 'local' | 'hosted'
  settings: { body: string } | null
  canon: Array<{ slug: string; body: string }>
}

type ApplyOverrides = Partial<Dependencies> & {
  runningFromRegisteredMainCheckout?: boolean
  registeredMainCheckout?: string | null
  runningInstallationRoot?: string
  binaryRepositoryRoot?: string | null
}

function dependencies(overrides: Partial<Dependencies>): Dependencies {
  const local = overrides.local ?? db(true)
  return {
    environment: process.env,
    workerProcess: () => isOrchWorkerProcess(process.env, process.pid),
    owner: signedInDocOwner,
    local,
    runsDirectory: resolveRunsDirectory(process.env),
    applySettings: applySettingsWrite,
    applyCanon: applyUserCanonHomePlans,
    projectPaths: () =>
      local
        .query<{ path: string }, []>(
          'SELECT path FROM project WHERE retired_at IS NULL ORDER BY name',
        )
        .all()
        .map((row) => row.path),
    projectFact: registeredProjectScopeFact,
    claudeMcpPort: () => {
      const bin = Bun.which('claude')
      return bin ? { bin, runner: runSetupCommand, asyncRunner: runSetupCommandAsync } : null
    },
    reconcileMcp: reconcileClaudeMcpRegistration,
    reconcileMcpAsync: reconcileClaudeMcpRegistrationAsync,
    mutateMcp: mutateClaudeMcpRegistration,
    readMcpPlacement: readClaudeMcpPlacement,
    writeMcpPlacement: writeClaudeMcpPlacement,
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

function localUserSettingsDocuments(owner: string): UserSettingsDocuments {
  return {
    source: 'local',
    settings: getDoc(SETTINGS_SCOPE, null, SETTINGS_SLUG, owner),
    canon: listDocs({ scope: 'canon', subject: null, owner, status: 'current' }),
  }
}

async function hostedUserSettingsDocuments(owner: string): Promise<UserSettingsDocuments> {
  const { settings, canon } = await readHostedUserSettingsDocuments()
  const settingsRow = settings.find(
    (row) => row.slug === SETTINGS_SLUG && row.owner === owner && typeof row.body === 'string',
  )
  return {
    source: 'hosted',
    settings: settingsRow ? { body: settingsRow.body as string } : null,
    canon: canon.flatMap((row) =>
      row.owner === owner && typeof row.slug === 'string' && typeof row.body === 'string'
        ? [{ slug: row.slug, body: row.body }]
        : [],
    ),
  }
}

function applyUserSettings(
  row: UserSettingsDocuments['settings'],
  check: boolean,
  deps: Dependencies,
): MachineSettingsApplyResult {
  const home = claudeHomeFromEnvironment(deps.environment)
  const path = userSettingsPath(home)
  const target = `settings ${path}`
  try {
    const existing = tryReadSettingsFile(path)
    const parsed = existing ?? parseSettingsFile('{}')
    const merged = mergeMachinePermissionOverlay(
      row ? parseStoredOwnedSettings(row.body) : parsed.owned,
      readMachinePermissions(deps.environment),
    )
    const settingsSourceDetail = row ? undefined : 'product hooks only; no user settings row'
    const databasePath = resolveOrchestratorDatabase(deps.environment)
    const globalUse = readMachineValue('machine.global_use', deps.environment) as 'on' | 'off'
    const runtime = resolveMachineHookRuntime()
    const productHooks = withMachineProductHooks(
      merged.settings,
      row ? merged.settings.options : undefined,
      databasePath,
      globalUse,
      runtime,
    )
    const renderedBlockAgentPresent = withMachineProductHooks(
      parsed.owned,
      undefined,
      databasePath,
      globalUse,
      runtime,
    ).superseded.some((hook) => hook.script === 'block-agent.py')
    const owned = productHooks.settings
    const subagentHooks =
      row && subagentBlockingOn(merged.settings.options)
        ? merged.settings.options?.subagentHooks
        : undefined
    let environment: Record<string, string> | undefined
    if (row) {
      const secretsPath = userSettingsEnvPath(home)
      const secrets = readSettingsEnv(secretsPath)
      const names = new Set(ownedEnvironmentNames(owned))
      const removed = parsed.envKeys.filter((name) => !names.has(name))
      const unprotected = removed.filter((name) => !secrets.has(name))
      if (unprotected.length) {
        throw new Error(
          `refusing settings write: env key(s) exist only in ${path}: ${unprotected.join(', ')}\n` +
            `cleared by: run \`${PLATFORM_SLUG} machine settings env import --user\` first`,
        )
      }
      environment = renderedSettingsEnvironment(
        owned,
        selectedSettingsEnvironment(secretsPath, owned.envKeys ?? []),
      )
    }
    const rendered = renderOwnedSettingsFile(parsed.text, owned, environment)
    return applyRenderedUserSettings({
      path,
      target,
      rendered,
      exists: existing !== null,
      check,
      settingsSourceDetail,
      unmatchedDropDetail: unmatchedDropDetail(merged.unmatchedDrops),
      superseded: productHooks.superseded,
      subagentHooksRemoved:
        !subagentBlockingOn(merged.settings.options) &&
        (renderedBlockAgentPresent ||
          productHooks.superseded.some((hook) => hook.script === 'block-agent.py')),
      subagentHooks,
      deps,
    })
  } catch (error) {
    return refusal(target, error)
  }
}

function applyRenderedUserSettings(input: {
  path: string
  target: string
  rendered: string
  exists: boolean
  check: boolean
  settingsSourceDetail?: string
  unmatchedDropDetail?: string
  superseded: SupersededProfileHook[]
  subagentHooksRemoved: boolean
  subagentHooks?: SubagentHooksChoice
  deps: Dependencies
}): MachineSettingsApplyResult {
  const plan = input.exists ? planSettingsWrite(input.path, input.rendered) : null
  const detail = [input.settingsSourceDetail, input.unmatchedDropDetail].filter(Boolean).join('; ')
  if (plan && plan.currentText === plan.renderedText) {
    return {
      target: input.target,
      outcome: 'current',
      detail,
      changed: false,
      ...(!input.check && input.superseded.length ? { superseded: input.superseded } : {}),
      ...(input.subagentHooksRemoved ? { subagentHooksRemoved: true } : {}),
      subagentHooks: input.subagentHooks,
    }
  }
  if (input.check) {
    return {
      target: input.target,
      outcome: 'applied',
      detail: ['would apply', detail].filter(Boolean).join('; '),
      changed: true,
      subagentHooks: input.subagentHooks,
    }
  }
  let result: { backup: string | null }
  if (plan) {
    result = input.deps.applySettings(plan, input.deps.environment)
  } else {
    mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 })
    writeNewSettingsFileAtomically(input.path, input.rendered)
    result = { backup: null }
  }
  return {
    target: input.target,
    outcome: 'applied',
    detail: [result.backup ? `backup ${result.backup}` : 'created new file', detail]
      .filter(Boolean)
      .join('; '),
    changed: true,
    ...(input.superseded.length ? { superseded: input.superseded } : {}),
    ...(input.subagentHooksRemoved ? { subagentHooksRemoved: true } : {}),
    subagentHooks: input.subagentHooks,
  }
}

async function applyClaudeMcpPlacement(
  check: boolean,
  deps: Dependencies,
): Promise<MachineSettingsApplyResult[]> {
  const globalUse = readMachineValue('machine.global_use', deps.environment) as 'on' | 'off'
  const scope = decideMachineSettingsScope(globalUse, deps.projectPaths().map(deps.projectFact))
  const server = stableMcpServers().find((candidate) => candidate.name === MCP_SERVER_NAME)
  if (!server) return [refusal('MCP claude', `stable MCP server ${MCP_SERVER_NAME} is missing`)]
  const results: MachineSettingsApplyResult[] = await reconcileClaudeMcpPlacementPlanAsync(
    check,
    scope,
    {
      environment: deps.environment,
      port: deps.claudeMcpPort,
      server,
      read: deps.readMcpPlacement,
      write: deps.writeMcpPlacement,
      reconcile: deps.reconcileMcp,
      reconcileAsync: deps.reconcileMcpAsync,
      mutate: deps.mutateMcp,
    },
  )
  for (const project of scope.projects) {
    if (project.action === 'skip') {
      results.push({
        target: `project ${project.path}`,
        outcome: 'skipped',
        detail: project.reason,
        changed: false,
      })
    }
  }
  return results
}

function unmatchedDropDetail(drops: { list: string; rule: string }[]): string | undefined {
  if (!drops.length) return undefined
  return `unmatched drop(s): ${drops.map(({ list, rule }) => `${list} ${rule}`).join(', ')}`
}

function assertMachineSettingsWriteAuthority(
  environment: NodeJS.ProcessEnv,
  database: Database,
  overrides: Pick<
    ApplyOverrides,
    | 'runningFromRegisteredMainCheckout'
    | 'registeredMainCheckout'
    | 'runningInstallationRoot'
    | 'binaryRepositoryRoot'
  >,
): void {
  const runsDirectory = resolveRunsDirectory(environment)
  const targetHomes = [
    claudeHomeFromEnvironment(environment),
    ...userCanonHomesFromEnvironment(environment, runsDirectory).map((home) => home.path),
  ]
  assertCurrentMachineHomeWriteAuthority('machine settings apply', targetHomes, database, overrides)
}

function applyUserCanon(
  rows: UserSettingsDocuments['canon'],
  source: UserSettingsDocuments['source'],
  check: boolean,
  deps: Dependencies,
): MachineSettingsApplyResult[] {
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
  const decision = decideUserCanonHomePlanApplication(rows.length, plans)
  if (decision.action === 'refuse-empty-store') {
    return planned.map((item) => ({
      target: item.target,
      outcome: 'refused',
      condition: 'empty-user-canon-store',
      detail:
        source === 'hosted' ? emptyHostedUserCanonStoreRefusal() : emptyUserCanonStoreRefusal(),
      changed: false,
    }))
  }
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
    const applied = deps.applyCanon(decision.plans, deps.environment)
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
  overrides: ApplyOverrides = {},
): Promise<MachineSettingsApplyResult[]> {
  const workerProcess =
    overrides.workerProcess ?? (() => isOrchWorkerProcess(process.env, process.pid))
  if (workerProcess()) {
    throw new Error(
      `refusing settings apply from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} machine settings apply`,
    )
  }
  const environment = overrides.environment ?? process.env
  const local = overrides.local ?? db()
  if (!input.check) {
    assertMachineSettingsWriteAuthority(environment, local, overrides)
  }
  const deps = dependencies({ ...overrides, environment, local, workerProcess })
  const stateDirectory = resolveStatePaths(deps.environment).orchestratorDirectory
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  const lease = tryKernelLease(join(stateDirectory, 'settings-apply.lock'), true)
  if (!lease) {
    return [{ target: SETTINGS_APPLY_LOCK_TARGET, outcome: 'skipped', changed: false }]
  }
  try {
    const owner = await deps.owner()
    const documents = await applyRecordWriteAuthority(
      {
        local: () => localUserSettingsDocuments(owner),
        hosted: () => hostedUserSettingsDocuments(owner),
      },
      deps.local,
    )
    return [
      applyUserSettings(documents.settings, input.check, deps),
      ...applyUserCanon(documents.canon, documents.source, input.check, deps),
      ...(await applyClaudeMcpPlacement(input.check, deps)),
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
    if (settingsApplyLockSkipped(result)) {
      log('settings apply already running; skipped')
      continue
    }
    const status = result.outcome === 'current' ? 'already current' : result.outcome
    const detail = result.detail?.replaceAll('\n', '; ')
    log(`${result.target}: ${status}${detail ? `; ${detail}` : ''}`)
    if (result.subagentHooksRemoved) {
      log('block-agent hooks removed: subagent blocking is off')
    }
    for (const hook of result.superseded ?? []) {
      if (result.subagentHooksRemoved && hook.script === 'block-agent.py') continue
      log(
        `profile hook ${hook.event} ${hook.matcher ?? '-'} ${hook.script} is superseded by the product hook and can be deleted from the profile`,
      )
    }
  }
}
