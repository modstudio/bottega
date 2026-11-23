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

function publicationPath(directory: string, identity: HarnessProcessIdentity): string {
  return join(directory, `${identity.pid}-${identity.startTime}.json`)
}

function parsePublicationName(name: string): HarnessProcessIdentity | null {
  const matched = /^(\d+)-(.+)\.json$/.exec(name)
  if (!matched) return null
  const pid = Number(matched[1])
  return Number.isSafeInteger(pid) && pid > 1 ? { pid, startTime: matched[2]! } : null
}

function parsePublication(
  path: string,
  identity: HarnessProcessIdentity,
): HarnessSessionPublication | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredPublication>
    if (
      typeof value.session !== 'string' ||
      !value.session ||
      value.harness !== 'claude-code' ||
      typeof value.source !== 'string' ||
      !value.source ||
      typeof value.published_at !== 'string'
    )
      return null
    return { identity, ...value } as HarnessSessionPublication
  } catch {
    return null
  }
}

function storedPublications(env: StateEnvironment): HarnessSessionPublication[] {
  const directory = harnessSessionDirectory(env)
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((name) => {
    const identity = parsePublicationName(name)
    if (!identity) return []
    const publication = parsePublication(join(directory, name), identity)
    return publication ? [publication] : []
  })
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

export function reapHarnessSessions(
  options: {
    env?: StateEnvironment
    dryRun?: boolean
    identity?: Identity
    now?: Date
    stat?: (path: string) => { mtimeMs: number }
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
  const nowMs = (options.now ?? new Date()).getTime()
  const stat = options.stat ?? statSync
  for (const name of readdirSync(directory)) {
    const temporary = join(directory, name)
    let mtimeMs: number
    try {
      mtimeMs = stat(temporary).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue
      throw error
    }
    if (temporaryPublicationDisposition(name, mtimeMs, nowMs) !== 'reap') continue
    reaped++
    if (!options.dryRun) rmSync(temporary, { force: true })
  }
  return { reaped, publications: kept }
}
