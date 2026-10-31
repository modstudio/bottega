import type { Transaction } from '@electric-sql/pglite'

export const jsonbStringChecksValidate = '20261031055501_dev_1893_jsonb_string_checks_validate'

const questionId = '01990000-0000-7000-8000-000000000189'
const machineId = '01990000-0000-7000-8000-000000000188'
const invalidDocId = '01990000-0000-7000-8000-000000000027'
const invalidDocRevisionId = '01990000-0000-7000-8000-000000000031'
const legacyOption = 'legacy option'

export async function seedJsonbStringChecksValidate(
  transaction: Transaction,
  input: { spaceId: string; userId: string },
): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${input.spaceId}', true);
    SELECT set_config('app.user_id', '${input.userId}', true);
    -- The hosted record has no string-valued doc rows per DEV-1893's read-only count; the record rehearsal proves this on a real restore.
    DELETE FROM doc_revision WHERE id = '${invalidDocRevisionId}';
    DELETE FROM doc WHERE id = '${invalidDocId}';
    ALTER TABLE question NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE question DROP CONSTRAINT question_options_not_json_string_check;
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${machineId}','${input.userId}','jsonb-string-check-proof',now(),now());
    INSERT INTO question
      (id,space_id,machine_id,revision,asked_at,question,options,withheld_fields,created_at,updated_at)
    VALUES
      ('${questionId}','${input.spaceId}','${machineId}',1,now(),'DEV-1893 repair proof',
       to_jsonb('${legacyOption}'::text),'[]'::jsonb,now(),now());
    ALTER TABLE question ADD CONSTRAINT question_options_not_json_string_check
      CHECK (jsonb_typeof(options) <> 'string') NOT VALID;
    ALTER TABLE question FORCE ROW LEVEL SECURITY;
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
}

export async function proofJsonbStringChecksValidate(
  transaction: Transaction,
  spaceId: string,
): Promise<void> {
  await transaction.exec(`SELECT set_config('app.space_id', '${spaceId}', true);`)
  const result = await transaction.query<{
    options: unknown
    relforcerowsecurity: boolean
  }>(`
    SELECT q.options,c.relforcerowsecurity
    FROM question AS q
    CROSS JOIN pg_class AS c
    WHERE q.id = '${questionId}'
      AND c.relnamespace = 'public'::regnamespace
      AND c.relname = 'question'
  `)
  await transaction.exec(`SELECT set_config('app.space_id', '', true);`)
  const expected = [{ options: [legacyOption], relforcerowsecurity: true }]
  if (JSON.stringify(result.rows) !== JSON.stringify(expected)) {
    throw new Error(`DEV-1893 jsonb string repair produced ${JSON.stringify(result.rows)}`)
  }
}
