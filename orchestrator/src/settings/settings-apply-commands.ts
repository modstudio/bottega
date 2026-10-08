// concern: settings-apply-commands
/** Knows env import, adoption, guarded render writes, and restore command semantics. */
import { realpathSync } from 'node:fs'
import { gitToplevel } from '../../../shared/git.ts'
import { assetPath } from '../../../shared/install-root.ts'
import { readMachinePermissions } from '../../../shared/machine-config.ts'
import { resolveOrchestratorDatabase } from '../../../shared/state-directory.ts'
import { getDoc, setDoc, signedInDocOwner } from '../doc/docs.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { isOrchWorkerProcess } from '../run/run-process.ts'
import {
  isPlainObject,
  type OwnedSettings,
  PERMISSION_LISTS,
  parseStoredOwnedSettings,
  permissionLists,
  SETTINGS_SCOPE,
  SETTINGS_SLUG,
  serializeOwnedSettings,
} from './settings.ts'
import {
  mergeSettingsEnv,
  readSettingsEnv,
  selectedSettingsEnvironment,
  settingsEnvironmentFromJson,
  userSettingsEnvPath,
} from './settings-env.ts'
import {
  claudeHomeFromEnvironment,
  projectLocalSettingsPath,
  projectSettingsPath,
  readLocalPermissionLists,
  readSettingsFile,
  userLocalSettingsPath,
  userSettingsPath,
} from './settings-files.ts'
import { withMachineProductHooks } from './settings-machine-hooks.ts'
import { mergeMachinePermissionOverlay } from './settings-permission-overlay.ts'
import { displaySettingsValue, renderOwnedSettingsFile } from './settings-render.ts'
import { applySettingsWrite, planSettingsWrite, restoreSettingsBackup } from './settings-write.ts'

type Flags = {
  has(name: string): boolean
  flag(name: string): string | undefined
  values?(name: string): string[]
}
type Presentation = {
  log(...values: unknown[]): void
  exitCode(code: number): void
  cwd(): string
}
type Target = { kind: 'user' } | { kind: 'project'; name: string }

function withProductHooksForTarget(target: Target, settings: OwnedSettings): OwnedSettings {
  if (target.kind === 'project') return settings
  return withMachineProductHooks(settings, assetPath(), resolveOrchestratorDatabase(process.env))
    .settings
}

export async function settingsEnvImportCommand(
  flags: Flags,
  presentation: Presentation,
): Promise<void> {
  if (flags.has('project')) {
    throw new Error(
      'refusing settings env import: project settings are tracked in git\n' +
        'cleared by: use --user for secrets-file env import',
    )
  }
  if (!flags.has('user')) throw new Error('refusing settings env import: pass --user')
  const owner = await signedInDocOwner()
  const row = getDoc(SETTINGS_SCOPE, null, SETTINGS_SLUG, owner)
  if (!row) throw new Error('refusing settings env import: no user settings row')
  const home = claudeHomeFromEnvironment(process.env)
  const settingsPath = userSettingsPath(home)
  const secretsPath = userSettingsEnvPath(home)
  const imported = settingsEnvironmentFromJson(settingsPath)
  const result = mergeSettingsEnv(secretsPath, imported, flags.has('dry-run'))
  presentation.log(
    `env keys: ${result.names.length}${result.names.length ? ` ${result.names.join(', ')}` : ''}`,
  )
  presentation.log(`new: ${result.added}; already present: ${result.present}`)
  if (flags.has('dry-run')) {
    presentation.log('dry-run: settings.env and the settings row were not changed')
    return
  }
  const owned = parseStoredOwnedSettings(row.body)
  owned.envKeys = result.names
  await writeOwned(
    targetAddress({ kind: 'user' }, owner),
    owned,
    'imported env key names',
    row.revision!,
  )
  presentation.log(`imported ${result.names.length} env key names`)
}

