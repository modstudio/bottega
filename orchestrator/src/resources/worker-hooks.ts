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
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'

type WorkerHookName = 'commit-msg' | 'pre-push'
export type WorkerHookRecognition = 'current' | 'orch-generated' | 'unrecognized'

const LEGACY_WORKER_PRE_PUSH =
  '#!/bin/sh\necho "workers never push; the architect pushes after review" >&2\nexit 1\n'
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

function workerPrePush(scratchRoots: string[]): string {
  const roots = [...new Set(scratchRoots.map((root) => realpathSync(root)))]
  const scratchCases = roots
    .map(
      (root) => `  case "$candidate/" in
    ${shellQuote(`${root}/`)}*) return 0 ;;
  esac`,
    )
    .join('\n')
  return `#!/bin/sh
refuse() {
  echo "workers never push; the architect pushes after review" >&2
  echo "worker pre-push refused: $1" >&2
  exit 1
}

guarded_common=\${ORCH_GUARDED_GIT_COMMON_DIR:-}
[ -n "$guarded_common" ] || refuse "guarded repository is not named"

current_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
  refuse "pushing repository common directory cannot be resolved"
current_common=$(cd "$current_common" 2>/dev/null && pwd -P) ||
  refuse "pushing repository common directory cannot be resolved"
[ "$current_common" != "$guarded_common" ] ||
  refuse "push originates from the guarded repository"

destination=\${2-}
case "$destination" in
  *://*|*:*) refuse "destination is not a local directory" ;;
esac
[ -d "$destination" ] || refuse "destination is not a local directory"
destination_path=$(cd "$destination" 2>/dev/null && pwd -P) ||
  refuse "destination path cannot be resolved"

is_scratch_path() {
  candidate=$1
${scratchCases}
  return 1
}

is_scratch_path "$destination_path" ||
  refuse "destination is not a local scratch repository"

destination_common=$(git -C "$destination_path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
  refuse "destination common directory cannot be resolved"
destination_common=$(cd "$destination_common" 2>/dev/null && pwd -P) ||
  refuse "destination common directory cannot be resolved"
[ "$destination_common" != "$guarded_common" ] ||
  refuse "push targets the guarded repository"
is_scratch_path "$destination_common" ||
  refuse "destination common directory is not under a scratch location"

is_bare=$(git rev-parse --is-bare-repository 2>/dev/null) ||
  refuse "pushing repository location cannot be resolved"
case "$is_bare" in
  true) source_path=$current_common ;;
  false)
    source_path=$(git rev-parse --path-format=absolute --show-toplevel 2>/dev/null) ||
      refuse "pushing repository location cannot be resolved"
    source_path=$(cd "$source_path" 2>/dev/null && pwd -P) ||
      refuse "pushing repository location cannot be resolved"
    ;;
  *) refuse "pushing repository location cannot be resolved" ;;
esac
is_scratch_path "$source_path" ||
  refuse "pushing repository is not a local scratch repository"
is_scratch_path "$current_common" ||
  refuse "pushing repository common directory is not under a scratch location"

exit 0
`
}
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
    return installedContent === LEGACY_WORKER_PRE_PUSH ? 'orch-generated' : 'unrecognized'
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

export function installWorkerHooks(
  hookDir: string,
  scratchRoots: string[] = [tmpdir(), '/tmp'],
): void {
  installWorkerHook(hookDir, 'pre-push', markedWorkerHook('pre-push', workerPrePush(scratchRoots)))
  installWorkerHook(hookDir, 'commit-msg', workerCommitMsg())
}
