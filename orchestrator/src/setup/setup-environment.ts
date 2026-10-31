// concern: setup environment migration
/** Decides and applies the one-time operator environment-name migration. */

import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { ConfigClientError } from '../../../shared/config-client.ts'
import { resolveEnvFilePaths } from '../../../shared/config-directory.ts'
import type { SecretEnvironmentMigration } from '../config/config-service.ts'
import {
  legacyEnvironmentNameMatches,
  replacementEnvironmentName,
} from './environment-name-migration.ts'
import {
  decideStateFileMove,
  defaultStateFilePair,
  renameStateFiles,
  type StateFileHolderObservation,
  type StateFileMoveDecision,
  type StateFileNamePair,
} from './setup-state-file.ts'

const ENVIRONMENT_FILES = [
  '.zshenv',
  '.zprofile',
  '.zshrc',
  '.bashrc',
  '.bash_profile',
  '.profile',
  join('.claude', '.env'),
] as const

type Assignment = { name: string; line: number; start: number; end: number }
type LocatedAssignment = Assignment & { path: string }

export type EnvironmentFileDecision =
  | { kind: 'unchanged' }
  | { kind: 'replace'; text: string; names: string[] }
  | { kind: 'refuse'; oldName: string; oldLine: number; newName: string; newLine: number }
  | { kind: 'refuse-residue'; name: string; line: number }

export type EnvironmentMigrationReport = {
  processNamesRenamed: number
  files: Array<{ path: string; names: string[]; backup: string }>
  secrets: SecretEnvironmentMigration[]
  register: Array<{ project: string; names: string[] }>
  settings: Array<{ oldName: string; newName: string }>
  followUps: Array<{ path: string; command: string; names: string[] }>
  backupDirectory: string | null
  restoreCommand: string | null
  notes: string[]
  stateFile: StateFileNamePair | null
}

export type EnvironmentSettingsDecision = {
  value: unknown
  names: string[]
}

function migratedEnvironmentText(text: string, names: Set<string>): string {
  let migrated = text
  for (const match of legacyEnvironmentNameMatches(text).toReversed()) {
    migrated = `${migrated.slice(0, match.index)}${match.replacement}${migrated.slice(match.index + match.name.length)}`
    names.add(match.replacement)
  }
  return migrated
}

/** Rewrite inventoried environment tokens in arbitrary project settings plain values. */
export function environmentSettingsDecision(value: unknown): EnvironmentSettingsDecision {
  const names = new Set<string>()
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return migratedEnvironmentText(item, names)
    if (Array.isArray(item)) return item.map(visit)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, visit(nested)]))
  }
  return { value: visit(value), names: [...names].sort() }
}

