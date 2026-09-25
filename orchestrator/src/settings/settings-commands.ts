// concern: settings-commands
/** Knows settings import and render --check command semantics. Must not know runs, routing, transports, the CLI, or worktrees. */
import type { Finding } from '../../../shared/ratchet.ts'
import { getDoc, setDoc, signedInDocOwner } from '../doc/docs.ts'
import { projectAt, projectByName, projects } from '../project/projects.ts'
import {
  containsSecretShaped,
  isPlainObject,
  type OwnedSettings,
  ownedSettingsEqual,
  PERMISSION_LISTS,
  permissionLists,
  SETTINGS_SCOPE,
  SETTINGS_SLUG,
  serializeOwnedSettings,
} from './settings.ts'
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
import {
  diffOwnedSettings,
  displayHookDrift,
  displaySettingsValue,
  renderOwnedSettingsFile,
  type SettingsDrift,
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
  const parsed = readSettingsFile(path)
  const existing = settingsRow(target, owner)
  const storeOwned = existing ? parseStoreOwned(existing.body) : emptyOwned()
  renderOwnedSettingsFile(parsed.text, storeOwned)
  const drifted = !ownedSettingsEqual(parsed.owned, storeOwned)
  const findings = lintSettings(lintTargets(target, parsed.owned, cwd))
  logDrift(parsed.owned, storeOwned, presentation.log)
  printFindings(findings, presentation.log)
  if (!existing) {
    presentation.log(`no settings row for ${targetLabel(target)}`)
  }
  if (drifted || !existing) presentation.exitCode(1)
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
  try {
    return JSON.parse(body) as OwnedSettings
  } catch {
    return emptyOwned()
  }
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
    ? 'cleared by: orch doc set --scope settings --user --slug settings'
    : `cleared by: orch doc set --scope settings --subject ${target.name} --slug settings`
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
  log: (...values: unknown[]) => void,
): void {
  if (ownedSettingsEqual(file, store)) {
    log('drift: none')
    return
  }
  const drift: SettingsDrift = diffOwnedSettings(file, store)
  log('drift')
  for (const name of PERMISSION_LISTS) {
    for (const rule of drift.rules[name].added) {
      log(`  added ${name} ${displayRule(name, rule, file)}`)
    }
    for (const rule of drift.rules[name].removed) {
      log(`  removed ${name} ${displayRule(name, rule, store)}`)
    }
  }
  for (const hook of drift.hooks.added) log(`  added hook ${displayHookDrift(hook, file)}`)
  for (const hook of drift.hooks.removed) log(`  removed hook ${displayHookDrift(hook, store)}`)
}

function displayRule(list: (typeof PERMISSION_LISTS)[number], rule: string, owned: OwnedSettings) {
  const index = permissionLists(owned.permissions)[list].indexOf(rule)
  return displaySettingsValue(`permissions.${list}[${index}]`, rule)
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
