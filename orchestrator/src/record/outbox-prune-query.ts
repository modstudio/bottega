// concern: outbox-prune
/** Keeps every outbox pruning path on the same retained-row predicate. */

const eligibilityWhere = (identity: boolean) => `
   WHERE candidate.synced_at IS NOT NULL
     AND candidate.quarantined_at IS NULL
     AND candidate.retired_at IS NULL
     ${identity ? 'AND candidate.kind=? AND candidate.row_id=?' : ''}
     AND EXISTS (
       SELECT 1
         FROM outbox newer INDEXED BY outbox_latest_synced_row
        WHERE newer.kind=candidate.kind
          AND newer.row_id=candidate.row_id
          AND newer.id>candidate.id
          AND newer.synced_at IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1 FROM outbox_quarantine_audit quarantine
        WHERE quarantine.outbox_id=candidate.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM outbox_redaction_audit redaction
        WHERE redaction.outbox_id=candidate.id
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