function assignments(text: string): Assignment[] {
  const found: Assignment[] = []
  const lines = text.split(/(?<=\n)/)
  let offset = 0
  for (const [index, line] of lines.entries()) {
    const match = /^(?:[ \t]*export[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*=/.exec(line)
    if (match?.[1]) {
      const nameOffset = match.index + match[0].indexOf(match[1])
      found.push({
        name: match[1],
        line: index + 1,
        start: offset + nameOffset,
        end: offset + nameOffset + match[1].length,
      })
    }
    offset += line.length
  }
  return found
}

function firstLegacyResidue(text: string): { name: string; line: number } | null {
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = legacyEnvironmentNameMatches(line)[0]
    if (match) return { name: match.name, line: index + 1 }
  }
  return null
}

function convergingAssignment(
  first: Assignment,
  candidate: Assignment,
  replacement: string,
): boolean {
  return (
    candidate !== first &&
    (candidate.name === replacement ||
      (candidate.name !== first.name && replacementEnvironmentName(candidate.name) === replacement))
  )
}

/** Decide the complete file rewrite without filesystem, process, or secret access. */
export function environmentFileDecision(text: string): EnvironmentFileDecision {
  const found = assignments(text)
  const replacements = found.flatMap((assignment) => {
    const name = replacementEnvironmentName(assignment.name)
    return name ? [{ assignment, name }] : []
  })
  for (const replacement of replacements) {
    const conflict = found.find((assignment) =>
      convergingAssignment(replacement.assignment, assignment, replacement.name),
    )
    if (conflict) {
      return {
        kind: 'refuse',
        oldName: replacement.assignment.name,
        oldLine: replacement.assignment.line,
        newName: replacement.name,
        newLine: conflict.line,
      }
    }
  }
  let migrated = text
  for (const replacement of replacements.toReversed()) {
    const { start, end } = replacement.assignment
    migrated = `${migrated.slice(0, start)}${replacement.name}${migrated.slice(end)}`
  }
  const residue = firstLegacyResidue(migrated)
  if (residue) return { kind: 'refuse-residue', ...residue }
  if (replacements.length === 0) return { kind: 'unchanged' }
  return {
    kind: 'replace',
    text: migrated,
    names: [...new Set(replacements.map(({ name }) => name))].sort(),
  }
}

export type EnvironmentFilesDecision =
  | { kind: 'replace'; files: Array<{ path: string; decision: EnvironmentFileDecision }> }
  | { kind: 'refuse'; first: LocatedAssignment; second: LocatedAssignment; newName: string }
  | { kind: 'refuse-residue'; path: string; name: string; line: number }

/** Decide the complete multi-file migration before any adapter writes a file. */
export function environmentFilesDecision(
  files: ReadonlyArray<{ path: string; text: string }>,
): EnvironmentFilesDecision {
  const located = files.flatMap(({ path, text }) =>
    assignments(text).map((item) => ({ ...item, path })),
  )
  for (const first of located) {
    const newName = replacementEnvironmentName(first.name)
    if (!newName) continue
    const second = located.find((candidate) => convergingAssignment(first, candidate, newName))
    if (second) return { kind: 'refuse', first, second, newName }
  }
  const decisions = files.map(({ path, text }) => ({
    path,
    decision: environmentFileDecision(text),
  }))
  const residue = decisions.find(({ decision }) => decision.kind === 'refuse-residue')
  if (residue && residue.decision.kind === 'refuse-residue') {
    return {
      kind: 'refuse-residue',
      path: residue.path,
      name: residue.decision.name,
      line: residue.decision.line,
    }
  }
  return { kind: 'replace', files: decisions }
}

export type InstalledPlistOwner = { label: string; command: string }

const LAUNCHD_TEMPLATE_OWNERS = [
  { concern: 'hub', directory: 'launchd', command: 'hub/bin/install-launchd.sh' },
  { concern: 'ops', directory: 'launchd', command: 'ops/install.sh' },
] as const

/** Derive every installed label and its owning installer from template paths. */
export function installedPlistOwners(
  templates: ReadonlyArray<{ path: string; text: string }>,
): InstalledPlistOwner[] {
  return templates
    .filter(({ path }) => path.endsWith('.plist.template'))
    .map(({ path, text }) => {
      const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1]
      if (!label) throw new Error(`launchd template ${path} has no Label`)
      const concern = basename(dirname(dirname(path)))
      const owner = LAUNCHD_TEMPLATE_OWNERS.find((candidate) => candidate.concern === concern)
      if (!owner) throw new Error(`launchd template ${path} has unknown concern ${concern}`)
      return {
        label,
        command: owner.command,
      }
    })
    .sort((left, right) => left.label.localeCompare(right.label))
}

/** Report only inventoried old names carried by an installed plist. */
export function staleInstalledPlistEnvironmentNames(text: string): string[] {
  return [...new Set(legacyEnvironmentNameMatches(text).map(({ name }) => name))]
}

