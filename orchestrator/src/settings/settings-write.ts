// concern: settings-write
/** Plans and applies guarded settings-file writes. Must not know stores, commands, or transports. */
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { resolveStatePaths, type StateEnvironment } from '../../../shared/state-directory.ts'

const SETTINGS_BACKUP_LIMIT = 10
const SETTINGS_STALE_FILE_AGE_MS = 24 * 60 * 60 * 1_000
const BACKUP_NAME =
  /^settings-backup-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.bak$/

export type SettingsWritePlan = {
  path: string
  currentHash: string
  currentText: string
  renderedText: string
  mode: number
}

export type BackedUpSettingsWrite = {
  plan: SettingsWritePlan
  backup: string
}

type BackupMetadata = {
  version: 1
  target: string
  backupHash: string
  installedHash: string
  createdAt: number
}

export function planSettingsWrite(path: string, renderedText: string): SettingsWritePlan {
  const currentText = readRegularNoFollow(path)
  return {
    path,
    currentHash: hash(currentText),
    currentText,
    renderedText,
    mode: lstatRegular(path).mode & 0o777,
  }
}

export function applySettingsWrite(
  plan: SettingsWritePlan,
  environment: StateEnvironment,
): { backup: string | null; written: boolean } {
  const directory = prepareBackupDirectory(environment)
  reclaimStaleFiles(directory)
  reclaimTargetTemporaries(plan.path)
  const current = readRegularNoFollow(plan.path)
  if (hash(current) !== plan.currentHash) changedAfterPlanning(plan.path)
  if (current === plan.renderedText) return { backup: null, written: false }
  const backup = writeBackup(plan.path, current, plan.renderedText, directory)
  const beforeWrite = readRegularNoFollow(plan.path)
  if (hash(beforeWrite) !== plan.currentHash) changedAfterPlanning(plan.path)
  atomicWrite(plan.path, plan.renderedText, plan.mode)
  pruneBackups(directory, resolve(plan.path))
  return { backup, written: true }
}

export function backupSettingsWrites(
  plans: SettingsWritePlan[],
  environment: StateEnvironment,
): BackedUpSettingsWrite[] {
  if (plans.length === 0) return []
  const directory = prepareBackupDirectory(environment)
  reclaimStaleFiles(directory)
  for (const plan of plans) {
    reclaimTargetTemporaries(plan.path)
    assertUnchanged(plan)
  }
  return plans.map((plan) => {
    assertUnchanged(plan)
    return {
      plan,
      backup: writeBackup(plan.path, plan.currentText, plan.renderedText, directory),
    }
  })
}

export function applyBackedUpSettingsWrites(
  writes: BackedUpSettingsWrite[],
  environment: StateEnvironment,
): string[] {
  if (writes.length === 0) return []
  const written: BackedUpSettingsWrite[] = []
  try {
    for (const write of writes) {
      assertUnchanged(write.plan)
      atomicWrite(write.plan.path, write.plan.renderedText, write.plan.mode, () => {
        written.push(write)
      })
    }
  } catch (error) {
    const restoreErrors: string[] = []
    for (const write of written.reverse()) {
      try {
        restoreSettingsBackup(write.plan.path, write.backup, environment, true)
      } catch (restoreError) {
        restoreErrors.push(`${write.plan.path}: ${String(restoreError)}`)
      }
    }
    const backups = writes.map((write) => `${write.plan.path}: ${write.backup}`).join('\n')
    const restoration = restoreErrors.length
      ? `\nrestore failures:\n${restoreErrors.join('\n')}`
      : ''
    throw new Error(`settings batch write failed; backups retained:\n${backups}${restoration}`, {
      cause: error,
    })
  }
  const directory = prepareBackupDirectory(environment)
  for (const write of writes) pruneBackups(directory, resolve(write.plan.path))
  return writes.map((write) => write.backup)
}

export function writeNewSettingsFileAtomically(path: string, text: string, mode = 0o644): void {
  if (existsSync(path)) changedAfterPlanning(path)
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`)
  let fd: number | null = null
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    writeFileSync(fd, text)
    fchmodSync(fd, mode)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    if (existsSync(path)) changedAfterPlanning(path)
    renameSync(temporary, path)
    fsyncDirectory(directory)
  } finally {
    if (fd !== null) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

export function restoreSettingsBackup(
  target: string,
  backup: string,
  environment: StateEnvironment,
  force = false,
): void {
  const directory = prepareBackupDirectory(environment)
  const resolvedBackup = resolve(backup)
  if (
    dirname(resolvedBackup) !== resolve(directory) ||
    !BACKUP_NAME.test(basename(resolvedBackup))
  ) {
    throw new Error(`refusing settings restore: ${backup} is not a recognized settings backup`)
  }
  const metadata = readCompleteMetadata(resolvedBackup)
  if (!metadata || metadata.target !== resolve(target)) {
    throw new Error(
      `refusing settings restore: ${backup} is not a recognized complete backup for ${target}`,
    )
  }
  const text = readRegularNoFollow(resolvedBackup)
  if (hash(text) !== metadata.backupHash) {
    throw new Error(`refusing settings restore: ${backup} does not match its metadata`)
  }
  const current = readRegularNoFollow(target)
  if (!force && hash(current) !== metadata.installedHash) {
    throw new Error(
      `refusing settings restore: ${target} changed after the backup was installed\n` +
        'cleared by: inspect the later edits, or pass --force to discard them',
    )
  }
  const mode = lstatRegular(target).mode & 0o777
  atomicWrite(target, text, mode)
}

function changedAfterPlanning(path: string): never {
  throw new Error(
    `refusing settings write: ${path} changed after planning\n` +
      'cleared by: inspect the change and run the render command again',
  )
}

function assertUnchanged(plan: SettingsWritePlan): void {
  const current = readRegularNoFollow(plan.path)
  if (hash(current) !== plan.currentHash) changedAfterPlanning(plan.path)
}

function prepareBackupDirectory(environment: StateEnvironment): string {
  const directory = join(resolveStatePaths(environment).orchestratorDirectory, 'settings-backups')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing settings backups path ${directory}: expected a real directory`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`refusing settings backups path ${directory}: not owned by the current user`)
  }
  chmodSync(directory, 0o700)
  return directory
}

