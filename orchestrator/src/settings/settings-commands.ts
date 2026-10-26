// concern: settings-commands
/** Knows settings import and render --check command semantics. Must not know runs, routing, transports, the CLI, or worktrees. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { assetPath } from '../../../shared/install-root.ts'
import { readMachinePermissions } from '../../../shared/machine-config.ts'
import type { Finding } from '../../../shared/ratchet.ts'
import { summarizeSettings } from '../../../shared/settings-summary.ts'
import { resolveOrchestratorDatabase } from '../../../shared/state-directory.ts'
import { decideDocRevisionWrite } from '../doc/doc-write-allowed.ts'
import { getDoc, setDoc, signedInDocOwner } from '../doc/docs.ts'
import { projectAt, projectByName, projects } from '../project/projects.ts'
import {
  AUTO_MODE_LISTS,
  type AutoModeList,
  autoModeLists,
  containsSecretShaped,
  isPlainObject,
  type OwnedSettings,
  ownedSettingsEqual,
  PERMISSION_LISTS,
  type PermissionList,
  parseStoredOwnedSettings,
  permissionLists,
  refuseSettingsBody,
  SETTINGS_SCOPE,
  SETTINGS_SLUG,
  serializeOwnedSettings,
} from './settings.ts'
import { editSettingsAutoMode, type SettingsAutoModeOperation } from './settings-auto-mode.ts'
import { selectedSettingsEnvironment, userSettingsEnvPath } from './settings-env.ts'
import {
  claudeHomeFromEnvironment,
  projectLocalSettingsPath,
  projectSettingsPath,
  readLocalPermissionLists,
  readSettingsFile,
  tryReadSettingsFile,
  userLocalSettingsPath,
  userSettingsPath,
} from './settings-files.ts'
import { adoptionCandidates, lintSettings, type SettingsTarget } from './settings-lint.ts'
import { withMachineProductHooks } from './settings-machine-hooks.ts'
import { editSettingsPermission, type SettingsPermissionOperation } from './settings-permission.ts'
import { mergeMachinePermissionOverlay } from './settings-permission-overlay.ts'
import {
  diffOwnedSettings,
  displayHookDrift,
  displaySettingsValue,
  renderedSettingsEnvironment,
  renderOwnedSettingsFile,
  type SettingsDrift,
  settingsFileOwnedSettings,
} from './settings-render.ts'

type SettingsFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
}
type SettingsPresentation = {
  log(...values: unknown[]): void
  exitCode(code: number): void
  cwd(): string
}

type SettingsTargetKind = { kind: 'user' } | { kind: 'project'; name: string }

export async function settingsAutoModeCommand(
  flags: SettingsFlags,
  operation: SettingsAutoModeOperation,
): Promise<{
  revision: string
  counts: Record<AutoModeList, number>
  changed: boolean
  message?: string
}> {
  const target = resolveSettingsTarget(flags)
  if (target.kind === 'project') projectRoot(target.name, process.cwd())
  const owner = target.kind === 'user' ? await signedInDocOwner() : null
  const { expectedRevision, list, rule } = settingsAutoModeInput(flags)
  return applySettingsListEdit({
    target,
    owner,
    expectedRevision,
    missingRowMessage: `refusing settings auto-mode ${operation}: no settings row for ${targetLabel(target)}`,
    reason: flags.flag('reason')?.trim() || 'updated auto-mode rule',
    edit: (settings) => editSettingsAutoMode(settings, { list, rule, operation }),
    counts: autoModeCounts,
  })
}

function settingsAutoModeInput(flags: SettingsFlags): {
  expectedRevision: string
  list: AutoModeList
  rule: string
} {
  const expectedRevision = flags.flag('expect')
  if (!expectedRevision) throw new Error('refusing settings auto-mode: --expect is required')
  const list = flags.flag('list')
  if (!AUTO_MODE_LISTS.includes(list as AutoModeList)) {
    throw new Error(`refusing settings auto-mode: --list must be ${AUTO_MODE_LISTS.join(', ')}`)
  }
  const rule = flags.flag('rule')?.trim()
  if (!rule) throw new Error('refusing settings auto-mode: --rule is required')
  return { expectedRevision, list: list as AutoModeList, rule }
}

function autoModeCounts(owned: OwnedSettings): Record<AutoModeList, number> {
  const lists = autoModeLists(owned.autoMode)
  return {
    allow: lists.allow.length,
    soft_deny: lists.soft_deny.length,
    hard_deny: lists.hard_deny.length,
    environment: lists.environment.length,
  }
}

export async function settingsPermissionCommand(
  flags: SettingsFlags,
  operation: SettingsPermissionOperation,
): Promise<{
  revision: string
  counts: Record<PermissionList, number>
  changed: boolean
  message?: string
}> {
  const target = resolveSettingsTarget(flags)
  if (target.kind === 'project') projectRoot(target.name, process.cwd())
  const owner = target.kind === 'user' ? await signedInDocOwner() : null
  const { expectedRevision, list, rule } = settingsPermissionInput(flags)
  return applySettingsListEdit({
    target,
    owner,
    expectedRevision,
    missingRowMessage: `refusing settings permission ${operation}: no settings row for ${targetLabel(target)}`,
    reason: flags.flag('reason')?.trim() || 'updated permission rule',
    edit: (settings) => editSettingsPermission(settings, { list, rule, operation }),
    counts: permissionCounts,
  })
}

type SettingsListEdit = { settings: OwnedSettings; changed: boolean; message?: string }

async function applySettingsListEdit<Counts>(input: {
  target: SettingsTargetKind
  owner: string | null
  expectedRevision: string
  missingRowMessage: string
  reason: string
  edit(settings: OwnedSettings): SettingsListEdit
  counts(settings: OwnedSettings): Counts
}): Promise<{ revision: string; counts: Counts; changed: boolean; message?: string }> {
  const row = settingsRow(input.target, input.owner)
  if (!row) throw new Error(input.missingRowMessage)
  const revision = decideDocRevisionWrite({
    expected: input.expectedRevision,
    current: row.revision ?? null,
    isCreate: false,
    scope: SETTINGS_SCOPE,
  })
  if (!revision.allow) throw new Error(revision.reason)
  const edit = input.edit(parseStoredOwnedSettings(row.body))
  if (!edit.changed) {
    return {
      revision: row.revision!,
      counts: input.counts(edit.settings),
      changed: false,
      message: edit.message,
    }
  }
  const body = serializeOwnedSettings(edit.settings)
  const refusal = refuseSettingsBody(SETTINGS_SCOPE, body)
  if (refusal) throw new Error(refusal)
  const written = await setDoc({
    scope: SETTINGS_SCOPE,
    subject: input.target.kind === 'project' ? input.target.name : null,
    owner: input.owner,
    slug: SETTINGS_SLUG,
    title: SETTINGS_SLUG,
    body,
    delivery: 'demand',
    reason: input.reason,
    expectedRevision: input.expectedRevision,
  })
  return {
    revision: written.revision!,
    counts: input.counts(parseStoredOwnedSettings(written.body)),
    changed: true,
  }
}

function settingsPermissionInput(flags: SettingsFlags): {
  expectedRevision: string
  list: PermissionList
  rule: string
} {
  const expectedRevision = flags.flag('expect')
  if (!expectedRevision) throw new Error('refusing settings permission: --expect is required')
  const list = flags.flag('list')
  if (!PERMISSION_LISTS.includes(list as PermissionList)) {
    throw new Error(`refusing settings permission: --list must be ${PERMISSION_LISTS.join(', ')}`)
  }
  const rule = flags.flag('rule')?.trim()
  if (!rule) throw new Error('refusing settings permission: --rule is required')
  return { expectedRevision, list: list as PermissionList, rule }
}

function permissionCounts(owned: OwnedSettings): Record<PermissionList, number> {
  const lists = permissionLists(owned.permissions)
  return { allow: lists.allow.length, ask: lists.ask.length, deny: lists.deny.length }
}

function resolveSettingsTarget(flags: SettingsFlags): SettingsTargetKind {
  const user = flags.has('user')
  const project = flags.flag('project')
  if (user && project) {
    throw new Error('refusing settings: pass --user or --project, not both')
  }
  if (user) return { kind: 'user' }
  if (project) return { kind: 'project', name: project }
  throw new Error('refusing settings: pass --user or --project <name>')
}

function settingsFilePath(target: SettingsTargetKind, env: NodeJS.ProcessEnv, cwd: string): string {
  if (target.kind === 'user') return userSettingsPath(claudeHomeFromEnvironment(env))
  return projectSettingsPath(projectRoot(target.name, cwd))
}

function settingsLocalPath(
  target: SettingsTargetKind,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  if (target.kind === 'user') return userLocalSettingsPath(claudeHomeFromEnvironment(env))
  return projectLocalSettingsPath(projectRoot(target.name, cwd))
}

export async function settingsImportCommand(
  flags: SettingsFlags,
  presentation: SettingsPresentation,
): Promise<void> {
  const target = resolveSettingsTarget(flags)
  const owner = target.kind === 'user' ? await signedInDocOwner() : null
  const cwd = presentation.cwd()
  const path = settingsFilePath(target, process.env, cwd)
  const parsed = readSettingsFile(path)
  const existing = settingsRow(target, owner)
  const storeOwned = existing ? parseStoreOwned(existing.body) : emptyOwned()
  const localLists = readLocalPermissionLists(settingsLocalPath(target, process.env, cwd))
  const adoption = adoptionCandidates(localLists, permissionLists(storeOwned.permissions))
  const findings = lintSettings(lintTargets(target, parsed.owned, cwd))

  presentation.log(`read ${path}`)
  logOwnedCounts(parsed.owned, presentation.log)
  logAdoption(adoption, presentation.log)
  printFindings(findings, presentation.log)

  if (existing) {
    presentation.log(
      `refusing settings import: a settings row already exists for ${targetLabel(target)}\n` +
        settingsImportRemedy(target),
    )
    presentation.exitCode(1)
    return
  }
  if (flags.has('dry-run')) {
    presentation.log(`would import settings for ${targetLabel(target)}`)
    return
  }
  await setDoc({
    scope: SETTINGS_SCOPE,
    subject: target.kind === 'project' ? target.name : null,
    owner,
    slug: SETTINGS_SLUG,
    title: SETTINGS_SLUG,
    body: serializeOwnedSettings(parsed.owned),
    delivery: 'demand',
    reason: 'imported from Claude settings',
  })
  presentation.log(`imported settings for ${targetLabel(target)}`)
}

export async function settingsRenderCheckCommand(
  flags: SettingsFlags,
  presentation: SettingsPresentation,
): Promise<void> {
  const target = resolveSettingsTarget(flags)
  const owner = target.kind === 'user' ? await signedInDocOwner() : null
  const cwd = presentation.cwd()
  const path = settingsFilePath(target, process.env, cwd)
  const parsed = flags.has('json') ? tryReadSettingsFile(path) : readSettingsFile(path)
  const existing = settingsRow(target, owner)
  const storeOwned = effectiveStoredSettings(target, existing?.body)
  if (
    target.kind === 'project' &&
    ((storeOwned.envKeys?.length ?? 0) > 0 || Object.keys(storeOwned.env ?? {}).length > 0)
  ) {
    throw new Error(
      'refusing settings render: env is user-only; remove project env and envKeys from the row',
    )
  }
  const environment =
    target.kind === 'user'
      ? selectedSettingsEnvironment(
          userSettingsEnvPath(claudeHomeFromEnvironment(process.env)),
          storeOwned.envKeys ?? [],
        )
      : undefined
  const renderedEnvironment =
    environment === undefined ? undefined : renderedSettingsEnvironment(storeOwned, environment)
  if (parsed) renderOwnedSettingsFile(parsed.text, storeOwned, renderedEnvironment)
  const fileOwned = parsed
    ? target.kind === 'user'
      ? settingsFileOwnedSettings(parsed, storeOwned)
      : parsed.owned
    : emptyOwned()
  const drift = diffOwnedSettings(fileOwned, storeOwned)
  const drifted = !ownedSettingsEqual(fileOwned, storeOwned)
  const findings = lintSettings(lintTargets(target, parsed?.owned ?? emptyOwned(), cwd))
  if (flags.has('json')) {
    presentation.log(
      JSON.stringify({
        target,
        file: { path, exists: parsed !== null },
        revision: existing?.revision ?? null,
        settings: summarizeSettings(storeOwned),
        drift: redactedDrift(drift, fileOwned, storeOwned),
        findings: findings.map((finding) => ({
          ...finding,
          message: containsSecretShaped(finding.message)
            ? displaySettingsValue(finding.file, finding.message)
            : finding.message,
        })),
      }),
    )
    if (drifted || !existing) presentation.exitCode(1)
    return
  }
  logDrift(fileOwned, storeOwned, drift, presentation.log)
  printFindings(findings, presentation.log)
  if (!existing) {
    presentation.log(`no settings row for ${targetLabel(target)}`)
  }
  if (drifted || !existing) presentation.exitCode(1)
}

function effectiveStoredSettings(
  target: SettingsTargetKind,
  body: string | undefined,
): OwnedSettings {
  if (!body) return emptyOwned()
  const hosted = parseStoreOwned(body)
  if (target.kind === 'project') return hosted
  const merged = mergeMachinePermissionOverlay(hosted, readMachinePermissions()).settings
  return withMachineProductHooks(merged, assetPath(), resolveOrchestratorDatabase(process.env))
    .settings
}

function redactedDrift(drift: SettingsDrift, file: OwnedSettings, store: OwnedSettings) {
  return {
    rules: Object.fromEntries(
      PERMISSION_LISTS.map((name) => [
        name,
        {
          added: drift.rules[name].added.map((rule) => displayRule(name, rule, file)),
          removed: drift.rules[name].removed.map((rule) => displayRule(name, rule, store)),
        },
      ]),
    ),
    autoMode: Object.fromEntries(
      AUTO_MODE_LISTS.map((name) => [
        name,
        {
          added: drift.autoMode[name].added.map((rule) => displayAutoModeRule(name, rule, file)),
          removed: drift.autoMode[name].removed.map((rule) =>
            displayAutoModeRule(name, rule, store),
          ),
        },
      ]),
    ),
    hooks: {
      added: drift.hooks.added.map(({ event, matcher, fingerprint, path }) => ({
        event: displayHookDrift({ event, matcher, fingerprint, path }, file).includes(
          ' secret-shaped',
        )
          ? path
          : event,
        matcher: displayHookDrift({ event, matcher, fingerprint, path }, file).includes(
          ' secret-shaped',
        )
          ? 'secret-shaped'
          : matcher,
        fingerprint,
      })),
      removed: drift.hooks.removed.map(({ event, matcher, fingerprint, path }) => ({
        event: displayHookDrift({ event, matcher, fingerprint, path }, store).includes(
          ' secret-shaped',
        )
          ? path
          : event,
        matcher: displayHookDrift({ event, matcher, fingerprint, path }, store).includes(
          ' secret-shaped',
        )
          ? 'secret-shaped'
          : matcher,
        fingerprint,
      })),
    },
    envKeys: drift.env,
  }
}

function settingsRow(target: SettingsTargetKind, owner: string | null) {
  return getDoc(
    SETTINGS_SCOPE,
    target.kind === 'project' ? target.name : null,
    SETTINGS_SLUG,
    owner,
  )
}

function parseStoreOwned(body: string): OwnedSettings {
  return parseStoredOwnedSettings(body)
}

function emptyOwned(): OwnedSettings {
  return { permissions: {}, hooks: {} }
}

function lintTargets(
  target: SettingsTargetKind,
  owned: OwnedSettings,
  cwd: string,
): SettingsTarget[] {
  const current: SettingsTarget = { id: targetLabel(target), settings: owned }
  if (target.kind === 'user') {
    return [
      current,
      ...managedProjects().flatMap((project) => {
        const parsed = tryReadSettingsFile(projectSettingsPath(projectRoot(project.name, cwd)))
        return parsed ? [{ id: project.name, settings: parsed.owned }] : []
      }),
    ]
  }
  const userFile = tryReadSettingsFile(userSettingsPath(claudeHomeFromEnvironment(process.env)))
  return [{ id: 'user', settings: userFile ? userFile.owned : emptyOwned() }, current]
}

function managedProjects() {
  return projects().filter((project) => project.settings.managedContext === true)
}

function projectRoot(name: string, cwd: string): string {
  const project = projectByName(name)
  if (!project) throw new Error(`unknown project "${name}"`)
  if (project.settings.managedContext !== true) {
    throw new Error(
      `refusing settings: project ${name} does not have managedContext on\n` +
        'cleared by: set managedContext true on the project register row',
    )
  }
  const at = projectAt(cwd)
  return at?.name === name ? cwd : project.path
}

function targetLabel(target: SettingsTargetKind): string {
  return target.kind === 'user' ? 'user' : target.name
}

function settingsImportRemedy(target: SettingsTargetKind): string {
  return target.kind === 'user'
    ? `cleared by: ${PLATFORM_SLUG} doc set --scope settings --user --slug settings`
    : `cleared by: ${PLATFORM_SLUG} doc set --scope settings --subject ${target.name} --slug settings`
}

function logOwnedCounts(owned: OwnedSettings, log: (...values: unknown[]) => void): void {
  const lists = permissionLists(owned.permissions)
  for (const name of PERMISSION_LISTS) log(`permissions.${name}: ${lists[name].length}`)
  log(`hooks: ${hookCount(owned.hooks)}`)
}

function hookCount(hooks: unknown): number {
  if (!isPlainObject(hooks)) return 0
  return Object.values(hooks).reduce<number>(
    (count, value) => count + (Array.isArray(value) ? value.length : 0),
    0,
  )
}

function logAdoption(
  adoption: ReturnType<typeof adoptionCandidates>,
  log: (...values: unknown[]) => void,
): void {
  log('adoption')
  for (const name of PERMISSION_LISTS) {
    const rows = adoption[name]
    const present = rows.filter((row) => row.inStore).length
    log(`  ${name}: ${rows.length} (${present} already in store)`)
    for (const [index, row] of rows.entries()) {
      log(
        `    ${row.inStore ? 'present  ' : 'new      '}${displaySettingsValue(`permissions.${name}[${index}]`, row.rule)}`,
      )
    }
  }
}

function logDrift(
  file: OwnedSettings,
  store: OwnedSettings,
  drift: SettingsDrift,
  log: (...values: unknown[]) => void,
): void {
  if (ownedSettingsEqual(file, store)) {
    log('drift: none')
    return
  }
  log('drift')
  let listed = 0
  for (const name of PERMISSION_LISTS) {
    for (const rule of drift.rules[name].added) {
      log(`  added ${name} ${displayRule(name, rule, file)}`)
      listed++
    }
    for (const rule of drift.rules[name].removed) {
      log(`  removed ${name} ${displayRule(name, rule, store)}`)
      listed++
    }
  }
  listed += logAutoModeDrift(drift, file, store, log)
  for (const hook of drift.hooks.added) {
    log(`  added hook ${displayHookDrift(hook, file)}`)
    listed++
  }
  for (const hook of drift.hooks.removed) {
    log(`  removed hook ${displayHookDrift(hook, store)}`)
    listed++
  }
  for (const name of drift.env.added) {
    log(`  added env key ${name}`)
    listed++
  }
  for (const name of drift.env.removed) {
    log(`  removed env key ${name}`)
    listed++
  }
  for (const name of drift.env.changed) {
    log(`  changed plain env value ${name}`)
    listed++
  }
  if (listed === 0) log('  owned settings structure differs')
}

function logAutoModeDrift(
  drift: SettingsDrift,
  file: OwnedSettings,
  store: OwnedSettings,
  log: (...values: unknown[]) => void,
): number {
  let listed = 0
  for (const name of AUTO_MODE_LISTS) {
    for (const rule of drift.autoMode[name].added) {
      log(`  added autoMode.${name} ${displayAutoModeRule(name, rule, file)}`)
      listed++
    }
    for (const rule of drift.autoMode[name].removed) {
      log(`  removed autoMode.${name} ${displayAutoModeRule(name, rule, store)}`)
      listed++
    }
  }
  return listed
}

function displayRule(list: (typeof PERMISSION_LISTS)[number], rule: string, owned: OwnedSettings) {
  const index = permissionLists(owned.permissions)[list].indexOf(rule)
  return displaySettingsValue(`permissions.${list}[${index}]`, rule)
}

function displayAutoModeRule(
  list: (typeof AUTO_MODE_LISTS)[number],
  rule: string,
  owned: OwnedSettings,
) {
  const index = autoModeLists(owned.autoMode)[list].indexOf(rule)
  return displaySettingsValue(`autoMode.${list}[${index}]`, rule)
}

function printFindings(findings: Finding[], log: (...values: unknown[]) => void): void {
  if (!findings.length) {
    log('findings: none')
    return
  }
  const grouped = Map.groupBy(findings, (finding) => finding.rule)
  log('findings')
  for (const [rule, rows] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    log(`  ${rule} (${rows.length})`)
    for (const finding of rows) {
      const message = containsSecretShaped(finding.message)
        ? displaySettingsValue(finding.file, finding.message)
        : finding.message
      log(`    ${finding.file}:${finding.line}  ${message}`)
    }
  }
}