async function existing(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function atomicModePreservingWrite(path: string, text: string, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.${PLATFORM_SLUG}-env-${crypto.randomUUID()}.tmp`)
  const permissions = mode & 0o7777
  try {
    const handle = await open(temporary, 'wx', permissions)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.chmod(permissions)
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export async function installationPlistOwners(): Promise<InstalledPlistOwner[]> {
  const root = resolve(import.meta.dir, '../../..')
  const templates: Array<{ path: string; text: string }> = []
  for (const owner of LAUNCHD_TEMPLATE_OWNERS) {
    const directory = join(root, owner.concern, owner.directory)
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.plist.template')) continue
      const path = join(directory, name)
      templates.push({ path, text: await readFile(path, 'utf8') })
    }
  }
  return installedPlistOwners(templates)
}

async function staleInstalledPlists(
  home: string,
): Promise<Array<{ path: string; command: string; names: string[] }>> {
  const stale: Array<{ path: string; command: string; names: string[] }> = []
  for (const { label, command } of await installationPlistOwners()) {
    const path = join(home, 'Library', 'LaunchAgents', `${label}.plist`)
    if (!(await existing(path))) continue
    const names = staleInstalledPlistEnvironmentNames(await readFile(path, 'utf8'))
    if (names.length) stale.push({ path, command, names })
  }
  return stale
}

type EnvironmentSource = { path: string; text: string; mode: number }

async function environmentSources(home: string): Promise<EnvironmentSource[]> {
  const configured = resolveEnvFilePaths({ ...process.env, HOME: home })
  const candidates = [
    ...ENVIRONMENT_FILES.map((relative) => join(home, relative)),
    join(home, '.claude', 'settings.env'),
    ...configured,
  ]
  const sources: EnvironmentSource[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!(await existing(candidate))) continue
    const path = await realpath(candidate)
    if (seen.has(path)) continue
    seen.add(path)
    sources.push({ path, text: await readFile(path, 'utf8'), mode: (await stat(path)).mode })
  }
  return sources
}

type EnvironmentBackupManifest = {
  version: 1
  files: Array<
    { path: string; existed: true; backup: string; mode: number } | { path: string; existed: false }
  >
  register: unknown[]
  secrets: SecretEnvironmentMigration[]
  settings: Array<{ oldName: string; newName: string }>
  stateFile?: StateFileNamePair
}

export type PreparedStateFileMigration = {
  directory: string
  manifest: EnvironmentBackupManifest
}

async function createModeRestrictedCopy(
  source: string,
  destination: string,
  mode: number,
): Promise<void> {
  const handle = await open(destination, 'wx', mode & 0o7777)
  try {
    await handle.writeFile(await readFile(source))
    await handle.chmod(mode & 0o7777)
  } catch (error) {
    await handle.close()
    await rm(destination, { force: true })
    throw error
  }
  await handle.close()
}

async function atomicModeRestrictedCopy(
  source: string,
  destination: string,
  mode: number,
): Promise<void> {
  const temporary = join(
    dirname(destination),
    `.${PLATFORM_SLUG}-restore-${crypto.randomUUID()}.tmp`,
  )
  try {
    await createModeRestrictedCopy(source, temporary, mode)
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function createMigrationBackup(
  backupRoot: string,
  paths: readonly string[],
  register: unknown[],
): Promise<{ directory: string; manifest: EnvironmentBackupManifest }> {
  const root = join(backupRoot, 'setup-environment-backups')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = join(
    root,
    `${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID()}`,
  )
  await mkdir(directory, { mode: 0o700 })
  const manifest: EnvironmentBackupManifest = {
    version: 1,
    files: [],
    register,
    secrets: [],
    settings: [],
  }
  await appendBackupFiles(directory, manifest, paths)
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  })
  return { directory, manifest }
}

async function appendBackupFiles(
  directory: string,
  manifest: EnvironmentBackupManifest,
  paths: readonly string[],
): Promise<void> {
  const known = new Set(manifest.files.map(({ path }) => path))
  for (const path of [...new Set(paths)]) {
    if (known.has(path)) continue
    if (!(await existing(path))) {
      manifest.files.push({ path, existed: false })
      continue
    }
    const backup = `${manifest.files.length}.file`
    const mode = (await stat(path)).mode & 0o7777
    await createModeRestrictedCopy(path, join(directory, backup), mode)
    manifest.files.push({ path, existed: true, backup, mode })
  }
}

/** Move the default store before setup planning can open it, retaining a restore manifest. */
export async function prepareStateFileMigration(
  env: NodeJS.ProcessEnv,
  holders?: (paths: string[]) => StateFileHolderObservation,
  authorizeRename?: () => void,
): Promise<PreparedStateFileMigration | null> {
  const pair = defaultStateFilePair(env)
  if (!pair) return null
  const decision = await decideStateFileMove(pair, holders)
  if (decision.kind === 'refuse') throw new Error(decision.reason)
  if (decision.kind !== 'move') return null
  authorizeRename?.()
  const backup = await createMigrationBackup(dirname(pair.newPath), [], [])
  backup.manifest.stateFile = pair
  await writeFile(
    join(backup.directory, 'manifest.json'),
    `${JSON.stringify(backup.manifest, null, 2)}\n`,
    { mode: 0o600 },
  )
  await renameStateFiles(pair, decision.suffixes)
  return backup
}

/** Reverse a prepared move when setup stops before any planned action begins. */
export async function reversePreparedStateFileMigration(
  prepared: PreparedStateFileMigration,
  adapters: {
    authorizeStateFileRename?: () => void
    checkpointAndCloseStore?: () => Promise<void> | void
    stateFileHolders?: (paths: string[]) => StateFileHolderObservation
  } = {},
): Promise<string> {
  const pair = prepared.manifest.stateFile
  if (!pair)
    throw new Error(`prepared state-file backup has no recorded move: ${prepared.directory}`)
  const restoreCommand = `${PLATFORM_SLUG} machine setup restore ${JSON.stringify(prepared.directory)}`
  try {
    adapters.authorizeStateFileRename?.()
    await restoreStateFileMigrationDecision(pair, adapters.stateFileHolders)
    await adapters.checkpointAndCloseStore?.()
    const decision = await restoreStateFileMigrationDecision(pair, adapters.stateFileHolders)
    await renameStateFiles({ oldPath: pair.newPath, newPath: pair.oldPath }, decision.suffixes)
    await rm(prepared.directory, { recursive: true })
    return `reversed state-file move ${pair.newPath} -> ${pair.oldPath}`
  } catch (error) {
    throw new Error(
      `could not reverse state-file move: ${error instanceof Error ? error.message : String(error)}; backup retained at ${prepared.directory}; recover with ${restoreCommand}`,
    )
  }
}

async function restoreStateFileMigrationDecision(
  pair: StateFileNamePair,
  holders?: (paths: string[]) => StateFileHolderObservation,
): Promise<Extract<StateFileMoveDecision, { kind: 'move' }>> {
  const reversed = { oldPath: pair.newPath, newPath: pair.oldPath }
  const decision = await decideStateFileMove(reversed, holders)
  if (decision.kind === 'refuse') {
    throw new Error(`${decision.reason}; then re-run ${PLATFORM_SLUG} machine setup restore`)
  }
  if (decision.kind !== 'move') {
    throw new Error(
      `refusing setup restore: recorded state file is absent: ${pair.newPath}; recover the recorded database at that path, then re-run ${PLATFORM_SLUG} machine setup restore`,
    )
  }
  return decision
}

export async function restoreOperatorEnvironmentBackup(
  directory: string,
  adapters: {
    restoreRegister: (rows: unknown[]) => Promise<void>
    restoreSecrets: (migrations: SecretEnvironmentMigration[]) => Promise<void>
    restoreSettings: (migrations: Array<{ oldName: string; newName: string }>) => Promise<void>
    checkpointAndCloseStore?: () => Promise<void> | void
    authorizeStateFileRename?: () => void
    stateFileHolders?: (paths: string[]) => StateFileHolderObservation
  },
): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8'),
  ) as EnvironmentBackupManifest
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.register) ||
    !Array.isArray(manifest.secrets) ||
    !Array.isArray(manifest.settings) ||
    (manifest.stateFile !== undefined &&
      (typeof manifest.stateFile?.oldPath !== 'string' ||
        typeof manifest.stateFile?.newPath !== 'string'))
  ) {
    throw new Error(`refusing setup restore: malformed manifest in ${directory}`)
  }
  if (manifest.stateFile) {
    adapters.authorizeStateFileRename?.()
    await restoreStateFileMigrationDecision(manifest.stateFile, adapters.stateFileHolders)
  }
  for (const file of manifest.files) {
    if (!file.existed) {
      await rm(file.path, { force: true })
      continue
    }
    await atomicModeRestrictedCopy(join(directory, file.backup), file.path, file.mode)
  }
  await adapters.restoreSecrets(manifest.secrets)
  await adapters.restoreSettings(manifest.settings)
  await adapters.restoreRegister(manifest.register)
  if (manifest.stateFile) {
    await adapters.checkpointAndCloseStore?.()
    const stateFileDecision = await restoreStateFileMigrationDecision(
      manifest.stateFile,
      adapters.stateFileHolders,
    )
    await renameStateFiles(
      { oldPath: manifest.stateFile.newPath, newPath: manifest.stateFile.oldPath },
      stateFileDecision.suffixes,
    )
  }
  await rm(directory, { recursive: true })
}

function acceptedEnvironmentFilePlan(sources: EnvironmentSource[]) {
  const plan = environmentFilesDecision(sources)
  if (plan.kind === 'refuse') {
    const { first, second, newName } = plan
    throw new Error(
      `refusing environment migration: ${first.name} in ${first.path} at line ${first.line} and ${second.name} in ${second.path} at line ${second.line} both set ${newName}; delete ${second.path} line ${second.line}, then re-run ${PLATFORM_SLUG} machine setup apply`,
    )
  }
  if (plan.kind === 'refuse-residue') {
    throw new Error(
      `refusing environment migration: ${plan.name} remains in ${plan.path} at line ${plan.line}; edit ${plan.path} line ${plan.line}, then re-run ${PLATFORM_SLUG} machine setup apply`,
    )
  }
  return plan
}

async function preserveFirstBackup(
  path: string,
  mode: number,
): Promise<{ path: string; kept: boolean }> {
  const backup = `${path}.${PLATFORM_SLUG}-env-backup`
  try {
    await createModeRestrictedCopy(path, backup, mode)
    return { path: backup, kept: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return { path: backup, kept: true }
  }
}

async function applyEnvironmentFilePlan(
  sources: EnvironmentSource[],
  plan: Extract<EnvironmentFilesDecision, { kind: 'replace' }>,
): Promise<EnvironmentMigrationReport['files']> {
  const files: EnvironmentMigrationReport['files'] = []
  for (const planned of plan.files) {
    const source = sources.find(({ path }) => path === planned.path)!
    const { path, mode } = source
    const decision = planned.decision
    if (decision.kind === 'unchanged') continue
    if (decision.kind !== 'replace') throw new Error('unreachable refused file decision')
    const backup = await preserveFirstBackup(path, mode)
    await atomicModePreservingWrite(path, decision.text, mode)
    files.push({
      path,
      names: decision.names,
      backup: backup.kept ? `${backup.path} (kept existing)` : backup.path,
    })
  }
  return files
}

async function migrateRequiredSecrets(
  migrate: () => Promise<SecretEnvironmentMigration[]>,
): Promise<SecretEnvironmentMigration[]> {
  try {
    return await migrate()
  } catch (error) {
    const reason =
      error instanceof ConfigClientError && error.reason === 'not-configured'
        ? `${error.message}; configure the record session`
        : error instanceof Error
          ? error.message
          : String(error)
    throw new Error(
      `sealed-secret environment migration did not complete after environment files were rewritten: ${reason}; re-run ${PLATFORM_SLUG} machine setup apply to complete it`,
    )
  }
}

export async function migrateOperatorEnvironment(
  home: string,
  adapters: {
    migrateSecrets: (
      record: (migration: SecretEnvironmentMigration) => Promise<void>,
    ) => Promise<SecretEnvironmentMigration[]>
    migrateRegister: () => Promise<Array<{ project: string; names: string[] }>>
    migrateSettings: () => Promise<Array<{ oldName: string; newName: string }>>
    rerenderSettings: () => Promise<boolean>
    preflight: () => Promise<void>
    backupRoot?: string
    registerBackup?: () => Promise<unknown[]>
    notes?: () => string[]
    processNamesRenamed?: number
    preparedStateFileMigration?: PreparedStateFileMigration | null
  },
): Promise<EnvironmentMigrationReport> {
  const sources = await environmentSources(home)
  const filePlan = acceptedEnvironmentFilePlan(sources)
  await adapters.preflight()
  const followUps = await staleInstalledPlists(home)
  const registerBackup = await (adapters.registerBackup?.() ?? Promise.resolve([]))
  const settingsJson = join(home, '.claude', 'settings.json')
  const backupPaths = [
    ...sources
      .filter((source) =>
        filePlan.files.some(
          (planned) => planned.path === source.path && planned.decision.kind === 'replace',
        ),
      )
      .map(({ path }) => path),
    ...sources
      .filter((source) =>
        filePlan.files.some(
          (planned) => planned.path === source.path && planned.decision.kind === 'replace',
        ),
      )
      .map(({ path }) => `${path}.${PLATFORM_SLUG}-env-backup`),
    settingsJson,
    ...followUps.map(({ path }) => path),
  ]
  const backup =
    adapters.preparedStateFileMigration ??
    (await createMigrationBackup(
      adapters.backupRoot ?? join(home, '.local', 'state', PLATFORM_SLUG, 'orchestrator'),
      backupPaths,
      registerBackup,
    ))
  if (adapters.preparedStateFileMigration) {
    await appendBackupFiles(backup.directory, backup.manifest, backupPaths)
  }
  backup.manifest.register = registerBackup
  const writeManifest = async () => {
    await writeFile(
      join(backup.directory, 'manifest.json'),
      `${JSON.stringify(backup.manifest, null, 2)}\n`,
      { mode: 0o600 },
    )
  }
  const files = await applyEnvironmentFilePlan(sources, filePlan)
  const secrets = await migrateRequiredSecrets(() =>
    adapters.migrateSecrets(async (migration) => {
      backup.manifest.secrets.push(migration)
      await writeManifest()
    }),
  )
  backup.manifest.secrets = secrets
  await writeManifest()
  const register = await adapters.migrateRegister()
  const settings = await adapters.migrateSettings()
  backup.manifest.settings = settings
  await writeManifest()
  const settingsRendered = await adapters.rerenderSettings()
  const reversibleChange =
    files.length > 0 ||
    secrets.length > 0 ||
    register.length > 0 ||
    settings.length > 0 ||
    settingsRendered ||
    backup.manifest.stateFile !== undefined
  if (reversibleChange) {
    await writeManifest()
  } else await rm(backup.directory, { recursive: true })
  return {
    processNamesRenamed: adapters.processNamesRenamed ?? 0,
    files,
    secrets,
    register,
    settings,
    followUps,
    backupDirectory: reversibleChange ? backup.directory : null,
    restoreCommand: reversibleChange
      ? `${PLATFORM_SLUG} machine setup restore ${JSON.stringify(backup.directory)}`
      : null,
    notes: adapters.notes?.() ?? [],
    stateFile: backup.manifest.stateFile ?? null,
  }
}

export function environmentMigrationMessage(report: EnvironmentMigrationReport): string | null {
  const changes = report.processNamesRenamed
    ? [
        `${report.processNamesRenamed} environment name${report.processNamesRenamed === 1 ? '' : 's'} renamed in-process`,
      ]
    : []
  changes.push(
    ...report.files.map(
      ({ path, names, backup }) => `${path}: ${names.join(', ')} (backup: ${backup})`,
    ),
  )
  if (report.stateFile) {
    changes.push(`orchestrator state: ${report.stateFile.oldPath} -> ${report.stateFile.newPath}`)
  }
  changes.push(
    ...report.secrets.map(
      ({ oldName, newName, scope }) => `${scope} secret: ${oldName} -> ${newName}`,
    ),
  )
  changes.push(
    ...report.register.map(({ project, names }) => `${project} register: ${names.join(', ')}`),
  )
  if (report.settings.length) {
    changes.push(
      `settings env: ${report.settings.map(({ oldName, newName }) => `${oldName} -> ${newName}`).join(', ')}`,
    )
  }
  changes.push(...report.notes)
  if (report.backupDirectory) {
    changes.push(
      `reversible backup: ${report.backupDirectory}; restore with ${report.restoreCommand}`,
    )
  }
  changes.push(
    ...report.followUps.map(
      ({ path, command, names }) =>
        `applied, follow-up required: ${path} is stale (${names.join(', ')}); in a new or re-sourced shell run ${command}, then re-run ${PLATFORM_SLUG} machine setup apply`,
    ),
  )
  return changes.length ? changes.join('; ') : null
}
