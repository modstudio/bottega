import type { Transaction } from '@electric-sql/pglite'
import { CheckFailure } from './record-migration-failure.ts'

export const questionNumberDedupe = '20261115232855_dev_2346_question_number_dedupe'

const ids = {
  spaceA: '01990000-0000-7000-8000-000000002346',
  spaceB: '01990000-0000-7000-8000-000000002347',
  aKeeper: '01990000-0000-7000-8000-000000002349',
  aFirstLoser: '01990000-0000-7000-8000-00000000234a',
  aSecondLoser: '01990000-0000-7000-8000-00000000234b',
  aMaximum: '01990000-0000-7000-8000-00000000234c',
  aNull: '01990000-0000-7000-8000-00000000234d',
  bKeeper: '01990000-0000-7000-8000-00000000234e',
  bLoser: '01990000-0000-7000-8000-00000000234f',
  bMaximum: '01990000-0000-7000-8000-000000002350',
} as const

export async function seedQuestionNumberDedupe(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    ALTER TABLE space NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE question NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE question_number_counter NO FORCE ROW LEVEL SECURITY;
    INSERT INTO space (id,name,slug,created_at) VALUES
      ('${ids.spaceA}','DEV-2346 question number A','dev-2346-question-number-a',now()),
      ('${ids.spaceB}','DEV-2346 question number B','dev-2346-question-number-b',now());
    INSERT INTO question
      (id,number,space_id,machine_id,revision,asked_at,question,withheld_fields,created_at,updated_at)
    SELECT seeded.id,seeded.number,seeded.space_id,machine.id,1,seeded.asked_at,
      seeded.question,'[]'::jsonb,now(),now()
    FROM (VALUES
      ('${ids.aKeeper}'::uuid,7,'${ids.spaceA}'::uuid,'2026-11-15T01:00:00Z'::timestamptz,'a keeper'),
      ('${ids.aFirstLoser}'::uuid,7,'${ids.spaceA}'::uuid,'2026-11-15T02:00:00Z'::timestamptz,'a first loser'),
      ('${ids.aSecondLoser}'::uuid,7,'${ids.spaceA}'::uuid,'2026-11-15T02:00:00Z'::timestamptz,'a second loser'),
      ('${ids.aMaximum}'::uuid,20,'${ids.spaceA}'::uuid,'2026-11-15T03:00:00Z'::timestamptz,'a maximum'),
      ('${ids.aNull}'::uuid,NULL,'${ids.spaceA}'::uuid,'2026-11-15T04:00:00Z'::timestamptz,'a null'),
      ('${ids.bKeeper}'::uuid,3,'${ids.spaceB}'::uuid,'2026-11-15T01:00:00Z'::timestamptz,'b keeper'),
      ('${ids.bLoser}'::uuid,3,'${ids.spaceB}'::uuid,'2026-11-15T02:00:00Z'::timestamptz,'b loser'),
      ('${ids.bMaximum}'::uuid,9,'${ids.spaceB}'::uuid,'2026-11-15T03:00:00Z'::timestamptz,'b maximum')
    ) AS seeded(id,number,space_id,asked_at,question)
    CROSS JOIN LATERAL (SELECT id FROM machine ORDER BY id LIMIT 1) machine;
    INSERT INTO question_number_counter (space_id,next) VALUES
      ('${ids.spaceA}',31),('${ids.spaceB}',15);
    ALTER TABLE question_number_counter FORCE ROW LEVEL SECURITY;
    ALTER TABLE question FORCE ROW LEVEL SECURITY;
    ALTER TABLE space FORCE ROW LEVEL SECURITY;
  `)
}

export async function proofQuestionNumberDedupe(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    ALTER TABLE question NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE question_number_counter NO FORCE ROW LEVEL SECURITY;
  `)
  const result = await transaction.query<{
    row_count: number
    a_keeper: number
    a_first_loser: number
    a_second_loser: number
    a_null: boolean
    b_keeper: number
    b_loser: number
    distinct_numbers: number
    a_next: string
    b_next: string
  }>(`
    SELECT
      (SELECT count(*)::int FROM question WHERE space_id IN ('${ids.spaceA}','${ids.spaceB}')) row_count,
      (SELECT number FROM question WHERE id='${ids.aKeeper}') a_keeper,
      (SELECT number FROM question WHERE id='${ids.aFirstLoser}') a_first_loser,
      (SELECT number FROM question WHERE id='${ids.aSecondLoser}') a_second_loser,
      (SELECT number IS NULL FROM question WHERE id='${ids.aNull}') a_null,
      (SELECT number FROM question WHERE id='${ids.bKeeper}') b_keeper,
      (SELECT number FROM question WHERE id='${ids.bLoser}') b_loser,
      (SELECT count(DISTINCT (space_id,number))::int FROM question
        WHERE space_id IN ('${ids.spaceA}','${ids.spaceB}') AND number IS NOT NULL) distinct_numbers,
      (SELECT next::text FROM question_number_counter WHERE space_id='${ids.spaceA}') a_next,
      (SELECT next::text FROM question_number_counter WHERE space_id='${ids.spaceB}') b_next
  `)
  await transaction.exec(`
    ALTER TABLE question_number_counter FORCE ROW LEVEL SECURITY;
    ALTER TABLE question FORCE ROW LEVEL SECURITY;
  `)
  const expected = {
    row_count: 8,
    a_keeper: 7,
    a_first_loser: 31,
    a_second_loser: 32,
    a_null: true,
    b_keeper: 3,
    b_loser: 15,
    distinct_numbers: 7,
    a_next: '33',
    b_next: '16',
  }
  if (JSON.stringify(result.rows[0]) !== JSON.stringify(expected)) {
    throw new CheckFailure(
      `DEV-2346 question number dedupe produced ${JSON.stringify(result.rows[0])}`,
    )
  }
}
