// concern: user-canon-home-files
/** Reads and applies harness-home canon files. Must not know stores, commands, runs, routing, or transports. */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { StateEnvironment } from '../../../shared/state-directory.ts'
import {
  applyBackedUpSettingsWrites,
  backupSettingsWrites,
  planSettingsWrite,
  restoreSettingsBackup,
  writeNewSettingsFileAtomically,
} from '../settings/settings-write.ts'
import {
  decideUserCanonHydration,
  mapUserCanonHomePath,
  USER_CANON_HOME_MAPPINGS,
  USER_CANON_MANAGED_MARKER,
  type UserCanonHomeMapping,
} from './user-canon-home.ts'

export type UserCanonHomeFile = { slug: string; path: string; text: string; mode: number }
export type UserCanonHomeTarget = {
  mapping: UserCanonHomeMapping
  path: string
  installed: boolean
  ignoredRunOverride: boolean
}
export type UserCanonHomePlan = {
  home: UserCanonHomeTarget
  writes: PlannedUserCanonWrite[]
  adopts: PlannedUserCanonExistingWrite[]
  deletes: PlannedUserCanonDelete[]
}

type CollectedFileState = { collectedText: string; collectedMode: number }
type PlannedUserCanonWriteBase = {
  slug: string
  path: string
  body: string
}
type PlannedUserCanonExistingWrite = PlannedUserCanonWriteBase & {
  existing: true
  collected: CollectedFileState
}
type PlannedUserCanonWrite =
  | PlannedUserCanonExistingWrite
  | (PlannedUserCanonWriteBase & { existing: false })
type PlannedUserCanonDelete = { slug: string; path: string; collected: CollectedFileState }

export type UserCanonHomeBatchHooks = {
  beforeDelete?: (path: string) => void
  afterMutation?: (path: string) => void
}

export function userCanonHomesFromEnvironment(
  env: NodeJS.ProcessEnv,
  orchestratorRuns: string,
): UserCanonHomeTarget[] {
  const home = env.HOME
  if (!home) throw new Error('HOME is required to locate user canon homes')
  const runs = resolve(orchestratorRuns)
  return USER_CANON_HOME_MAPPINGS.map((mapping) => {
    const override = mapping.environment ? env[mapping.environment] : undefined
    const resolvedOverride = override && override.length > 0 ? resolve(override) : null
    const ignoredRunOverride = resolvedOverride !== null && pathIsWithin(runs, resolvedOverride)
    const path =
      resolvedOverride && !ignoredRunOverride
        ? resolvedOverride
        : resolve(join(home, mapping.defaultDirectory))
    return { mapping, path, installed: pathState(path) !== null, ignoredRunOverride }
  })
}

export function userCanonHomeOverridesStatus(targets: UserCanonHomeTarget[]): string | null {
  const ignored = targets.flatMap((target) =>
    target.ignoredRunOverride && target.mapping.environment ? [target.mapping.environment] : [],
  )
  return ignored.length
    ? `ignored harness home overrides inside the orchestrator run-state directory: ${ignored.join(', ')}; using operator defaults`
    : null
}

export function userCanonHomeInstallationStatus(target: UserCanonHomeTarget): string | null {
  return target.installed ? null : `${target.mapping.harness} ${target.path}: not installed`
}

export function userCanonHomePlanDrift(plan: UserCanonHomePlan): number {
  return plan.writes.length + plan.adopts.length + plan.deletes.length
}

export function collectUserCanonHome(target: UserCanonHomeTarget): UserCanonHomeFile[] {
  if (!target.installed) return []
  assertRegularPath(target.path, 'directory', target)
  const relativePaths: string[] = [target.mapping.entry.home]
  const rules = target.mapping.rules && join(target.path, target.mapping.rules.homeDirectory)
  if (rules && pathState(rules)) {
    assertRegularPath(rules, 'directory', target)
    relativePaths.push(
      ...readdirSync(rules)
        .map((name) => join(target.mapping.rules!.homeDirectory, name))
        .filter((path) => mapHomePathToSlug(target.mapping, path) !== null),
    )
  }
  return relativePaths.flatMap((relativePath) => {
    const path = join(target.path, relativePath)
    const slug = mapHomePathToSlug(target.mapping, relativePath)
    if (!slug || !pathState(path)) return []
    assertRegularPath(path, 'file', target)
    assertResolvedUnderHome(target, path)
    return [{ slug, path, text: readFileSync(path, 'utf8'), mode: lstatSync(path).mode & 0o777 }]
  })
}

