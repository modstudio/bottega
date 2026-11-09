// concern: session close-out outbox
/** Pushes hosted evidence when allowed, then reports this session's undelivered writes. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { syncRecord } from '../record/record-sync.ts'
import {
  type SessionOutboxResidue,
  type SessionOutboxRow,
  sessionOutboxResidue,
} from './session-close-out-decision.ts'
import type { SessionErrorLine, SessionProcessLine } from './session-close-out-report.ts'

export function readSessionOutboxResidue(
  database: Database,
  session: string,
): SessionOutboxResidue {
  const rows = database
    .query<
      SessionOutboxRow,
      [string]
    >(`SELECT id, actor_session AS actorSession, synced_at AS syncedAt,
              quarantined_at AS quarantinedAt, retired_at AS retiredAt
         FROM outbox
        WHERE actor_session = ?
          AND synced_at IS NULL
          AND retired_at IS NULL`)
    .all(session)
  return sessionOutboxResidue(session, rows)
}

function outboxProcessItems(residue: SessionOutboxResidue): SessionProcessLine[] {
  const process: SessionProcessLine[] = []
  if (residue.pendingIds.length) {
    process.push({
      item: `${residue.pendingIds.length} pending outbox write(s)`,
      reason: 'this session has local writes that have not reached the hosted record',
      evidence: residue.pendingIds.map((id) => `orch:${id}`).join(', '),
      remedy: `${PLATFORM_SLUG} record push`,
    })
  }
  if (residue.quarantinedIds.length) {
    process.push({
      item: `${residue.quarantinedIds.length} quarantined outbox write(s)`,
      reason: 'this session has hosted writes quarantined after delivery failed',
      evidence: residue.quarantinedIds.map((id) => `orch:${id}`).join(', '),
      remedy: `inspect with ${PLATFORM_SLUG} record outbox; retry each row with ${PLATFORM_SLUG} record outbox retry orch:<row-id>`,
    })
  }
  return process
}

export async function closeOutSessionOutbox(input: {
  database: Database
  session: string
  dryRun: boolean
}): Promise<{ mechanical: string[]; process: SessionProcessLine[]; errors: SessionErrorLine[] }> {
  const mechanical: string[] = []
  const errors: SessionErrorLine[] = []
  if (!input.dryRun) {
    try {
      const result = await syncRecord({ local: input.database })
      mechanical.push(
        result.configured
          ? `record push delivered ${result.pushed}, failed ${result.failed}, pending ${result.pending}`
          : 'record push skipped because no hosted record is configured',
      )
    } catch (cause) {
      errors.push({
        item: 'outbox push',
        detail: cause instanceof Error ? cause.message : String(cause),
        retry: `${PLATFORM_SLUG} record push`,
      })
    }
  }
  return {
    mechanical,
    process: outboxProcessItems(readSessionOutboxResidue(input.database, input.session)),
    errors,
  }
}
