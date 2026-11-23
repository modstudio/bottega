// concern: harness session publication storage
/** Publishes, reads, and reaps machine-local harness-to-session associations. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  pidRecordIdentity,
  processStartTime,
  type PidRecordIdentity,
} from '../../../shared/process-identity.ts'
import { harnessSessionDirectory, type StateEnvironment } from '../../../shared/state-directory.ts'
import { processTableSnapshot, type ProcessFact } from '../resources/process-inventory.ts'
import {
  type HarnessProcessIdentity,
  type HarnessSessionPublication,
  unpublishedHarnessProcesses,
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
  const directory = harnessSessionDirectory(input.env ?? process.env)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
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

export function readHarnessSession(
  pid: number,
  options: { env?: StateEnvironment; identity?: Identity } = {},
): HarnessSessionPublication | null {
  const identity = options.identity ?? pidRecordIdentity
  return (
    storedPublications(options.env ?? process.env).find(
      (publication) =>
        publication.identity.pid === pid &&
        identity(publication.identity.pid, publication.identity.startTime) === 'live',
    ) ?? null
  )
}

export function reapHarnessSessions(
  options: { env?: StateEnvironment; dryRun?: boolean; identity?: Identity } = {},
): { reaped: number; publications: HarnessSessionPublication[] } {
  const env = options.env ?? process.env
  const identity = options.identity ?? pidRecordIdentity
  const publications = storedPublications(env)
  let reaped = 0
  const kept: HarnessSessionPublication[] = []
  for (const publication of publications) {
    const state = identity(publication.identity.pid, publication.identity.startTime)
    if (state === 'dead' || state === 'reused') {
      reaped++
      if (!options.dryRun)
        rmSync(publicationPath(harnessSessionDirectory(env), publication.identity), { force: true })
    } else if (state === 'live') kept.push(publication)
  }
  return { reaped, publications: kept }
}

function isClaudeHarness(process: Pick<ProcessFact, 'command'>): boolean {
  const executable = process.command.trim().split(/\s+/, 1)[0] ?? ''
  return basename(executable) === 'claude'
}

export function sweepHarnessSessions(input: {
  dryRun: boolean
  log: (line: string) => void
  error: (line: string) => void
  env?: StateEnvironment
  snapshot?: () => { facts: ProcessFact[]; error: string | null }
  identity?: Identity
}): { failed: boolean; unpublished: HarnessProcessIdentity[]; reaped: number } {
  const reaped = reapHarnessSessions({
    env: input.env,
    dryRun: input.dryRun,
    identity: input.identity,
  })
  const inventory = (input.snapshot ?? processTableSnapshot)()
  if (inventory.error) {
    input.error(`harness process inventory failed: ${inventory.error}`)
    return { failed: true, unpublished: [], reaped: reaped.reaped }
  }
  const harnesses = inventory.facts
    .filter(isClaudeHarness)
    .map(({ pid, startTime }) => ({ pid, startTime }))
  const unpublished = unpublishedHarnessProcesses(harnesses, reaped.publications)
  input.log(`harness processes without a published session: ${unpublished.length}`)
  for (const process of unpublished) input.log(`  ${process.pid} ${process.startTime}`)
  return { failed: false, unpublished, reaped: reaped.reaped }
}