export function planUserCanonHome(input: {
  home: UserCanonHomeTarget
  rows: { slug: string; body: string }[]
  files: UserCanonHomeFile[]
  adopt?: boolean
}): UserCanonHomePlan {
  const rows = new Map(
    input.rows.flatMap((row) => {
      const relativePath = mapUserCanonHomePath(input.home.mapping, row.slug)
      return relativePath ? [[relativePath, row] as const] : []
    }),
  )
  const files = new Map(
    input.files.flatMap((file) => {
      const relativePath = mapUserCanonHomePath(input.home.mapping, file.slug)
      return relativePath ? [[relativePath, file] as const] : []
    }),
  )
  const paths = new Set([...rows.keys(), ...files.keys()])
  const writes: UserCanonHomePlan['writes'] = []
  const adopts: UserCanonHomePlan['adopts'] = []
  const deletes: UserCanonHomePlan['deletes'] = []
  for (const relativePath of [...paths].sort()) {
    const row = rows.get(relativePath)
    const file = files.get(relativePath)
    const path = join(input.home.path, relativePath)
    const decision = decideUserCanonHydration({
      storeBody: row?.body ?? null,
      homeText: file?.text ?? null,
    })
    if (decision.action === 'refuse') {
      if (input.adopt) {
        assertSingleLinkAdoptPath(input.home, path)
        const collected = collectedFileState(file!)
        adopts.push({
          slug: row!.slug,
          path,
          body: `${USER_CANON_MANAGED_MARKER}${row!.body}`,
          existing: true,
          collected,
        })
        continue
      }
      throw new Error(
        `refusing to overwrite unmarked ${input.home.mapping.harness} home file ${path}: its content differs from user canon\n` +
          'keep the file (file wins): orch canon import --user\n' +
          'keep the store (store wins): orch canon hydrate --user --adopt',
      )
    }
    if (decision.action === 'write') {
      if (file) {
        writes.push({
          slug: row!.slug,
          path,
          body: decision.body,
          existing: true,
          collected: collectedFileState(file),
        })
      } else {
        writes.push({ slug: row!.slug, path, body: decision.body, existing: false })
      }
    }
    if (decision.action === 'delete') {
      deletes.push({ slug: file!.slug, path, collected: collectedFileState(file!) })
    }
  }
  return { home: input.home, writes, adopts, deletes }
}

export function applyUserCanonHomePlans(
  plans: UserCanonHomePlan[],
  environment: StateEnvironment = process.env,
  dryRun = false,
  hooks: UserCanonHomeBatchHooks = {},
): string[] {
  if (dryRun) return []
  const changedPlans = plans.filter(
    (plan) => plan.writes.length > 0 || plan.adopts.length > 0 || plan.deletes.length > 0,
  )
  if (changedPlans.length === 0) return []
  preflightUserCanonHomePlans(changedPlans)
  const existingMutations = existingUserCanonMutations(changedPlans)
  const backedUpMutations = backupSettingsWrites(
    existingMutations.map((row) => {
      const write = planSettingsWrite(row.path, row.body)
      if (write.currentText !== row.collected.collectedText) changedAfterCollection(row.path)
      return write
    }),
    environment,
  )
  const writePaths = new Set(
    changedPlans.flatMap((plan) =>
      [...plan.writes.filter((row) => row.existing), ...plan.adopts].map((row) => row.path),
    ),
  )
  const backedUpWrites = backedUpMutations.filter((write) => writePaths.has(write.plan.path))
  const createdFiles: { path: string; body: string }[] = []
  const createdDirectories: { path: string; dev: number; ino: number }[] = []
  const deletedFiles: { path: string; quarantine: string }[] = []
  const installedWrites: string[] = []
  try {
    applyUserCanonCreatesAndDeletes(
      changedPlans,
      createdFiles,
      createdDirectories,
      deletedFiles,
      hooks,
    )
    for (const write of backedUpWrites) {
      applyBackedUpSettingsWrites([write], environment, {
        rollbackOnFailure: false,
        installed: (path) => {
          installedWrites.push(path)
          hooks.afterMutation?.(path)
        },
      })
    }
    for (const deleted of deletedFiles) rmSync(deleted.quarantine)
  } catch (error) {
    throw rollbackUserCanonHomeBatch(
      error,
      backedUpMutations,
      createdFiles,
      createdDirectories,
      deletedFiles,
      installedWrites,
      environment,
    )
  }
  return backedUpMutations.map((write) => write.backup)
}

function preflightUserCanonHomePlans(plans: UserCanonHomePlan[]): void {
  for (const plan of plans) {
    for (const row of [...plan.deletes, ...plan.writes, ...plan.adopts]) {
      preflightMutation(plan.home, row.path)
      if ('collected' in row && row.collected) {
        assertCollectedFileUnchanged(row.path, row.collected)
      } else if (pathState(row.path)) {
        changedAfterCollection(row.path)
      }
    }
  }
}

