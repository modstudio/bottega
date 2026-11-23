import type { Transaction } from '@electric-sql/pglite'
import { CheckFailure } from './record-migration-failure.ts'

export const settingsSubagentHooksBackfill =
  '20261122220000_dev_2592_settings_subagent_hooks_backfill'

const settingsWithOptionsId = '01990000-0000-7000-8000-000000002592'
const settingsWithoutOptionsId = '01990000-0000-7000-8000-000000002593'
const nonSettingsId = '01990000-0000-7000-8000-000000002594'
const originalWithOptionsRevisionId = '01990000-0000-7000-8000-000000002595'
const originalWithoutOptionsRevisionId = '01990000-0000-7000-8000-000000002596'
const originalNonSettingsRevisionId = '01990000-0000-7000-8000-000000002597'

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export async function seedSettingsSubagentHooksBackfill(
  transaction: Transaction,
  input: { spaceId: string; userId: string },
): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${input.spaceId}', true);
    SELECT set_config('app.user_id', '${input.userId}', true);
    INSERT INTO doc
      (id,space_id,scope,subject,owner_user_id,slug,title,body,delivery,audiences,
       created_at,updated_at,latest_revision_id)
    VALUES
      ('${settingsWithOptionsId}','${input.spaceId}','settings',NULL,'${input.userId}',
       'settings-proof-options','Settings proof options',
       '{"permissions":{},"hooks":{},"options":{"other":"kept"}}','demand',ARRAY['technical'],
       '2026-11-22T22:00:00Z','2026-11-22T22:00:00Z','${originalWithOptionsRevisionId}'),
      ('${settingsWithoutOptionsId}','${input.spaceId}','settings',NULL,'${input.userId}',
       'settings-proof-empty','Settings proof empty','{"permissions":{},"hooks":{}}',
       'demand',ARRAY['technical'],'2026-11-22T22:00:00Z','2026-11-22T22:00:00Z',
       '${originalWithoutOptionsRevisionId}'),
      ('${nonSettingsId}','${input.spaceId}','global',NULL,NULL,
       'settings-proof-global','Settings proof global','{"options":{"other":"untouched"}}',
       'demand',ARRAY['technical'],'2026-11-22T22:00:00Z','2026-11-22T22:00:00Z',
       '${originalNonSettingsRevisionId}');
    INSERT INTO doc_revision
      (id,space_id,doc_id,scope,subject,owner_user_id,slug,op,title,body,delivery,
       audiences,author,reason,at)
    VALUES
      ('${originalWithOptionsRevisionId}','${input.spaceId}','${settingsWithOptionsId}',
       'settings',NULL,'${input.userId}','settings-proof-options','create','Settings proof options',
       '{"permissions":{},"hooks":{},"options":{"other":"kept"}}','demand',ARRAY['technical'],
       'proof','original settings revision','2026-11-22T22:00:00Z'),
      ('${originalWithoutOptionsRevisionId}','${input.spaceId}','${settingsWithoutOptionsId}',
       'settings',NULL,'${input.userId}','settings-proof-empty','create','Settings proof empty',
       '{"permissions":{},"hooks":{}}','demand',ARRAY['technical'],
       'proof','original settings revision','2026-11-22T22:00:00Z'),
      ('${originalNonSettingsRevisionId}','${input.spaceId}','${nonSettingsId}',
       'global',NULL,NULL,'settings-proof-global','create','Settings proof global',
       '{"options":{"other":"untouched"}}','demand',ARRAY['technical'],
       'proof','original global revision','2026-11-22T22:00:00Z');
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
}

