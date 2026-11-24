// concern: harness session publication storage
/** Publishes, reads, and reaps machine-local harness-to-session associations. */

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { isHarnessName } from '../../../shared/harness-name.ts'
import {
  type PidRecordIdentity,
  pidRecordIdentity,
  processStartTime,
} from '../../../shared/process-identity.ts'
import {
  ensureHarnessSessionDirectory,
  harnessSessionDirectory,
  type StateEnvironment,
} from '../../../shared/state-directory.ts'
import type {
  HarnessProcessIdentity,
  HarnessSessionPublication,
  ObservedHarnessSessionPublication,
} from './harness-session-decision.ts'
import {
  harnessSessionDisposition,
  temporaryPublicationDisposition,
} from './harness-session-decision.ts'

type StoredPublication = Omit<HarnessSessionPublication, 'identity'>
type Identity = (pid: number, startTime: string) => PidRecordIdentity
type Stat = (path: string) => { mtimeMs: number }

export type HarnessSessionReadResult =
  | { kind: 'published'; publication: HarnessSessionPublication }
  | { kind: 'absent' }
  | { kind: 'unreadable'; path: string; reason: string }

function publicationPath(directory: string, identity: HarnessProcessIdentity): string {
  return join(directory, `${identity.pid}-${identity.startTime}.json`)
}

function parsePublicationName(name: string): HarnessProcessIdentity | null {
  const matched = /^(\d+)-(.+)\.json$/.exec(name)
  if (!matched) return null
  const pid = Number(matched[1])
  return Number.isSafeInteger(pid) && pid > 1 ? { pid, startTime: matched[2]! } : null
}

function readPublication(path: string, identity: HarnessProcessIdentity): HarnessSessionReadResult {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', path, reason: `read failed: ${String(error)}` }
  }
  let value: Partial<StoredPublication>
  try {
    value = JSON.parse(source) as Partial<StoredPublication>
  } catch (error) {
    return { kind: 'unreadable', path, reason: `invalid JSON: ${String(error)}` }
  }
  if (typeof value.session !== 'string' || !value.session)
    return { kind: 'unreadable', path, reason: 'session must be a non-empty string' }
  if (!isHarnessName(value.harness))
    return { kind: 'unreadable', path, reason: 'harness is not recognized' }
  if (typeof value.source !== 'string' || !value.source)
    return { kind: 'unreadable', path, reason: 'source must be a non-empty string' }
  if (typeof value.published_at !== 'string')
    return { kind: 'unreadable', path, reason: 'published_at must be a string' }
  return { kind: 'published', publication: { identity, ...value } as HarnessSessionPublication }
}

function storedPublications(env: StateEnvironment): HarnessSessionPublication[] {
  const directory = harnessSessionDirectory(env)
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((name) => {
    const identity = parsePublicationName(name)
    if (!identity) return []
    const result = readPublication(join(directory, name), identity)
    return result.kind === 'published' ? [result.publication] : []
  })
}

function reapTemporaryPublications(input: {
  directory: string
  dryRun?: boolean
  nowMs: number
  stat: Stat
}): number {
  let reaped = 0
  for (const name of readdirSync(input.directory)) {
    const temporary = join(input.directory, name)
    let mtimeMs: number
    try {
      mtimeMs = input.stat(temporary).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue
      throw error
    }
    if (temporaryPublicationDisposition(name, mtimeMs, input.nowMs) !== 'reap') continue
    reaped++
    if (!input.dryRun) rmSync(temporary, { force: true })
  }
  return reaped
}

export function publishHarnessSession(input: {
  pid: number
  session: string
  source: string
  env?: StateEnvironment
  now?: Date
  observeStartTime?: (pid: number) => string | null
}): HarnessSessionPublication {
  const startTime = (input.observeStartTime ?? processStartTime)(input.pid)
  if (!startTime) throw new Error(`could not establish harness pid ${input.pid} process start time`)
  const identity = { pid: input.pid, startTime }
  const publication: HarnessSessionPublication = {
    identity,
    session: input.session,
    harness: 'claude-code',
    source: input.source,
    published_at: (input.now ?? new Date()).toISOString(),
  }
  const directory = ensureHarnessSessionDirectory(input.env ?? process.env)
  const destination = publicationPath(directory, identity)
  const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`)
  const { identity: _identity, ...stored } = publication
  try {
    writeFileSync(temporary, `${JSON.stringify(stored)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
  return publication
}

/** Read the one publication belonging to an already-established harness process identity. */
export function readHarnessSession(
  identity: HarnessProcessIdentity,
  env: StateEnvironment = process.env,
): HarnessSessionReadResult {
  return readPublication(publicationPath(harnessSessionDirectory(env), identity), identity)
}

export function reapHarnessSessions(
  options: {
    env?: StateEnvironment
    dryRun?: boolean
    identity?: Identity
    now?: Date
    stat?: Stat
  } = {},
): { reaped: number; publications: ObservedHarnessSessionPublication[] } {
  const env = options.env ?? process.env
  const candidateDirectory = harnessSessionDirectory(env)
  if (!existsSync(candidateDirectory)) return { reaped: 0, publications: [] }
  const directory = ensureHarnessSessionDirectory(env)
  const identity = options.identity ?? pidRecordIdentity
  const publications = storedPublications(env)
  let reaped = 0
  const kept: ObservedHarnessSessionPublication[] = []
  for (const publication of publications) {
    const observedIdentity = identity(publication.identity.pid, publication.identity.startTime)
    const disposition = harnessSessionDisposition(observedIdentity)
    if (disposition === 'reap') {
      reaped++
      if (!options.dryRun) rmSync(publicationPath(directory, publication.identity), { force: true })
    } else kept.push({ ...publication, observedIdentity })
  }
  reaped += reapTemporaryPublications({
    directory,
    dryRun: options.dryRun,
    nowMs: (options.now ?? new Date()).getTime(),
    stat: options.stat ?? statSync,
  })
  return { reaped, publications: kept }
}