function existingUserCanonMutations(plans: UserCanonHomePlan[]) {
  return plans.flatMap((plan) => [
    ...plan.deletes.map((row) => ({ ...row, body: '' })),
    ...plan.writes.filter((row) => row.existing),
    ...plan.adopts,
  ])
}

function applyUserCanonCreatesAndDeletes(
  plans: UserCanonHomePlan[],
  createdFiles: { path: string; body: string }[],
  createdDirectories: { path: string; dev: number; ino: number }[],
  deletedFiles: { path: string; quarantine: string }[],
  hooks: UserCanonHomeBatchHooks,
): void {
  for (const plan of plans) {
    for (const row of plan.deletes) {
      hooks.beforeDelete?.(row.path)
      deleteUserCanonFile(row, deletedFiles)
      hooks.afterMutation?.(row.path)
    }
    for (const row of plan.writes.filter((write) => !write.existing)) {
      createUserCanonFile(plan.home, row, createdFiles, createdDirectories)
      hooks.afterMutation?.(row.path)
    }
  }
}

function createUserCanonFile(
  home: UserCanonHomeTarget,
  row: { path: string; body: string },
  createdFiles: { path: string; body: string }[],
  createdDirectories: { path: string; dev: number; ino: number }[],
): void {
  const parent = dirname(row.path)
  if (!pathState(parent)) {
    const rules = home.mapping.rules
    if (!rules || parent !== join(home.path, rules.homeDirectory)) {
      throw new Error(
        `refusing ${home.mapping.harness} home path ${row.path}: parent directory does not exist`,
      )
    }
    mkdirSync(parent)
    const created = lstatSync(parent)
    createdDirectories.push({ path: parent, dev: created.dev, ino: created.ino })
    assertRegularPath(parent, 'directory', home)
    assertResolvedUnderHome(home, parent)
  }
  writeNewSettingsFileAtomically(row.path, row.body, 0o644, () => {
    createdFiles.push({ path: row.path, body: row.body })
  })
  assertResolvedUnderHome(home, row.path)
}

function rollbackUserCanonHomeBatch(
  cause: unknown,
  backups: ReturnType<typeof backupSettingsWrites>,
  createdFiles: { path: string; body: string }[],
  createdDirectories: { path: string; dev: number; ino: number }[],
  deletedFiles: { path: string; quarantine: string }[],
  installedWrites: string[],
  environment: StateEnvironment,
): Error {
  const restorationErrors: string[] = []
  removeCreatedFiles(createdFiles, restorationErrors)
  restoreUserCanonWrites(backups, installedWrites, environment, restorationErrors)
  restoreDeletedFiles(deletedFiles, restorationErrors)
  removeCreatedDirectories(createdDirectories, restorationErrors)
  const backupLines = backups.map((write) => `${write.plan.path}: ${write.backup}`).join('\n')
  const restoration = restorationErrors.length
    ? `\nrestore failures:\n${restorationErrors.join('\n')}`
    : ''
  return new Error(
    `user canon batch hydrate failed: ${String(cause)}; backups retained:\n${backupLines}${restoration}`,
    { cause },
  )
}

function removeCreatedFiles(files: { path: string; body: string }[], errors: string[]): void {
  for (const { path, body } of [...files].reverse()) {
    try {
      const state = pathState(path)
      if (!state?.isFile() || state.nlink !== 1 || readFileSync(path, 'utf8') !== body) {
        errors.push(`${path}: restoration conflict; created file changed after installation`)
        continue
      }
      rmSync(path)
    } catch (error) {
      errors.push(`${path}: ${String(error)}`)
    }
  }
}

function restoreUserCanonWrites(
  backups: ReturnType<typeof backupSettingsWrites>,
  installedWrites: string[],
  environment: StateEnvironment,
  errors: string[],
): void {
  const installed = new Set(installedWrites)
  for (const write of [...backups].reverse()) {
    if (!installed.has(write.plan.path)) continue
    try {
      restoreSettingsBackup(write.plan.path, write.backup, environment)
    } catch (error) {
      errors.push(`${write.plan.path}: restoration conflict; ${String(error)}`)
    }
  }
}

function restoreDeletedFiles(
  deletedFiles: { path: string; quarantine: string }[],
  errors: string[],
): void {
  for (const deleted of [...deletedFiles].reverse()) {
    try {
      if (pathState(deleted.path)) {
        errors.push(`${deleted.path}: restoration conflict; path was recreated after deletion`)
        continue
      }
      renameSync(deleted.quarantine, deleted.path)
    } catch (error) {
      errors.push(`${deleted.path}: ${String(error)}`)
    }
  }
}

