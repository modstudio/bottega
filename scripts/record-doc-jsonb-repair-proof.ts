import type { Transaction } from '@electric-sql/pglite'
import { CheckFailure } from './record-migration-failure.ts'

export const docJsonbArrayRepair = '20261013190000_dev_1303_doc_jsonb_array_repair'
export const dev1303InvalidDocId = '01990000-0000-7000-8000-000000000027'
export const dev1303InvalidDocRevisionId = '01990000-0000-7000-8000-000000000031'

const jsonbStringDocId = '01990000-0000-7000-8000-000000000025'
const jsonbArrayDocId = '01990000-0000-7000-8000-000000000026'

export async function seedDocJsonbArrayRepair(
  transaction: Transaction,
  input: { spaceId: string; userId: string },
): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${input.spaceId}', true);
    SELECT set_config('app.user_id', '${input.userId}', true);
    INSERT INTO doc
      (id,space_id,scope,subject,slug,title,body,delivery,audiences,source_files,created_at,updated_at)
    VALUES
      ('${jsonbStringDocId}','${input.spaceId}','global',NULL,'jsonb-string','String','body','demand',ARRAY['technical'],to_jsonb('["src/string.ts"]'::text),'2026-10-13T12:00:00Z','2026-10-13T12:00:00Z'),
      ('${jsonbArrayDocId}','${input.spaceId}','global',NULL,'jsonb-array','Array','body','demand',ARRAY['technical'],'["src/array.ts"]'::jsonb,'2026-10-13T12:00:00Z','2026-10-13T12:00:00Z'),
      ('${dev1303InvalidDocId}','${input.spaceId}','global',NULL,'jsonb-invalid','Invalid','body','demand',ARRAY['technical'],to_jsonb('not an array'::text),'2026-10-13T12:00:00Z','2026-10-13T12:00:00Z');
    INSERT INTO doc_revision
      (id,space_id,doc_id,scope,subject,slug,op,title,body,delivery,audiences,related_subject_ids,source_files,author,reason,at)
    VALUES
      ('01990000-0000-7000-8000-000000000028','${input.spaceId}','${jsonbStringDocId}','global',NULL,'jsonb-string','create','String','body','demand',ARRAY['technical'],to_jsonb('["01990000-0000-7000-8000-000000000029"]'::text),to_jsonb('["src/string.ts"]'::text),'proof','repair string','2026-10-13T12:00:00Z'),
      ('01990000-0000-7000-8000-000000000030','${input.spaceId}','${jsonbArrayDocId}','global',NULL,'jsonb-array','create','Array','body','demand',ARRAY['technical'],'[]'::jsonb,'["src/array.ts"]'::jsonb,'proof','leave array','2026-10-13T12:00:00Z'),
      ('${dev1303InvalidDocRevisionId}','${input.spaceId}','${dev1303InvalidDocId}','global',NULL,'jsonb-invalid','create','Invalid','body','demand',ARRAY['technical'],to_jsonb('not an array'::text),to_jsonb('not an array'::text),'proof','leave invalid','2026-10-13T12:00:00Z');
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
}

export async function proofDocJsonbArrayRepair(
  transaction: Transaction,
  input: { spaceId: string; userId: string },
): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${input.spaceId}', true);
    SELECT set_config('app.user_id', '${input.userId}', true);
  `)
  const docs = await transaction.query<{
    id: string
    source_type: string
    source_files: unknown
    advanced: boolean
  }>(`
    SELECT id,jsonb_typeof(source_files) AS source_type,source_files,
      updated_at > '2026-10-13T12:00:00Z'::timestamptz AS advanced
    FROM doc WHERE id IN ('${jsonbStringDocId}','${jsonbArrayDocId}','${dev1303InvalidDocId}')
    ORDER BY id
  `)
  const revisions = await transaction.query<{
    doc_id: string
    related_type: string
    source_type: string
  }>(`
    SELECT doc_id,jsonb_typeof(related_subject_ids) AS related_type,
      jsonb_typeof(source_files) AS source_type
    FROM doc_revision
    WHERE doc_id IN ('${jsonbStringDocId}','${jsonbArrayDocId}','${dev1303InvalidDocId}')
    ORDER BY doc_id
  `)
  const expectedDocs = [
    {
      id: jsonbStringDocId,
      source_type: 'array',
      source_files: ['src/string.ts'],
      advanced: true,
    },
    {
      id: jsonbArrayDocId,
      source_type: 'array',
      source_files: ['src/array.ts'],
      advanced: false,
    },
    {
      id: dev1303InvalidDocId,
      source_type: 'string',
      source_files: 'not an array',
      advanced: false,
    },
  ]
  if (JSON.stringify(docs.rows) !== JSON.stringify(expectedDocs))
    throw new CheckFailure(`DEV-1303 document repair produced ${JSON.stringify(docs.rows)}`)
  const expectedRevisions = [
    { doc_id: jsonbStringDocId, related_type: 'array', source_type: 'array' },
    { doc_id: jsonbArrayDocId, related_type: 'array', source_type: 'array' },
    {
      doc_id: dev1303InvalidDocId,
      related_type: 'string',
      source_type: 'string',
    },
  ]
  if (JSON.stringify(revisions.rows) !== JSON.stringify(expectedRevisions))
    throw new CheckFailure(`DEV-1303 revision repair produced ${JSON.stringify(revisions.rows)}`)
  const forced = await transaction.query<{ relname: string }>(`
    SELECT relname FROM pg_class
    WHERE relnamespace='public'::regnamespace
      AND relname IN ('doc','doc_revision') AND relforcerowsecurity
    ORDER BY relname
  `)
  if (JSON.stringify(forced.rows.map((row) => row.relname)) !== '["doc","doc_revision"]')
    throw new CheckFailure('DEV-1303 document repair did not restore forced row-level security')
  await transaction.exec(`
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
}
