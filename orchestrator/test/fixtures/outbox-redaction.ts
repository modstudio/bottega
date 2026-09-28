import type { Database } from 'bun:sqlite'
import { retryOutboxRow } from '../../src/record/outbox-quarantine.ts'
import { redactSyncedOutbox, syncedRedactionRules } from '../../src/record/outbox-redaction.ts'

const STAMP = '2026-09-15T01:01:00.000Z'

export async function exerciseQuarantinedRedactionSync<T>(
  local: Database,
  sync: () => Promise<T>,
): Promise<{ planted: string; redaction: ReturnType<typeof redactSyncedOutbox>; syncResult: T }> {
  local.exec(`CREATE TABLE outbox_redaction_audit (
    id INTEGER PRIMARY KEY, outbox_id INTEGER NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL,
    rules TEXT NOT NULL, withheld_paths TEXT NOT NULL, actor_session TEXT, at TEXT NOT NULL
  );
  CREATE INDEX outbox_latest_synced_record
    ON outbox(kind, record_id, id DESC) WHERE synced_at IS NOT NULL`)
  const planted = ['https://fixture-user', ':fixture-pass@', 'example.test'].join('')
  const row = local.query<{ payload: string }, []>('SELECT payload FROM outbox WHERE id=1').get()!
  const newer = JSON.parse(row.payload) as Record<string, unknown>
  const historical = { ...newer, error: planted }
  local
    .query('UPDATE outbox SET payload=?,synced_at=? WHERE id=1')
    .run(JSON.stringify(historical), STAMP)
  newer.error = 'newer operator-approved value'
  newer.updatedAt = '2026-09-15T01:02:00.000Z'
  local
    .query(
      `INSERT INTO outbox
       (id,kind,record_id,payload,created_at,quarantined_at,quarantine_reason)
       VALUES (2,'run',?,?,?,'2026-09-15T01:03:00.000Z','remote refusal')`,
    )
    .run(String(newer.id), JSON.stringify(newer), '2026-09-15T01:02:00.000Z')
  const redaction = redactSyncedOutbox(
    { rules: syncedRedactionRules('url-userinfo'), dryRun: false },
    local,
    '2026-09-15T01:04:00.000Z',
    'operator-session',
  )
  retryOutboxRow(2, local, '2026-09-15T01:05:00.000Z', 'operator-session')
  return { planted, redaction, syncResult: await sync() }
}
