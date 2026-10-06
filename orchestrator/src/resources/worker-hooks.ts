// concern: worker hooks

import { randomUUID } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'

type WorkerHookName = 'commit-msg' | 'pre-push'
export type WorkerHookRecognition = 'current' | 'orch-generated' | 'unrecognized'

const WORKER_PRE_PUSH =
  '#!/bin/sh\necho "workers never push; the architect pushes after review" >&2\nexit 1\n'
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const workerHookMarker = (name: WorkerHookName) => `# orch worker ${name} hook\n`

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function markedWorkerHook(name: WorkerHookName, content: string): string {
  const newline = content.indexOf('\n')
  return `${content.slice(0, newline + 1)}${workerHookMarker(name)}${content.slice(newline + 1)}`
}

function workerCommitMsg(): string {
  const checker = bottegaEntryArgv('check-attribution').map(shellQuote).join(' ')
  return `#!/bin/sh\n${workerHookMarker('commit-msg')}exec ${checker} "$1"\n`
}

function legacyCommitMsg(content: string): boolean {
  const match = content.match(/^#!\/bin\/sh\nexec (.+) "\$1"\n$/)
  if (!match) return false
  return /(?:^|[\s/'"])(?:__)?check-attribution(?:\.ts)?(?=$|[\s'"])/.test(match[1]!)
}

/** Classify an installed worker hook using only its kind and bytes. */
export function recognizeWorkerHook(
  name: WorkerHookName,
  installedContent: string,
  currentContent: string,
): WorkerHookRecognition {
  if (installedContent === currentContent) return 'current'
  if (installedContent.startsWith(`#!/bin/sh\n${workerHookMarker(name)}`)) {
    return 'orch-generated'
  }
  if (name === 'pre-push') {
    return installedContent === WORKER_PRE_PUSH ? 'orch-generated' : 'unrecognized'
  }
  return legacyCommitMsg(installedContent) ? 'orch-generated' : 'unrecognized'
}

function verifiedWorkerHook(installed: string, content: string): boolean {
  if (!pathEntryExists(installed)) return false
  try {
    accessSync(installed, constants.X_OK)
    return readFileSync(installed, 'utf8') === content
  } catch {
    return false
  }
}

function replaceWorkerHook(installed: string, content: string): void {
  const temporary = join(
    dirname(installed),
    `.${basename(installed)}-${process.pid}-${randomUUID()}`,
  )
  let fd: number | null = null
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, content)
    fchmodSync(fd, 0o755)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temporary, installed)
  } finally {
    if (fd !== null) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

export function installWorkerHook(hookDir: string, name: WorkerHookName, content: string): void {
  const installed = join(hookDir, name)
  if (pathEntryExists(installed)) {
    if (verifiedWorkerHook(installed, content)) return
    let installedContent: string
    try {
      installedContent = readFileSync(installed, 'utf8')
    } catch {
      installedContent = ''
    }
    if (recognizeWorkerHook(name, installedContent, content) !== 'unrecognized') {
      replaceWorkerHook(installed, content)
      return
    }
    throw new Error(
      `refusing to replace worker ${name} hook ${installed}: it was not written by orch; ` +
        `remove ${installed} or run orch discard <run> for the chain`,
    )
  }
  let fd: number | null = null
  try {
    fd = openSync(installed, 'wx', 0o600)
    writeFileSync(fd, content)
    fchmodSync(fd, 0o755)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
  } catch (error) {
    if (fd !== null) closeSync(fd)
    if (verifiedWorkerHook(installed, content)) return
    throw error
  }
}

export function installWorkerHooks(hookDir: string): void {
  installWorkerHook(hookDir, 'pre-push', markedWorkerHook('pre-push', WORKER_PRE_PUSH))
  installWorkerHook(hookDir, 'commit-msg', workerCommitMsg())
}
