// concern: record-write-authority
/** Applies shared-state write authority at the hosted-record boundary. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordApiConfigured, resolveRecordApiUrl } from '../../../shared/record-api-url.ts'
import { db } from '../database/db.ts'
import { readRecordInstallBinding } from './install-binding.ts'
import { rememberHostedRecord } from './install-binding-write.ts'
import { decideRecordWrite, type RecordWriteDecision } from './record-write-decision.ts'

export function currentRecordWriteDecision(
  database: Database = db(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RecordWriteDecision {
  const binding = readRecordInstallBinding(database)
  const resolvedOrigin = new URL(resolveRecordApiUrl(environment)).origin
  return decideRecordWrite({
    recordApiConfigured: recordApiConfigured(environment),
    installBound: binding.bound,
    boundOrigin: binding.recordOrigin,
    resolvedOrigin,
  })
}

export function applyRecordWriteAuthority<T>(actions: {
  local(): T | Promise<T>
  hosted(): T | Promise<T>
}): Promise<T> {
  const decision = currentRecordWriteDecision()
  if (decision.verdict === 'refused') throw new Error(decision.refusal)
  if (decision.verdict === 'local-authoritative') return Promise.resolve(actions.local())
  return Promise.resolve(actions.hosted()).then((result) => {
    rememberHostedRecord()
    return result
  })
}

export function requireHostedRecord(command: string): void {
  const decision = currentRecordWriteDecision()
  if (decision.verdict === 'refused') throw new Error(decision.refusal)
  if (decision.verdict === 'local-authoritative') {
    throw new Error(
      `no hosted record is configured for this install; run \`${PLATFORM_SLUG} record use <address>\` before running \`${command}\``,
    )
  }
}