function writeBackup(path: string, text: string, installed: string, directory: string): string {
  const createdAt = Date.now()
  const backup = join(directory, `settings-backup-${createdAt}-${randomUUID()}.bak`)
  const metadataPath = `${backup}.json`
  try {
    writeExclusive(backup, text)
    const metadata: BackupMetadata = {
      version: 1,
      target: resolve(path),
      backupHash: hash(text),
      installedHash: hash(installed),
      createdAt,
    }
    writeExclusive(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
    fsyncDirectory(directory)
    return backup
  } catch (error) {
    rmSync(metadataPath, { force: true })
    rmSync(backup, { force: true })
    throw error
  }
}

function writeExclusive(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeFileSync(fd, text)
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function reclaimStaleFiles(directory: string): void {
  const cutoff = Date.now() - SETTINGS_STALE_FILE_AGE_MS
  for (const name of readdirSync(directory)) {
    if (!BACKUP_NAME.test(name)) continue
    const backup = join(directory, name)
    const metadata = `${backup}.json`
    const stat = safeOwnedRegular(backup)
    if (!stat || stat.mtimeMs >= cutoff || readCompleteMetadata(backup)) continue
    unlinkSync(backup)
    if (safeOwnedRegular(metadata)) unlinkSync(metadata)
  }
}

function reclaimTargetTemporaries(path: string): void {
  const directory = dirname(path)
  const prefix = `.${basename(path)}.tmp-`
  const cutoff = Date.now() - SETTINGS_STALE_FILE_AGE_MS
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !/^\d+-[0-9a-f-]{36}$/.test(name.slice(prefix.length))) continue
    const temporary = join(directory, name)
    const stat = safeOwnedRegular(temporary)
    if (stat && stat.mtimeMs < cutoff) unlinkSync(temporary)
  }
}

function pruneBackups(directory: string, target: string): void {
  const complete = readdirSync(directory)
    .filter((name) => BACKUP_NAME.test(name))
    .flatMap((name) => {
      const backup = join(directory, name)
      const metadata = readCompleteMetadata(backup)
      return metadata?.target === target ? [{ backup, metadata }] : []
    })
    .sort((left, right) => right.metadata.createdAt - left.metadata.createdAt)
  for (const entry of complete.slice(SETTINGS_BACKUP_LIMIT)) {
    unlinkSync(`${entry.backup}.json`)
    unlinkSync(entry.backup)
  }
  if (complete.length > SETTINGS_BACKUP_LIMIT) fsyncDirectory(directory)
}

function readCompleteMetadata(backup: string): BackupMetadata | null {
  if (!safeOwnedRegular(backup) || !safeOwnedRegular(`${backup}.json`)) return null
  let value: unknown
  try {
    value = JSON.parse(readRegularNoFollow(`${backup}.json`)) as unknown
  } catch {
    return null
  }
  if (!isBackupMetadata(value)) return null
  const match = BACKUP_NAME.exec(basename(backup))
  if (!match || Number(match[1]) !== value.createdAt || !isAbsolute(value.target)) return null
  try {
    if (hash(readRegularNoFollow(backup)) !== value.backupHash) return null
  } catch {
    return null
  }
  return value
}

function isBackupMetadata(value: unknown): value is BackupMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    row.version === 1 &&
    typeof row.target === 'string' &&
    typeof row.backupHash === 'string' &&
    /^[0-9a-f]{64}$/.test(row.backupHash) &&
    typeof row.installedHash === 'string' &&
    /^[0-9a-f]{64}$/.test(row.installedHash) &&
    typeof row.createdAt === 'number'
  )
}

function safeOwnedRegular(path: string): ReturnType<typeof lstatSync> | null {
  try {
    const stat = lstatSync(path)
    const uid = process.getuid?.()
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      (uid !== undefined && stat.uid !== uid)
    )
      return null
    return stat
  } catch {
    return null
  }
}

function atomicWrite(path: string, text: string, mode: number, installed?: () => void): void {
  lstatRegular(path)
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`)
  let fd: number | null = null
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    writeFileSync(fd, text)
    fchmodSync(fd, mode)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    lstatRegular(path)
    renameSync(temporary, path)
    installed?.()
    fsyncDirectory(directory)
  } finally {
    if (fd !== null) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function readRegularNoFollow(path: string): string {
  lstatRegular(path)
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    throw new Error(`refusing settings path ${path}: could not open a regular file`, {
      cause: error,
    })
  }
  try {
    if (!fstatSync(fd).isFile())
      throw new Error(`refusing settings path ${path}: expected a regular file`)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function lstatRegular(path: string) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink())
    throw new Error(`refusing settings path ${path}: symbolic links are not allowed`)
  if (!stat.isFile()) throw new Error(`refusing settings path ${path}: expected a regular file`)
  if (stat.nlink !== 1)
    throw new Error(`refusing settings path ${path}: hard links are not allowed`)
  return stat
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