export async function settingsAdoptCommand(
  flags: Flags,
  requestedRules: string[],
  presentation: Presentation,
): Promise<void> {
  const target = resolveTarget(flags)
  const owner = target.kind === 'user' ? await signedInDocOwner() : null
  const row = settingsRow(target, owner)
  if (!row) throw new Error(`refusing settings adopt: no settings row for ${targetLabel(target)}`)
  if (flags.has('all') === requestedRules.length > 0) {
    throw new Error('refusing settings adopt: pass either --all or one or more rules')
  }
  const root = targetRoot(target, presentation.cwd())
  const localPath =
    target.kind === 'user'
      ? userLocalSettingsPath(claudeHomeFromEnvironment(process.env))
      : projectLocalSettingsPath(root)
  const local = readLocalPermissionLists(localPath)
  const selected = new Set(
    flags.has('all') ? PERMISSION_LISTS.flatMap((name) => local[name]) : requestedRules,
  )
  if (!flags.has('all')) {
    const candidates = new Set(PERMISSION_LISTS.flatMap((name) => local[name]))
    const unknown = [...selected].filter((rule) => !candidates.has(rule))
    if (unknown.length) throw new Error(`refusing settings adopt: rule is not in ${localPath}`)
  }
  const owned = parseStoredOwnedSettings(row.body)
  const adopted = adoptPermissionRules(owned, local, selected)
  await writeOwned(
    targetAddress(target, owner),
    owned,
    'adopted local permission grants',
    row.revision!,
  )
  presentation.log(`adopted: ${adopted.length}`)
  for (const [index, item] of adopted.entries()) {
    presentation.log(
      `  ${item.list} ${displaySettingsValue(`permissions.${item.list}[${index}]`, item.rule)}`,
    )
  }
}

function adoptPermissionRules(
  owned: OwnedSettings,
  local: Record<(typeof PERMISSION_LISTS)[number], string[]>,
  selected: Set<string>,
): { list: (typeof PERMISSION_LISTS)[number]; rule: string }[] {
  const current = permissionLists(owned.permissions)
  const permissions = isPlainObject(owned.permissions) ? { ...owned.permissions } : {}
  const adopted: { list: (typeof PERMISSION_LISTS)[number]; rule: string }[] = []
  for (const name of PERMISSION_LISTS) {
    const next = [...current[name]]
    for (const rule of local[name]) {
      if (!selected.has(rule) || next.includes(rule)) continue
      next.push(rule)
      adopted.push({ list: name, rule })
    }
    if (Object.hasOwn(permissions, name) || next.length > 0) permissions[name] = next
  }
  owned.permissions = permissions
  return adopted
}

export async function settingsRenderWriteCommand(
  flags: Flags,
  presentation: Presentation,
  workerProcess = () => isOrchWorkerProcess(process.env, process.pid),
): Promise<void> {
  if (workerProcess()) {
    throw new Error(
      'refusing settings render --write from an orch worker run; an operator must run orch settings render --write',
    )
  }
  const target = resolveTarget(flags)
  const owner = target.kind === 'user' ? await signedInDocOwner() : null
  const row = settingsRow(target, owner)
  if (!row) throw new Error(`refusing settings render: no settings row for ${targetLabel(target)}`)
  const root = targetRoot(target, presentation.cwd())
  if (
    target.kind === 'project' &&
    realpathSync(root) === realpathSync(projectByName(target.name)!.path)
  ) {
    throw new Error(
      `refusing settings write in registered main checkout ${root}\n` +
        'invariant: project settings writes happen in a disposable worktree\n' +
        'cleared by: run in a worktree, commit the settings change, and land it by pull request',
    )
  }
  const path = target.kind === 'user' ? userSettingsPath(root) : projectSettingsPath(root)
  const parsed = readSettingsFile(path)
  const hosted = parseStoredOwnedSettings(row.body)
  const merged =
    target.kind === 'user'
      ? mergeMachinePermissionOverlay(hosted, readMachinePermissions()).settings
      : hosted
  const owned = withProductHooksForTarget(target, merged)
  const droppedEnv = flags.values?.('drop-env') ?? []
  if (target.kind === 'project' && droppedEnv.length > 0) {
    throw new Error('refusing settings render: --drop-env is user-only')
  }
  if (target.kind === 'user') {
    const secretsPath = userSettingsEnvPath(root)
    const secrets = readSettingsEnv(secretsPath)
    const removed = parsed.envKeys.filter((name) => !(owned.envKeys ?? []).includes(name))
    const unprotected = removed.filter((name) => !secrets.has(name) && !droppedEnv.includes(name))
    if (unprotected.length > 0) {
      throw new Error(
        `refusing settings write: env key(s) exist only in ${path}: ${unprotected.join(', ')}\n` +
          'cleared by: run `orch settings env import --user` first, or pass ' +
          unprotected.map((name) => `--drop-env ${name}`).join(' ') +
          ' to drop deliberately',
      )
    }
  }
  const environment =
    target.kind === 'user'
      ? selectedSettingsEnvironment(userSettingsEnvPath(root), owned.envKeys ?? [])
      : undefined
  const rendered = renderOwnedSettingsFile(parsed.text, owned, environment)
  const plan = planSettingsWrite(path, rendered)
  logWritePlan(
    target,
    path,
    owned,
    parsed.envKeys,
    plan.currentText !== plan.renderedText,
    presentation.log,
  )
  if (!flags.has('yes')) {
    presentation.log('refusing settings write without --yes; no file was changed')
    presentation.exitCode(1)
    return
  }
  const result = applySettingsWrite(plan, process.env)
  if (!result.written) {
    presentation.log(`unchanged ${path}; no backup written`)
    return
  }
  presentation.log(`backup: ${result.backup}`)
  presentation.log(`wrote ${path}`)
}

