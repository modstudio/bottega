// concern: outbox-prune
/** Owns the superseded-row deletion and delivered-payload release predicates. */

import { unreleasedOutboxPayloadSql } from './outbox-prune-payload.ts'

const unprotectedCandidateSql = () => `
     AND candidate.quarantined_at IS NULL
     AND candidate.retired_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM outbox_quarantine_audit quarantine
        WHERE quarantine.outbox_id=candidate.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM outbox_redaction_audit redaction
        WHERE redaction.outbox_id=candidate.id
     )`

export const deliveredUnprotectedOutboxDeleteSql = `
  DELETE FROM outbox AS candidate
   WHERE candidate.kind=?
     AND candidate.row_id=?
     AND candidate.synced_at IS NOT NULL
     ${unprotectedCandidateSql()}`

const eligibilityWhere = (identity: boolean) => `
   WHERE candidate.synced_at IS NOT NULL
     ${unprotectedCandidateSql()}
     ${identity ? 'AND candidate.kind=? AND candidate.row_id=?' : ''}
     AND EXISTS (
       SELECT 1
         FROM outbox newer INDEXED BY outbox_latest_synced_row
        WHERE newer.kind=candidate.kind
          AND newer.row_id=candidate.row_id
          AND newer.id>candidate.id
          AND newer.synced_at IS NOT NULL
     )`

export const supersededOutboxSelectionSql = (identity: boolean) => `
  SELECT candidate.id
    FROM outbox candidate
  ${eligibilityWhere(identity)}
   ORDER BY candidate.id
   LIMIT ?`

export const supersededOutboxCountSql = (identity: boolean) => `
  SELECT count(*) AS count
    FROM outbox candidate
  ${eligibilityWhere(identity)}`

export const supersededOutboxProbeSql = (identity: boolean) => `
  SELECT candidate.id
    FROM outbox candidate
  ${eligibilityWhere(identity)}
   LIMIT 1`

const payloadReleaseEligibilityWhere = `
   WHERE candidate.synced_at<?
     AND ${unreleasedOutboxPayloadSql('candidate.payload')}
     ${unprotectedCandidateSql()}`

export const releasableOutboxPayloadSelectionSql = `
  SELECT candidate.id
    FROM outbox candidate
  ${payloadReleaseEligibilityWhere}
   ORDER BY candidate.id
   LIMIT ?`

export const releasableOutboxPayloadCountSql = `
  SELECT count(*) AS count
    FROM outbox candidate
  ${payloadReleaseEligibilityWhere}`

export const releasableOutboxPayloadProbeSql = `
  SELECT candidate.id
    FROM outbox candidate
  ${payloadReleaseEligibilityWhere}
   LIMIT 1`
