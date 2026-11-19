// concern: record-write-authority
/** Applies shared-state write authority at the hosted-record boundary. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordApiConfigured, resolvedRecordOrigin } from '../../../shared/record-api-url.ts'
import { recordSessionStampPath } from '../../../shared/state-directory.ts'
import { DB_PATH, db } from '../database/db.ts'
import { readRecordInstallBinding, readRecordLocalByDesign } from './install-binding.ts'
import { rememberHostedRecord } from './install-binding-write.ts'
import { storedRecordToken } from './record-session.ts'
import { decideRecordWrite, type RecordWriteDecision } from './record-write-decision.ts'

export function currentRecordWriteDecision(
  database: Database = db(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  storePath: string = DB_PATH,
): RecordWriteDecision {
  const binding = readRecordInstallBinding(database)
  const resolvedOrigin = resolvedRecordOrigin(environment)
  return decideRecordWrite({
    recordApiConfigured: recordApiConfigured(environment),
    installBound: binding.bound,
    boundOrigin: binding.recordOrigin,
    resolvedOrigin,
    machineJoined: existsSync(recordSessionStampPath(environment)),
    localByDesign:
      storePath === '/dev/null' || storePath.toUpperCase() === 'NUL'
        ? true
        : readRecordLocalByDesign(database),
  })
}

export function throwIfRecordRefused(
  decision: Extract<RecordWriteDecision, { verdict: 'refused' }>,
): never
export function throwIfRecordRefused(
  decision: RecordWriteDecision,
): asserts decision is Exclude<RecordWriteDecision, { verdict: 'refused' }>
export function throwIfRecordRefused(decision: RecordWriteDecision): void {
  if (decision.verdict === 'refused') throw new Error(decision.refusal)
}

export function applyRecordWriteAuthority<T>(
  actions: {
    local(): T | Promise<T>
    hosted(): T | Promise<T>
  },
  database: Database = db(),
): Promise<T> {
  const decision = currentRecordWriteDecision(database)
  throwIfRecordRefused(decision)
  if (decision.verdict === 'local-authoritative') return Promise.resolve(actions.local())
  return Promise.resolve(actions.hosted()).then((result) => {
    rememberHostedRecord()
    return result
  })
}

export function recordPublishAvailability(): { hostedConfigured: boolean; signedIn: boolean } {
  const decision = currentRecordWriteDecision()
  throwIfRecordRefused(decision)
  if (decision.verdict === 'local-authoritative') {
    return { hostedConfigured: false, signedIn: false }
  }
  return { hostedConfigured: true, signedIn: storedRecordToken() !== null }
}

export function requireHostedRecord(command: string): void {
  const decision = currentRecordWriteDecision()
  throwIfRecordRefused(decision)
  if (decision.verdict === 'local-authoritative') {
    throw new Error(
      `no hosted record is configured for this install; run \`${PLATFORM_SLUG} record use <address>\` before running \`${command}\``,
    )
  }
}