export async function proofSettingsSubagentHooksBackfill(
  transaction: Transaction,
  input: { spaceId: string; userId: string },
): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${input.spaceId}', true);
    SELECT set_config('app.user_id', '${input.userId}', true);
  `)
  const docs = await transaction.query<{
    id: string
    body: string
    latest_revision_id: string
  }>(`
    SELECT id,body,latest_revision_id FROM doc
    WHERE id IN ('${settingsWithOptionsId}','${settingsWithoutOptionsId}','${nonSettingsId}')
    ORDER BY id
  `)
  const revisions = await transaction.query<{
    id: string
    doc_id: string
    op: string
    author: string
    reason: string
    body: string
  }>(`
    SELECT id,doc_id,op,author,reason,body FROM doc_revision
    WHERE doc_id IN ('${settingsWithOptionsId}','${settingsWithoutOptionsId}','${nonSettingsId}')
    ORDER BY doc_id,at
  `)
  const parsedDocs = docs.rows.map((row) => ({ ...row, body: JSON.parse(row.body) as unknown }))
  const expectedDocs = [
    {
      id: settingsWithOptionsId,
      body: {
        permissions: {},
        hooks: {},
        options: { other: 'kept', subagentHooks: 'on' },
      },
      latest_revision_id: revisions.rows[1]?.id,
    },
    {
      id: settingsWithoutOptionsId,
      body: { permissions: {}, hooks: {}, options: { subagentHooks: 'on' } },
      latest_revision_id: revisions.rows[3]?.id,
    },
    {
      id: nonSettingsId,
      body: { options: { other: 'untouched' } },
      latest_revision_id: originalNonSettingsRevisionId,
    },
  ]
  if (stableJson(parsedDocs) !== stableJson(expectedDocs)) {
    throw new CheckFailure(`DEV-2592 settings backfill produced ${JSON.stringify(parsedDocs)}`)
  }
  const expectedRevisionShape = [
    {
      id: originalWithOptionsRevisionId,
      doc_id: settingsWithOptionsId,
      op: 'create',
      author: 'proof',
      reason: 'original settings revision',
      body: { permissions: {}, hooks: {}, options: { other: 'kept' } },
    },
    {
      doc_id: settingsWithOptionsId,
      op: 'backfill',
      author: 'migration',
      reason: 'DEV-2592: subagent blocking stays on for existing users',
      body: {
        permissions: {},
        hooks: {},
        options: { other: 'kept', subagentHooks: 'on' },
      },
    },
    {
      id: originalWithoutOptionsRevisionId,
      doc_id: settingsWithoutOptionsId,
      op: 'create',
      author: 'proof',
      reason: 'original settings revision',
      body: { permissions: {}, hooks: {} },
    },
    {
      doc_id: settingsWithoutOptionsId,
      op: 'backfill',
      author: 'migration',
      reason: 'DEV-2592: subagent blocking stays on for existing users',
      body: { permissions: {}, hooks: {}, options: { subagentHooks: 'on' } },
    },
    {
      id: originalNonSettingsRevisionId,
      doc_id: nonSettingsId,
      op: 'create',
      author: 'proof',
      reason: 'original global revision',
      body: { options: { other: 'untouched' } },
    },
  ]
  const revisionShape = revisions.rows.map((row) => ({
    ...(row.op === 'backfill' ? {} : { id: row.id }),
    doc_id: row.doc_id,
    op: row.op,
    author: row.author,
    reason: row.reason,
    body: JSON.parse(row.body) as unknown,
  }))
  if (stableJson(revisionShape) !== stableJson(expectedRevisionShape)) {
    throw new CheckFailure(`DEV-2592 settings revisions produced ${JSON.stringify(revisionShape)}`)
  }
  const forced = await transaction.query<{ relname: string }>(`
    SELECT relname FROM pg_class
    WHERE relnamespace='public'::regnamespace
      AND relname IN ('doc','doc_revision') AND relforcerowsecurity
    ORDER BY relname
  `)
  if (JSON.stringify(forced.rows.map((row) => row.relname)) !== '["doc","doc_revision"]') {
    throw new CheckFailure('DEV-2592 settings backfill did not restore forced row-level security')
  }
  await transaction.exec(`
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
}