function removeCreatedDirectories(
  directories: { path: string; dev: number; ino: number }[],
  errors: string[],
): void {
  for (const { path, dev, ino } of [...directories].reverse()) {
    try {
      const state = pathState(path)
      if (
        !state?.isDirectory() ||
        state.dev !== dev ||
        state.ino !== ino ||
        readdirSync(path).length !== 0
      ) {
        errors.push(`${path}: restoration conflict; created directory changed after installation`)
        continue
      }
      rmSync(path)
    } catch (error) {
      errors.push(`${path}: ${String(error)}`)
    }
  }
}

function assertSingleLinkAdoptPath(target: UserCanonHomeTarget, path: string): void {
  const stat = lstatSync(path)
  if (stat.nlink !== 1) {
    throw new Error(
      `refusing to adopt ${target.mapping.harness} home file ${path}: hard links are not allowed; ` +
        'replace it with a singly linked regular file',
    )
  }
}

function refuseUnsafePath(target: UserCanonHomeTarget, path: string, detail: string): never {
  throw new Error(
    `refusing ${target.mapping.harness} home path ${path}: ${detail}; replace the link with a regular file or directory`,
  )
}

function assertRegularPath(
  path: string,
  expected: 'file' | 'directory',
  target: UserCanonHomeTarget,
): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    refuseUnsafePath(target, path, `symbolic link targets ${readlinkSync(path)}`)
  }
  if (expected === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    refuseUnsafePath(target, path, `expected a regular ${expected}`)
  }
  if (expected === 'file' && stat.nlink !== 1) {
    refuseUnsafePath(target, path, 'hard links are not allowed')
  }
}

function assertResolvedUnderHome(target: UserCanonHomeTarget, path: string): void {
  const realHome = realpathSync(target.path)
  const realPath = realpathSync(path)
  const fromHome = relative(realHome, realPath)
  if (
    fromHome === '..' ||
    fromHome.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromHome)
  ) {
    refuseUnsafePath(target, path, `resolved outside ${realHome} to ${realPath}`)
  }
}

function preflightMutation(target: UserCanonHomeTarget, path: string): void {
  const absoluteHome = resolve(target.path)
  const absolutePath = resolve(path)
  const fromHome = relative(absoluteHome, absolutePath)
  if (
    fromHome === '..' ||
    fromHome.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromHome)
  ) {
    refuseUnsafePath(target, path, `is outside ${absoluteHome}`)
  }
  const segments = fromHome.split(/[\\/]/).filter(Boolean)
  let cursor = absoluteHome
  assertRegularPath(cursor, 'directory', target)
  assertResolvedUnderHome(target, cursor)
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment)
    if (!pathState(cursor)) break
    assertRegularPath(cursor, index === segments.length - 1 ? 'file' : 'directory', target)
    assertResolvedUnderHome(target, cursor)
  }
}

function collectedFileState(file: UserCanonHomeFile): CollectedFileState {
  return { collectedText: file.text, collectedMode: file.mode }
}

function assertCollectedFileUnchanged(path: string, collected: CollectedFileState): void {
  const state = pathState(path)
  if (!state?.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
    changedAfterCollection(path)
  }
  if (readFileSync(path, 'utf8') !== collected.collectedText) changedAfterCollection(path)
}

function changedAfterCollection(path: string): never {
  throw new Error(
    `refusing user canon hydrate: ${path} changed after collection\n` +
      'cleared by: inspect the change and run the hydrate command again',
  )
}

function deleteUserCanonFile(
  row: PlannedUserCanonDelete,
  deletedFiles: { path: string; quarantine: string }[],
): void {
  const quarantine = join(dirname(row.path), `.${crypto.randomUUID()}.user-canon-delete`)
  renameSync(row.path, quarantine)
  try {
    assertCollectedFileUnchanged(quarantine, row.collected)
  } catch (error) {
    if (!pathState(row.path)) renameSync(quarantine, row.path)
    throw error
  }
  deletedFiles.push({ path: row.path, quarantine })
}

function pathState(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function mapHomePathToSlug(mapping: UserCanonHomeMapping, path: string): string | null {
  if (path === mapping.entry.home) return mapping.entry.canon
  if (!mapping.rules) return null
  const prefix = `${mapping.rules.homeDirectory}/`
  if (!path.startsWith(prefix)) return null
  const name = path.slice(prefix.length)
  return /^[^/]+\.md$/.test(name) ? `${mapping.rules.canonPrefix}${name}` : null
}

function pathIsWithin(parent: string, path: string): boolean {
  const fromParent = relative(parent, path)
  return (
    fromParent === '' ||
    (fromParent !== '..' &&
      !fromParent.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      !isAbsolute(fromParent))
  )
}