export function settingsRestoreCommand(
  flags: Flags,
  backup: string,
  presentation: Presentation,
): void {
  if (!flags.has('user') || flags.has('project')) {
    throw new Error('refusing settings restore: pass --user <backup>')
  }
  const target = userSettingsPath(claudeHomeFromEnvironment(process.env))
  restoreSettingsBackup(target, backup, process.env, flags.has('force'))
  presentation.log(`restored ${target} from ${backup}`)
}

function resolveTarget(flags: Flags): Target {
  const user = flags.has('user')
  const project = flags.flag('project')
  if (user === Boolean(project))
    throw new Error('refusing settings: pass --user or --project <name>')
  return user ? { kind: 'user' } : { kind: 'project', name: project! }
}

function targetRoot(target: Target, cwd: string): string {
  if (target.kind === 'user') return claudeHomeFromEnvironment(process.env)
  const project = projectByName(target.name)
  if (!project) throw new Error(`unknown project "${target.name}"`)
  if (project.settings.managedContext !== true) {
    throw new Error(`refusing settings: project ${target.name} does not have managedContext on`)
  }
  if (projectAt(cwd)?.name !== target.name) return project.path
  if (realpathSync(cwd) === realpathSync(project.path)) return project.path
  const root = gitToplevel(cwd)
  if (!root) throw new Error(`refusing settings: cannot find the worktree root from ${cwd}`)
  return root
}

function settingsRow(target: Target, owner: string | null) {
  const address = targetAddress(target, owner)
  return getDoc(SETTINGS_SCOPE, address.subject, SETTINGS_SLUG, address.owner)
}

function targetAddress(target: Target, owner: string | null) {
  return { subject: target.kind === 'project' ? target.name : null, owner }
}

async function writeOwned(
  address: { subject: string | null; owner: string | null },
  owned: OwnedSettings,
  reason: string,
  expectedRevision: string,
): Promise<void> {
  await setDoc({
    scope: SETTINGS_SCOPE,
    subject: address.subject,
    owner: address.owner,
    slug: SETTINGS_SLUG,
    title: SETTINGS_SLUG,
    body: serializeOwnedSettings(owned),
    delivery: 'demand',
    reason,
    expectedRevision,
  })
}

function logWritePlan(
  target: Target,
  path: string,
  owned: OwnedSettings,
  fileEnvKeys: string[],
  changed: boolean,
  log: (...values: unknown[]) => void,
): void {
  const lists = permissionLists(owned.permissions)
  log(`plan ${targetLabel(target)} ${path}`)
  for (const name of PERMISSION_LISTS) log(`permissions.${name}: ${lists[name].length}`)
  log(`hooks: ${hookCount(owned.hooks)}`)
  if (target.kind === 'user') {
    const names = owned.envKeys ?? []
    log(`env keys: ${names.length}${names.length ? ` ${names.join(', ')}` : ''}`)
    const removed = fileEnvKeys.filter((name) => !names.includes(name))
    if (removed.length) log(`env keys removed: ${removed.length} ${removed.join(', ')}`)
  }
  log(`changed: ${changed ? 'yes' : 'no'}`)
}

function hookCount(hooks: unknown): number {
  if (!isPlainObject(hooks)) return 0
  return Object.values(hooks).reduce<number>(
    (count, value) => count + (Array.isArray(value) ? value.length : 0),
    0,
  )
}

function targetLabel(target: Target): string {
  return target.kind === 'user' ? 'user' : target.name
}
