// concern: record-read-authority
/** Applies shared-state read authority at the hosted-record boundary. */

import type { Database } from 'bun:sqlite'
import { recordApiConfigured, resolvedRecordOrigin } from '../../../shared/record-api-url.ts'
import { readRecordSessionStamp, UNREADABLE_STAMP } from '../../../shared/record-session.ts'
import { isDiscardStorePath, ORCHESTRATOR_DATABASE_ENV } from '../../../shared/state-directory.ts'
import { db } from '../database/db.ts'
import { readRecordInstallBinding } from './install-binding.ts'
import { readRecordLocalByDesign } from './record-local-mark.ts'
import { decideRecordRead, type RecordReadDecision } from './record-read-decision.ts'
import { throwIfRecordRefused } from './record-write-authority.ts'

function currentRecordReadDecision(
  database: Database = db(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RecordReadDecision {
  const binding = readRecordInstallBinding(database)
  const stamp = readRecordSessionStamp(environment)
  return decideRecordRead({
    recordApiConfigured: recordApiConfigured(environment),
    installBound: binding.bound,
    boundOrigin: binding.recordOrigin,
    resolvedOrigin: resolvedRecordOrigin(environment),
    machineJoined: stamp === UNREADABLE_STAMP ? 'unreadable' : stamp !== null,
    localByDesign: readRecordLocalByDesign(database),
    discardStore: isDiscardStorePath(database.filename),
    storeOverride: environment[ORCHESTRATOR_DATABASE_ENV] !== undefined,
  })
}

export function applyRecordReadAuthority<T>(
  actions: { local(): T | Promise<T>; hosted(): T | Promise<T> },
  database: Database = db(),
): Promise<T> {
  const decision = currentRecordReadDecision(database)
  throwIfRecordRefused(decision)
  return Promise.resolve(
    decision.verdict === 'local-authoritative' ? actions.local() : actions.hosted(),
  )
}
